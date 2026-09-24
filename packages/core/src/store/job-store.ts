/**
 * job 存储：**一个 job 一个 JSON 文件**（规格 §6.5），替代源仓库的 `drama_shoot_same_job` 表。
 *
 * 落地口径：
 * - 文件：`RETAKE_HOME/jobs/<id>.json`（完整 job，含 meta blob）
 * - 索引：`RETAKE_HOME/jobs/index.jsonl`（追加式摘要，便于人工 tail/排查；列表仍以逐文件读为准）
 * - 写：全部走 {@link writeJsonAtomic}，读永远不会看到半截 JSON
 * - 提交云任务前用 {@link JobStore.casSave} 做「带状态守卫的转移」（规格 §7.3 与 §11-4 的 CAS）
 */

import path from 'node:path';
import type { DataPaths } from '../paths.js';
import { JOB_PREPARING, JOB_RUNNING_STATUSES, type JobStatus } from '../pipeline/stages.js';
import type { JobSummary, PageReq, PageResp, PipelineMeta, ShootSameJob } from '../types.js';
import { randomUUID } from 'node:crypto';
import { listJsonFiles, readJson, withLock, writeJsonAtomic, appendJsonl } from './json-file.js';

/** CAS 守卫：只有磁盘上的 job 仍处于这些前值时才允许写入（防止交叠 tick 重复提交）。 */
export interface CasGuard {
  expectStatus?: JobStatus;
  expectStage?: string;
}

/** 状态机 blob 的初始值（规格 §4：进度全塞 meta）。 */
export function initialMeta(stage: string): PipelineMeta {
  const now = Date.now();
  return {
    stage,
    status: 'running',
    taskIds: [],
    segments: [],
    segmentIndex: 0,
    segmentTotal: 0,
    longForm: false,
    startTs: now,
    stageStartTs: now,
  };
}

export class JobStore {
  private readonly paths: DataPaths;

  constructor(paths: DataPaths) {
    this.paths = paths;
  }

  private file(id: string): string {
    return path.join(this.paths.jobs, `${safeId(id)}.json`);
  }

  private get indexFile(): string {
    return path.join(this.paths.jobs, 'index.jsonl');
  }

  /** 建 job：补齐默认字段后落盘（源：DramaShootSameService.generate 的 insert 段）。 */
  async create(seed: Partial<ShootSameJob>): Promise<ShootSameJob> {
    const now = Date.now();
    const job: ShootSameJob = {
      id: seed.id ?? randomUUID(),
      createdAt: seed.createdAt ?? now,
      updatedAt: now,
      status: seed.status ?? JOB_PREPARING,
      step: seed.step ?? '4',
      materialId: seed.materialId,
      prompt: seed.prompt,
      aspectRatio: seed.aspectRatio ?? '9:16',
      duration: seed.duration ?? 15,
      portraits: seed.portraits ?? [],
      voiceUrl: seed.voiceUrl,
      resultVideoUrl: seed.resultVideoUrl,
      errorMessage: seed.errorMessage,
      meta: seed.meta ?? initialMeta('plan'),
      snapshot: seed.snapshot,
    };
    await this.save(job);
    return job;
  }

  /** 读 job（不存在返回 null）。 */
  async get(id: string): Promise<ShootSameJob | null> {
    return readJson<ShootSameJob>(this.file(id));
  }

  /** 全量落盘（updatedAt 自动刷新）。 */
  async save(job: ShootSameJob): Promise<void> {
    job.updatedAt = Date.now();
    await writeJsonAtomic(this.file(job.id), job);
    // index.jsonl 只做摘要追加：列表页坏了也不影响 job 文件本身，可重建
    await appendJsonl(this.indexFile, {
      id: job.id,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      status: job.status,
      stage: job.meta?.stage ?? '',
      materialId: job.materialId ?? '',
      aspectRatio: job.aspectRatio,
      duration: job.duration,
      resultVideoUrl: job.resultVideoUrl ?? '',
    } satisfies JobSummaryLite).catch(() => undefined);
  }

  /**
   * 带状态守卫的写入（CAS）。
   *
   * 语义：磁盘上的 job 必须仍是 `expectStatus`（和可选的 `expectStage`），才把内存版本落盘。
   * 返回 false 表示这一轮被别人（或上一个未结束的 tick）抢先了，调用方必须**放弃本次云提交**。
   * 必须在 `withLock` 内使用，否则读写之间有窗口。
   */
  async casSave(job: ShootSameJob, guard: CasGuard): Promise<boolean> {
    const persisted = await this.get(job.id);
    if (!persisted) {
      return false;
    }
    if (guard.expectStatus && persisted.status !== guard.expectStatus) {
      return false;
    }
    if (guard.expectStage && persisted.meta?.stage !== guard.expectStage) {
      return false;
    }
    await this.save(job);
    return true;
  }

  /** 单个 job 的「读—改—写」串行执行（本地单进程下的锁）。 */
  async withJobLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    return withLock(`job:${id}`, task);
  }

  /** 分页列表（按 createdAt 倒序）。statusIn 为空表示不过滤。 */
  async list(page: PageReq, statusIn?: readonly string[]): Promise<PageResp<JobSummary>> {
    const all = await this.readAll();
    const filtered = statusIn && statusIn.length > 0 ? all.filter((job) => statusIn.includes(job.status)) : all;
    filtered.sort((a, b) => b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id)));
    const pageNo = Math.max(1, page.pageNo);
    const pageSize = Math.max(1, Math.min(page.pageSize, 100));
    const start = (pageNo - 1) * pageSize;
    return {
      total: filtered.length,
      items: filtered.slice(start, start + pageSize).map(toSummary),
    };
  }

  /** 调度器用：所有在途（preparing/generating）job。 */
  async listRunning(): Promise<ShootSameJob[]> {
    const all = await this.readAll();
    return all.filter((job) => (JOB_RUNNING_STATUSES as readonly JobStatus[]).includes(job.status));
  }

  /** 逐文件读全量 job（本地量级完全够用；量大时按规格 §6.5 换成单文件 SQLite）。 */
  private async readAll(): Promise<ShootSameJob[]> {
    const files = await listJsonFiles(this.paths.jobs);
    const out: ShootSameJob[] = [];
    for (const file of files) {
      const job = await readJson<ShootSameJob>(file);
      if (job && job.id && job.meta) {
        out.push(job);
      }
    }
    return out;
  }
}

/** index.jsonl 里的轻量摘要行（JobSummary 的子集，字段对齐便于复用）。 */
type JobSummaryLite = Omit<JobSummary, 'materialName' | 'errorMessage'>;

/** job → 列表摘要。 */
function toSummary(job: ShootSameJob): JobSummary {
  return {
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: job.status,
    stage: job.meta?.stage ?? '',
    materialId: job.materialId,
    aspectRatio: job.aspectRatio,
    duration: job.duration,
    resultVideoUrl: job.resultVideoUrl,
    errorMessage: job.errorMessage,
  };
}

/** 文件名安全：id 只允许 uuid 形态字符（防路径穿越）。 */
function safeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, '');
  if (cleaned.length === 0) {
    throw new Error('非法 job id');
  }
  return cleaned;
}
