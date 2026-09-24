/**
 * 轮询调度器（交接包规格 §8.2）。
 *
 * 三条定死的口径（沿用源项目决策，不做事件驱动改造）：
 * 1. **固定延迟轮询**：`setInterval(tick, 3000)`，与源项目 `@Scheduled` 每 3s 一致；
 * 2. **`ticking` 布尔量防重入**：本地单进程，上一轮没跑完就跳过这一轮（不排队堆积）；
 * 3. **异常绝不打崩调度器**：单个 job 出错只把它自己判失败并写 meta.error，其余 job 继续推进。
 *
 * 为什么不用「云回调」：MediaKit/方舟都是查询式任务，个人本地环境也没有公网回调地址；
 * 固定轮询还顺带天然支持「重启续跑」——job 进度都在 JSON 里，起来就接着轮询。
 */

import { advance, failJobById, tickPrepare, JOB_GENERATING, JOB_PREPARING, type Deps } from '@retake/core';

/** 默认轮询间隔（毫秒）。 */
export const TICK_INTERVAL_MS = 3000;

/** 一轮 tick 的统计（用于日志与健康检查）。 */
export interface TickStat {
  prepared: number;
  advanced: number;
  costMs: number;
}

export class Scheduler {
  private readonly deps: Deps;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  /** 防重入标记（规格 §8.2：单实例假设） */
  private ticking = false;
  private lastStat: TickStat | null = null;

  constructor(deps: Deps, intervalMs: number = TICK_INTERVAL_MS) {
    this.deps = deps;
    this.intervalMs = intervalMs;
  }

  /** 启动轮询；返回自身便于链式调用。 */
  start(): Scheduler {
    if (this.timer) {
      return this;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // unref：让「只想跑一次脚本」的使用者不被定时器挂住进程退出
    this.timer.unref?.();
    this.deps.log('info', `[scheduler] 轮询已启动，间隔 ${this.intervalMs}ms`);
    return this;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.deps.log('info', '[scheduler] 轮询已停止');
    }
  }

  /** 最近一轮统计（/api/health 回显，便于确认调度器活着）。 */
  get last(): TickStat | null {
    return this.lastStat;
  }

  /**
   * 一轮推进：素材预处理 + 出片 job。
   * 单独暴露出来，方便测试与「手工推一轮」的调试接口。
   */
  async tick(): Promise<TickStat> {
    if (this.ticking) {
      // 上一轮还在等云返回：本轮直接跳过，宁可晚 3 秒也不要交叠推进
      this.deps.log('warn', '[scheduler] 上一轮尚未结束，跳过本轮');
      return this.lastStat ?? { prepared: 0, advanced: 0, costMs: 0 };
    }
    this.ticking = true;
    const began = Date.now();
    let prepared = 0;
    let advanced = 0;
    try {
      // A. 素材「剧本还原」链（init→trim→ocr→asr→burn→drama→persist）
      prepared = await tickPrepare(this.deps);
    } catch (ex) {
      this.deps.log('error', `[scheduler] tickPrepare 异常：${(ex as Error).message}`);
    }
    try {
      // B. 出片链：只捞 script_preparing / script_generating 的 job
      const jobs = await this.deps.store.jobs.listRunning();
      for (const candidate of jobs) {
        const moved = await this.advanceOne(candidate.id);
        if (moved) {
          advanced += 1;
        }
      }
    } catch (ex) {
      this.deps.log('error', `[scheduler] 推进 job 异常：${(ex as Error).message}`);
    } finally {
      this.ticking = false;
    }
    this.lastStat = { prepared, advanced, costMs: Date.now() - began };
    if (prepared > 0 || advanced > 0) {
      this.deps.log('info', `[scheduler] tick prepared=${prepared} advanced=${advanced} cost=${this.lastStat.costMs}ms`);
    }
    return this.lastStat;
  }

  /** 推进单个 job：加锁 + 读最新 + 判失败兜底。 */
  private async advanceOne(jobId: string): Promise<boolean> {
    try {
      return await this.deps.store.jobs.withJobLock(jobId, async () => {
        const job = await this.deps.store.jobs.get(jobId);
        if (!job) {
          return false;
        }
        // 双重检查：排队期间可能已被别的路径置终态
        if (job.status !== JOB_PREPARING && job.status !== JOB_GENERATING) {
          return false;
        }
        // advance 内部会自行 store.save(job)（进度全在 job.meta 里），这里不再重复落盘
        return await advance(job, this.deps);
      });
    } catch (ex) {
      // 源：advanceJobs 的外层 catch —— 判失败并把原因写进 errorMessage，不让调度器崩
      this.deps.log('warn', `[scheduler] advance failed jobId=${jobId}: ${(ex as Error).message}`);
      await failJobById(this.deps, jobId, `生成失败：${(ex as Error).message ?? ''}`.slice(0, 400));
      return true;
    }
  }
}
