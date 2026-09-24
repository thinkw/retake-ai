/**
 * 出片 job 路由（规格 §8.1）。
 *
 * 关键约定：**POST /api/jobs 只做参数校验 + 落 job JSON（status=script_preparing）后立刻返回**，
 * 流水线由 scheduler 每 3s 推进；绝不在 HTTP 线程里等云生成（一次生成几分钟，必然超时）。
 */

import type { FastifyInstance } from 'fastify';
import {
  JOB_DONE,
  JOB_FAILED,
  JOB_GENERATING,
  JOB_LIST_STATUSES,
  JOB_PREVIEW,
  JOB_PREPARING,
  type Deps,
  type PortraitRef,
  type ShootSameJob,
  createJobFromMaterial,
  resumeJob,
  webPathOf,
} from '@retake/core';
import { field, numberField, parsePage, replyError, stringArray } from '../http-util.js';

/** 注册 job 相关路由。 */
export async function registerJobRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  /** 建 job（校验 + 冻结剧本 + 组 prompt，立即返回；流水线交给调度器推进）。 */
  app.post('/api/jobs', async (req, reply) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      const materialId = field(body, 'materialId');
      if (!materialId) {
        throw new Error('materialId 必填');
      }
      const job = await createJobFromMaterial(deps, {
        materialId,
        aspectRatio: field(body, 'aspectRatio') || undefined,
        duration: numberField(body, 'duration'),
        portraits: parsePortraits(body),
        voiceUrl: field(body, 'voiceUrl') || undefined,
        prompt: field(body, 'prompt') || undefined,
        segmentPrompts: stringArray(body, 'segmentPrompts'),
      });
      return reply.code(201).send(await toResp(deps, job));
    } catch (ex) {
      return replyError(reply, ex);
    }
  });

  /**
   * 触发生成（幂等）：
   * - 在途中 → 原样返回（不重复提交）
   * - 已失败 → 等价 resume，从第一个未完成段重跑
   * - 已完成 → 400（避免误触发重复计费）
   */
  app.post('/api/jobs/:id/generate', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const job = await requireJob(deps, id);
      if (job.status === JOB_FAILED) {
        const resumed = await resumeJob(deps, id);
        if (!resumed) {
          throw new Error(`任务不存在：${id}`);
        }
        return reply.send(await toResp(deps, resumed));
      }
      if (job.status === JOB_PREPARING || job.status === JOB_GENERATING) {
        return reply.send(await toResp(deps, job));
      }
      throw new Error(`任务已处于 ${job.status}，无需再生成；请新建一个任务`);
    } catch (ex) {
      return replyError(reply, ex);
    }
  });

  /** 失败续跑（源：resume；与 generate 的失败分支同义，单列便于前端按钮语义清晰）。 */
  app.post('/api/jobs/:id/resume', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const resumed = await resumeJob(deps, id);
      if (!resumed) {
        const notFound = new Error(`任务不存在：${id}`);
        notFound.name = 'NotFoundError';
        throw notFound;
      }
      return reply.send(await toResp(deps, resumed));
    } catch (ex) {
      return replyError(reply, ex);
    }
  });

  /** 查 job（前端轮询进度：读 status + meta.stage + errorMessage）。 */
  app.get('/api/jobs/:id', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const job = await requireJob(deps, id);
      return reply.send(await toResp(deps, job));
    } catch (ex) {
      return replyError(reply, ex);
    }
  });

  /** 分页列表。 */
  app.get('/api/jobs', async (req, reply) => {
    try {
      const query = (req.query ?? {}) as Record<string, unknown>;
      const status = field(query, 'status');
      const statusIn = status && (JOB_LIST_STATUSES as readonly string[]).includes(status) ? [status] : undefined;
      const page = await deps.store.jobs.list(parsePage(req), statusIn);
      return reply.send(page);
    } catch (ex) {
      return replyError(reply, ex);
    }
  });
}

/**
 * 解析人像入参，三种写法都收（便于命令行/curl 快速试）：
 * - `portraits: [{castId,url,source}]`（规格 §4 的标准结构）
 * - `portraits: ["asset://asset-1","asset://asset-2"]`
 * - `assetMaterials: {spokesperson:"asset://asset-1", audio:"asset://asset-a"}`（与源仓库字段同名，便于对照移植）
 */
function parsePortraits(body: Record<string, unknown> | undefined): PortraitRef[] {
  const raw = body?.['portraits'];
  if (Array.isArray(raw)) {
    const out: PortraitRef[] = [];
    for (const item of raw) {
      if (typeof item === 'string') {
        const url = item.trim();
        if (url.length > 0) {
          out.push({ castId: '', url, source: url.startsWith('asset://') ? 'asset' : 'local' });
        }
        continue;
      }
      if (item && typeof item === 'object') {
        const map = item as Record<string, unknown>;
        const url = typeof map['url'] === 'string' ? map['url'].trim() : '';
        if (url.length > 0) {
          out.push({
            castId: typeof map['castId'] === 'string' ? map['castId'] : '',
            url,
            source: url.startsWith('asset://') ? 'asset' : 'local',
          });
        }
      }
    }
    return out;
  }
  const assets = body?.['assetMaterials'];
  if (assets && typeof assets === 'object') {
    const out: PortraitRef[] = [];
    for (const [slot, value] of Object.entries(assets as Record<string, unknown>)) {
      if (slot === 'audio' || typeof value !== 'string') {
        continue;
      }
      const url = value.trim();
      if (url.length > 0) {
        out.push({ castId: slot, url, source: url.startsWith('asset://') ? 'asset' : 'local' });
      }
    }
    return out;
  }
  return [];
}

/** 取 job，不存在抛 NotFoundError。 */
async function requireJob(deps: Deps, id: string): Promise<ShootSameJob> {
  const job = await deps.store.jobs.get(id);
  if (!job) {
    const notFound = new Error(`任务不存在：${id}`);
    notFound.name = 'NotFoundError';
    throw notFound;
  }
  return job;
}

/** job 响应体（含各段 prompt，便于用户在 CLI/页面上直接看到要提交什么）。 */
async function toResp(deps: Deps, job: ShootSameJob): Promise<Record<string, unknown>> {
  const material = job.materialId ? await deps.store.materials.get(job.materialId) : null;
  const meta = job.meta ?? {};
  const segments = Array.isArray(meta.segments) ? meta.segments : [];
  const resultLocal = job.resultVideoUrl ?? '';
  return {
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: job.status,
    stage: String(meta.stage ?? ''),
    step: job.step,
    materialId: job.materialId ?? '',
    materialName: material?.name ?? '未命名素材',
    materialUrl: material?.url ?? '',
    aspectRatio: job.aspectRatio,
    duration: job.duration,
    portraits: job.portraits,
    voiceUrl: job.voiceUrl ?? '',
    prompt: job.prompt ?? '',
    resultVideoUrl: resultLocal,
    // 本地成片走 /files/... 静态挂载，浏览器可直接预览
    previewUrl: webPathOf(deps.config.paths, resultLocal),
    errorMessage: job.errorMessage ?? '',
    done: job.status === JOB_DONE || job.status === JOB_PREVIEW,
    failed: job.status === JOB_FAILED,
    elapsedMs: meta.elapsedMs ?? (typeof meta.startTs === 'number' ? Date.now() - meta.startTs : 0),
    meta: {
      stage: meta.stage,
      status: meta.status,
      generateMode: meta.generateMode,
      promptVersion: meta.promptVersion,
      aspectRatio: meta.aspectRatio,
      durationD: meta.durationD,
      targetDurationSec: meta.targetDurationSec,
      longForm: meta.longForm,
      scriptPath: meta.scriptPath,
      sourceUrl: meta.sourceUrl,
      outputUrl: meta.outputUrl,
      taskIds: meta.taskIds ?? [],
      error: meta.error,
    },
    segments: segments.map((seg) => ({
      index: seg.index,
      start: seg.start,
      end: seg.end,
      duration: seg.duration,
      status: seg.status,
      needLastFrame: seg.needLastFrame,
      sceneGroupId: seg.sceneGroupId,
      videoTaskId: seg.videoTaskId ?? '',
      videoUrl: seg.videoUrl ?? '',
      prompt: seg.prompt ?? '',
      promptLength: seg.promptLength ?? (seg.prompt ? String(seg.prompt).length : 0),
      promptMax: seg.promptMax,
      promptCompressed: seg.promptCompressed === true,
    })),
  };
}
