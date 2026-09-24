/**
 * 出片生成主状态机（规格 §7；源 `service/btob/drama/DramaShootSameService.java`）。
 *
 * 推进语义（**最关键的一条**）：每个 tick 只把在途 job 往前推 **ONE** 步然后 return，
 * 绝不在 HTTP 线程或调度循环里 sleep 等云 —— 云端一次生成要几分钟，阻塞式写法会把整个服务拖死。
 *
 * 阶段链：`plan → video_seg →（多段时）concat → done`；v1 单段时 concat 直接短路成 finishJob（与源一致）。
 *
 * 状态口径（规格 §7.1，取值全部带 `script_` 前缀）：
 * `script_preparing → script_generating → script_preview → script_done`；失败 `script_failed`。
 * 其中 **preview / done 的区分是本地版新增**：源实现停在 `script_preview`（产物已落存储即视为可预览），
 * 本地版多加一次「ffprobe 校验本机文件」才升 `script_done`，避免把「下载了一半的 mp4」报成完成。
 */

import type { Deps } from '../deps.js';
import { MAX_SEGMENT_SECONDS, MIN_SEGMENT_SECONDS, MAX_TOTAL_SECONDS } from '../planner/limits.js';
import { planSingle, toSegMaps } from '../planner/segment-planner.js';
import { listSpokespersonAssets, portraitSlotLimit, seedanceSafeFirstFrameUrl, toAssetSlots } from '../cast/cast.js';
import { buildSubmit } from '../prompt/seedance-prompt.js';
import { compressSegments } from '../prompt/prompt-length-compressor.js';
import { fillAutoPrompts, resolveSubmitPrompt } from '../prompt/segment-prompt-assembler.js';
import { fromAnalysis, normalizeAspect } from '../script/aspect-ratio.js';
import type { JobSummary, PipelineMeta, PortraitRef, SegmentMeta, ShootSameJob } from '../types.js';
import { initialMeta } from '../store/job-store.js';
import { bool, listOfMaps, num, str } from '../util/maps.js';
import { isBlank, isNotBlank, maxLength } from '../util/text.js';
import {
  ANALYZE_READY,
  BUSINESS_TYPE,
  JOB_DONE,
  JOB_FAILED,
  JOB_GENERATING,
  JOB_PREPARING,
  JOB_PREVIEW,
  JOB_STAGE_CONCAT,
  JOB_STAGE_DONE,
  JOB_STAGE_PLAN,
  JOB_STAGE_VIDEO,
} from './stages.js';
import { GENERATE_MODE_SHOT_TRANSCRIPT, PROMPT_VERSION } from '../prompt/understand-prompt.js';

/** 单段生成超时：30 分钟（源：SEGMENT_VIDEO_TIMEOUT_MS）。 */
export const SEGMENT_VIDEO_TIMEOUT_MS = 30 * 60_000;
/** 拼接超时：10 分钟（源：CONCAT_TIMEOUT_MS）。 */
export const CONCAT_TIMEOUT_MS = 10 * 60_000;
/** 产物转存子目录（与源仓库 TOS 目录同名，便于对照）。 */
const ARTIFACT_SUBDIR = 'btob/brand-shoot-same-drama';

/** 建 job 的入参（规格 §8.1：materialId、aspectRatio、duration、portraits、voiceUrl）。 */
export interface CreateJobReq {
  materialId: string;
  aspectRatio?: string;
  duration?: number;
  portraits: PortraitRef[];
  voiceUrl?: string;
  prompt?: string;
  /** 用户逐段改写的 prompt（v1 单段时长度为 1） */
  segmentPrompts?: string[];
}

/**
 * 校验 + 冻结剧本 + 组装 prompt，最后落一个 `script_preparing` 的 job（源：generate 的 insert 段）。
 *
 * 这里做的是「一次性」的编排工作（规划、组 prompt、压缩），因此放在 HTTP 请求里同步执行是可接受的；
 * 真正的慢操作（云生成/轮询）全部交给 {@link advance} 推进。
 */
export async function createJobFromMaterial(deps: Deps, req: CreateJobReq): Promise<ShootSameJob> {
  const material = await deps.store.materials.get(req.materialId);
  if (!material) {
    throw new Error(`素材不存在：${req.materialId}`);
  }
  // 源：requireScriptReady —— 剧本没还原好就不许建 job（script_ready 是唯一放行态）
  if (material.analyzeStatus !== ANALYZE_READY) {
    const err = material.analyzeError ? `（${material.analyzeError}）` : '';
    throw new Error(`素材剧本尚未就绪，请先完成剧本还原${err}`);
  }
  const analysis = { ...material.analysis };
  const assets = toAssetSlots(req.portraits, req.voiceUrl);
  const portraits = listSpokespersonAssets(assets);
  if (portraits.length === 0) {
    throw new Error('请至少选择 1 张已审核人像（asset:// 人像库地址）');
  }
  const durationSec = num(analysis, 'durationSec', material.duration ?? 0);
  const portraitMax = portraitSlotLimit(analysis, durationSec > 0 ? durationSec : MAX_SEGMENT_SECONDS);
  if (portraits.length > portraitMax) {
    throw new Error(`人像张数超过当前剧本角色数（最多 ${portraitMax} 张，当前 ${portraits.length} 张）`);
  }
  if (durationSec < MIN_SEGMENT_SECONDS) {
    throw new Error('成片过短，无法生成');
  }
  if (durationSec > MAX_TOTAL_SECONDS + 0.5) {
    throw new Error(`素材时长超出上限（≤${MAX_TOTAL_SECONDS} 秒）`);
  }
  // v1：整片一段（长视频分段链式生成留接口，见 planner/segment-planner.ts）
  const plan = planSingle(durationSec, MAX_SEGMENT_SECONDS);
  if (plan.error.length > 0) {
    throw new Error(plan.error);
  }
  const segs = toSegMaps(plan.segments);
  const aspect = pickAspect(req.aspectRatio, analysis);
  const hasAudio = isNotBlank(assets['audio'] ?? '') && (assets['audio'] as string).startsWith('asset://');
  fillAutoPrompts(analysis, segs, portraits.length, hasAudio);
  await compressSegments(analysis, segs, portraits.length, hasAudio, deps.chat);
  // 用户在预览页改过的 prompt 覆盖自动生成的（源：applyOverrides；v1 只有 1 段，仍按数组校验段数一致）
  if (req.segmentPrompts && req.segmentPrompts.length > 0) {
    if (req.segmentPrompts.length !== segs.length) {
      throw new Error(`提示词段数与规划不一致（规划 ${segs.length} 段，提交 ${req.segmentPrompts.length} 段），请重新预览后再生成`);
    }
    segs.forEach((seg, i) => {
      const raw = (req.segmentPrompts?.[i] ?? '').trim();
      if (isNotBlank(raw)) {
        seg['promptOverride'] = raw;
      }
    });
  }
  const now = deps.now();
  const meta: PipelineMeta = {
    ...initialMeta(JOB_STAGE_PLAN),
    sourceUrl: material.url,
    scriptPath: material.scriptPath,
    durationD: durationSec,
    longForm: false,
    targetDurationSec: Math.round(durationSec),
    segmentTargetSeconds: MAX_SEGMENT_SECONDS,
    generateMode: GENERATE_MODE_SHOT_TRANSCRIPT,
    promptVersion: PROMPT_VERSION,
    aspectRatio: aspect,
    segments: segs.map(toMetaSegment),
    taskIds: [],
    startTs: now,
    stageStartTs: now,
  };
  const job: ShootSameJob = {
    id: '',
    createdAt: now,
    updatedAt: now,
    status: JOB_PREPARING,
    step: '4',
    materialId: material.id,
    prompt: req.prompt,
    aspectRatio: aspect as ShootSameJob['aspectRatio'],
    duration: num(segs[0] ?? {}, 'duration', Math.round(durationSec)),
    portraits: req.portraits,
    voiceUrl: req.voiceUrl,
    meta,
    snapshot: {
      analysis,
      segments: segs,
      aspectRatio: aspect,
      hardSubtitle: analysis['hardSubtitle'],
      asrBurned: analysis['asrBurned'],
      segmentMaxSeconds: MAX_SEGMENT_SECONDS,
      scriptSourceUrl: str(analysis, 'scriptSourceUrl'),
      scriptArchiveUrl: str(analysis, 'scriptArchiveUrl'),
      userPromptOverride: Boolean(req.segmentPrompts && req.segmentPrompts.length > 0),
    },
  };
  const created = await deps.store.jobs.create(job);
  deps.log(
    'info',
    `[drama-generate] create job=${created.id} material=${material.id} segs=${segs.length} duration=${created.duration}s business=${BUSINESS_TYPE}`,
  );
  return created;
}

/**
 * 推进一个 job（规格 §7.3 的 `advance`）。
 *
 * @returns 本轮是否发生状态推进（true 表示调度器可以打点/记日志；不代表已完成）
 */
export async function advance(job: ShootSameJob, deps: Deps): Promise<boolean> {
  const meta = { ...(job.meta ?? initialMeta(JOB_STAGE_PLAN)) } as PipelineMeta;
  const stage = isNotBlank(meta.stage) ? meta.stage : JOB_STAGE_PLAN;
  const now = deps.now();
  switch (stage) {
    case JOB_STAGE_PLAN:
      return submitVideo(job, meta, 0, deps, now);
    case JOB_STAGE_VIDEO:
      return pollVideo(job, meta, deps, now);
    case JOB_STAGE_CONCAT:
      return pollConcat(job, meta, deps, now);
    case JOB_STAGE_DONE:
      return false;
    default:
      await failJob(job, `未知生成阶段：${stage}`, deps);
      return true;
  }
}

/** 提交第 idx 段（v1 只有第 0 段）。返回 true 表示本轮已推进（含「跳过已完成段」）。 */
async function submitVideo(
  job: ShootSameJob,
  meta: PipelineMeta,
  idx: number,
  deps: Deps,
  now: number,
): Promise<boolean> {
  const segs = listOfMaps(meta.segments ?? []);
  if (segs.length === 0 && job.snapshot?.segments) {
    segs.push(...listOfMaps(job.snapshot.segments));
    meta.segments = segs.map(toMetaSegment);
  }
  if (idx >= segs.length) {
    return submitConcat(job, meta, deps, now);
  }
  const seg = segs[idx] as Record<string, unknown>;
  if (str(seg, 'status') === 'done' && isNotBlank(str(seg, 'videoUrl'))) {
    return submitVideo(job, meta, idx + 1, deps, now);
  }
  const analysis = snapshotAnalysis(job);
  const start = num(seg, 'start', 0);
  const end = num(seg, 'end', start + 4);
  const duration = Math.max(
    MIN_SEGMENT_SECONDS,
    Math.min(num(seg, 'duration', Math.round(end - start)), MAX_SEGMENT_SECONDS),
  );
  const assets = toAssetSlots(job.portraits, job.voiceUrl);
  const portraits = listSpokespersonAssets(assets);
  const needLast = bool(seg, 'needLastFrame');
  // 同场续段才用上一段尾帧；v1 单段 needLast 恒 false
  let firstFrame = '';
  if (needLast && idx > 0) {
    firstFrame = seedanceSafeFirstFrameUrl(str(segs[idx - 1] as Record<string, unknown>, 'lastFrameUrl'));
  }
  let audio = str(assets, 'audio');
  if (!audio.startsWith('asset://')) {
    // drama 链路音色只吃 asset://（源：非 asset 直接置空，不阻塞出片）
    audio = '';
  }
  const prompt = resolveSubmitPrompt(analysis, seg, idx, segs.length, portraits.length, isNotBlank(firstFrame), isNotBlank(audio));
  const aspect = isNotBlank(meta.aspectRatio) ? (meta.aspectRatio as string) : fromAnalysis(analysis);
  // ⚠️ drama 新版：**不传 reference_video**，只带剧本 prompt + 人像 + 音色（规格 §6.2 / §7.3-4）
  const submitReq = buildSubmit(prompt, duration, aspect, firstFrame, portraits, audio);

  // —— 提交前 CAS（规格 §11-4）：磁盘上必须仍是本次读到的「状态 + 阶段」才允许提交，
  //    防止交叠 tick / 双实例重复下单（源项目靠 Redisson 锁 + 带守卫的 UPDATE）——
  const stage = isNotBlank(meta.stage) ? meta.stage : JOB_STAGE_PLAN;
  job.meta = { ...meta, stage, segments: segs.map(toMetaSegment), segmentIndex: idx, segmentTotal: segs.length };
  const expectStatus = job.status;
  const casOk = await deps.store.jobs.withJobLock(job.id, async () => {
    const guarded: ShootSameJob = { ...job, meta: { ...job.meta, stage } };
    return deps.store.jobs.casSave(guarded, { expectStatus, expectStage: stage });
  });
  if (!casOk) {
    deps.log('warn', `[drama-generate] job=${job.id} CAS 未命中（已被其它 tick 推进），本轮放弃提交`);
    return false;
  }
  let taskId: string;
  try {
    const submitted = await deps.seedance.submit(submitReq);
    taskId = submitted.taskId;
  } catch (ex) {
    await failJob(job, `提交生成失败：${maxLength((ex as Error).message, 300)}`, deps);
    return true;
  }
  seg['videoTaskId'] = taskId;
  seg['status'] = 'generating';
  seg['prompt'] = prompt;
  segs[idx] = seg;
  meta.segments = segs.map(toMetaSegment);
  meta.stage = JOB_STAGE_VIDEO;
  meta.segmentIndex = idx;
  meta.segmentTotal = segs.length;
  meta.stageStartTs = now;
  meta.videoTaskId = taskId;
  meta.taskIds = [...(meta.taskIds ?? []), taskId];
  meta.assetMaterials = assets;
  meta.status = 'running';
  meta.error = undefined;
  job.meta = meta;
  job.status = JOB_GENERATING;
  job.errorMessage = undefined;
  await deps.store.jobs.save(job);
  deps.log(
    'info',
    `[drama-generate] job=${job.id} submit seg ${idx + 1}/${segs.length} task=${taskId} firstFrame=${isNotBlank(firstFrame)} audio=${isNotBlank(audio)}`,
  );
  return true;
}

/** 轮询当前段（源：pollVideo）。 */
async function pollVideo(job: ShootSameJob, meta: PipelineMeta, deps: Deps, now: number): Promise<boolean> {
  const segs = listOfMaps(meta.segments ?? []);
  const idx = meta.segmentIndex ?? 0;
  if (idx < 0 || idx >= segs.length) {
    await failJob(job, '分段下标无效', deps);
    return true;
  }
  const seg = segs[idx] as Record<string, unknown>;
  const videoTaskId = str(seg, 'videoTaskId');
  if (isBlank(videoTaskId)) {
    return submitVideo(job, meta, idx, deps, now);
  }
  const task = await deps.seedance.query(videoTaskId);
  if (task.status === 'succeeded') {
    const url = task.videoUrls[0] ?? '';
    if (isBlank(url)) {
      await failJob(job, '生成完成但未返回视频地址', deps);
      return true;
    }
    seg['videoUrl'] = url;
    if (isNotBlank(task.lastFrameUrl)) {
      seg['lastFrameUrl'] = task.lastFrameUrl;
    }
    seg['status'] = 'done';
    segs[idx] = seg;
    meta.segments = segs.map(toMetaSegment);
    job.meta = meta;
    await deps.store.jobs.save(job);
    if (idx + 1 >= segs.length) {
      return submitConcat(job, meta, deps, now);
    }
    return submitVideo(job, meta, idx + 1, deps, now);
  }
  if (task.status === 'failed') {
    await failJob(
      job,
      `第 ${idx + 1}/${segs.length} 段生成失败：${isNotBlank(task.error) ? task.error : '未知原因'}`,
      deps,
    );
    return true;
  }
  const stageStart = meta.stageStartTs ?? now;
  if (now - stageStart > SEGMENT_VIDEO_TIMEOUT_MS) {
    await failJob(job, `第 ${idx + 1} 段生成超时（>${SEGMENT_VIDEO_TIMEOUT_MS / 60000} 分钟）`, deps);
    return true;
  }
  return false;
}

/** 提交拼接（源：submitConcat：只有一段时直接完成，不走 concat-video）。 */
async function submitConcat(job: ShootSameJob, meta: PipelineMeta, deps: Deps, now: number): Promise<boolean> {
  const segs = listOfMaps(meta.segments ?? []);
  const urls: string[] = [];
  for (const seg of segs) {
    const url = str(seg, 'videoUrl');
    if (isBlank(url)) {
      await failJob(job, '拼接缺少成片段', deps);
      return true;
    }
    urls.push(url);
  }
  if (urls.length <= 1) {
    return finishJob(job, meta, urls[0] ?? '', deps, now);
  }
  const taskId = await deps.mediakit.submitConcatVideo(urls);
  meta.stage = JOB_STAGE_CONCAT;
  meta.concatTaskId = taskId;
  meta.taskIds = [...(meta.taskIds ?? []), taskId];
  meta.stageStartTs = now;
  job.meta = meta;
  job.status = JOB_GENERATING;
  await deps.store.jobs.save(job);
  deps.log('info', `[drama-generate] job=${job.id} concat taskId=${taskId} parts=${urls.length}`);
  return true;
}

/** 轮询拼接（源：pollConcat）。 */
async function pollConcat(job: ShootSameJob, meta: PipelineMeta, deps: Deps, now: number): Promise<boolean> {
  const concatTaskId = meta.concatTaskId ?? '';
  if (isBlank(concatTaskId)) {
    return submitConcat(job, meta, deps, now);
  }
  const task = await deps.mediakit.queryToolTask(concatTaskId);
  const status = task.status;
  if (isToolCompleted(status)) {
    const concatUrl = task.videoUrl ?? '';
    if (isBlank(concatUrl)) {
      await failJob(job, '拼接未返回视频（各段已生成，可重跑）', deps);
      return true;
    }
    return finishJob(job, meta, concatUrl, deps, now);
  }
  const stageStart = meta.stageStartTs ?? now;
  if (isToolFailed(status) || now - stageStart > CONCAT_TIMEOUT_MS) {
    await failJob(job, `分段拼接失败：${task.error ?? status}`, deps);
    return true;
  }
  return false;
}

/**
 * 收尾（源：finishJob）。
 * 本地版差异：源里转存到 TOS 后就置 `script_preview`；这里额外用 ffprobe 校验本地产物，
 * 通过才升 `script_done`（规格 §10 验收口径），校验失败仍保留 preview + errorMessage 说明。
 */
async function finishJob(
  job: ShootSameJob,
  meta: PipelineMeta,
  videoUrl: string,
  deps: Deps,
  now: number,
): Promise<boolean> {
  let permanent: string;
  try {
    // 成片**必须**落本机：方舟链 24h 过期，不能只存一个远端 URL（规格 §6.3）
    permanent = await deps.artifact.persistLocal(videoUrl, ARTIFACT_SUBDIR, `drama_final_${job.id}`);
  } catch (ex) {
    await failJob(job, `成片转存失败：${maxLength((ex as Error).message, 300)}`, deps);
    return true;
  }
  meta.stage = JOB_STAGE_DONE;
  meta.outputUrl = permanent;
  meta.remoteResultUrl = videoUrl;
  meta.elapsedMs = now - (meta.startTs ?? now);
  meta.status = 'ok';
  job.resultVideoUrl = permanent;
  job.meta = meta;
  job.status = JOB_PREVIEW;
  job.errorMessage = undefined;
  await deps.store.jobs.save(job);
  deps.log('info', `[drama-generate] job=${job.id} preview url=${permanent}`);

  // 本地产物校验：能探测出正时长才算真正 done；探测不到（如未配 TOS 导致拿到远端链）保持 preview
  try {
    const info = await deps.ffmpeg.probe(permanent);
    if (info.durationSec > 0) {
      job.status = JOB_DONE;
      job.meta = { ...job.meta, durationD: info.durationSec };
      await deps.store.jobs.save(job);
      deps.log('info', `[drama-generate] job=${job.id} done probe=${info.durationSec.toFixed(1)}s`);
    }
  } catch (ex) {
    deps.log('warn', `[drama-generate] job=${job.id} probe final failed: ${(ex as Error).message}`);
  }
  return true;
}

/** 失败落盘（源：failJob：状态 + 截断后的错误信息）。 */
async function failJob(job: ShootSameJob, message: string, deps: Deps): Promise<void> {
  job.status = JOB_FAILED;
  job.errorMessage = maxLength(message, 1024);
  job.meta = { ...job.meta, status: 'failed', error: maxLength(message, 1024) };
  await deps.store.jobs.save(job);
  deps.log('warn', `[drama-generate] job=${job.id} script_failed: ${message}`);
}

/**
 * 按 id 判失败（供调度器在 `advance` 抛异常时兜底，源：advanceJobs 的外层 catch）。
 * 重新从磁盘读一次再写，避免用内存里的旧版本覆盖已推进的进度。
 */
export async function failJobById(deps: Deps, jobId: string, message: string): Promise<void> {
  await deps.store.jobs.withJobLock(jobId, async () => {
    const job = await deps.store.jobs.get(jobId);
    if (!job) {
      return;
    }
    await failJob(job, maxLength(message, 1024), deps);
  });
}

/** 失败/超时后续跑：把第一个未完成段所在阶段重置，重新交给调度器（源：resume，v1 单段实现最小版）。 */
export async function resumeJob(deps: Deps, jobId: string): Promise<ShootSameJob | null> {
  return deps.store.jobs.withJobLock(jobId, async () => {
    const job = await deps.store.jobs.get(jobId);
    if (!job) {
      return null;
    }
    if (job.status !== JOB_FAILED) {
      throw new Error('仅失败任务可续跑');
    }
    const meta = { ...(job.meta ?? initialMeta(JOB_STAGE_PLAN)) } as PipelineMeta;
    const segs = listOfMaps(meta.segments ?? job.snapshot?.segments ?? []);
    if (segs.length === 0) {
      throw new Error('没有可续跑的分段信息');
    }
    let idx = -1;
    segs.forEach((seg, i) => {
      if (idx < 0 && (str(seg, 'status') !== 'done' || isBlank(str(seg, 'videoUrl')))) {
        idx = i;
      }
    });
    if (idx < 0) {
      // 所有段都已出片：只差拼接，直接进 concat 阶段重跑
      meta.stage = JOB_STAGE_CONCAT;
      meta.concatTaskId = '';
    } else {
      // 该段清掉在途标记，回到 plan 阶段重新提交（submitVideo 会从 segmentIndex 处接着做）
      const seg = segs[idx] as Record<string, unknown>;
      seg['status'] = 'pending';
      seg['videoTaskId'] = '';
      meta.stage = JOB_STAGE_PLAN;
      meta.segmentIndex = idx;
    }
    meta.segments = segs.map(toMetaSegment);
    meta.stageStartTs = deps.now();
    meta.status = 'running';
    meta.error = undefined;
    job.status = JOB_PREPARING;
    job.errorMessage = undefined;
    job.meta = meta;
    await deps.store.jobs.save(job);
    return job;
  });
}

/** 摘要（列表页用；源：toListItem）。 */
export function toJobSummary(job: ShootSameJob, materialName?: string): JobSummary {
  return {
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: job.status,
    stage: job.meta?.stage ?? '',
    materialId: job.materialId,
    materialName: materialName ?? '未命名素材',
    aspectRatio: job.aspectRatio,
    duration: job.duration,
    resultVideoUrl: job.resultVideoUrl,
    errorMessage: job.errorMessage,
  };
}

/** meta.segments 元素类型收敛（松散 Map → SegmentMeta；保留未知字段以便 phase 2 向前兼容）。 */
function toMetaSegment(input: Record<string, unknown>): SegmentMeta {
  return input as unknown as SegmentMeta;
}

/** 快照里的 analysis（源：snapshotAnalysis）。 */
function snapshotAnalysis(job: ShootSameJob): Record<string, unknown> {
  const analysis = job.snapshot?.analysis;
  return analysis && typeof analysis === 'object' ? analysis : {};
}

/** 画幅：用户显式传的合法值优先，否则跟原片（源：DramaAspectRatio.fromAnalysis）。 */
function pickAspect(requested: string | undefined, analysis: Record<string, unknown>): string {
  const normalized = normalizeAspect(requested ?? '');
  if (isNotBlank(normalized)) {
    return normalized;
  }
  return fromAnalysis(analysis);
}

function isToolCompleted(status: string): boolean {
  const s = status.toLowerCase();
  return s === 'completed' || s === 'succeeded' || s === 'success';
}

function isToolFailed(status: string): boolean {
  const s = status.toLowerCase();
  return s === 'failed' || s === 'cancelled' || s === 'canceled';
}
