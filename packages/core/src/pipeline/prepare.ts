/**
 * 素材「剧本还原」预处理状态机（规格 §7.2-A；源 `service/btob/drama/DramaScriptPrepareService.java`）。
 *
 * 阶段流转：`init → trim（可选裁片尾）→ ocr（判硬字幕）→ asr（无硬字幕才做）→ burn（有 ASR 无字幕时烧录）
 *            → drama（drama-script 还原剧本，result_url 24h → 转存）→ persist（落本地剧本）`
 *
 * 三条源项目定死的规则，这里逐条保留：
 * 1. **失败只落到 `script_failed`，绝不改回 pending**（避免调度器无限重跑，也避免用户以为还在排队）；
 * 2. **OCR 失败/超时不阻断**：判不出硬字幕就退化成「按无硬字幕处理」继续走 ASR（源：pollOcr 的 else 分支）；
 * 3. **drama 失败最多自愈一次**：有硬字幕但 drama 失败时，补一遍 ASR+烧录再 drama，第二次仍失败才落 failed。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ADD_SUBTITLE, DRAMA_SCRIPT, TRIM_VIDEO, VIDEO_OCR } from '../adapters/mediakit-paths.js';
import { MAX_TOTAL_SECONDS } from '../planner/limits.js';
import type { Deps } from '../deps.js';
import type { Material } from '../types.js';
import { listOfMaps, num, str } from '../util/maps.js';
import { isBlank, isNotBlank, maxLength, trim } from '../util/text.js';
import { fromScript } from '../script/aspect-ratio.js';
import { parseArchive } from '../script/archive-parser.js';
import { hasHardSubtitles, hasSpokenContent } from '../script/ocr-heuristic.js';
import { toAnalysis } from '../script/script-mapper.js';
import {
  ANALYZE_FAILED,
  ANALYZE_PENDING,
  ANALYZE_READY,
  ANALYZE_RUNNING,
  META_ORIGINAL_URL,
  META_TAIL_TRIM_RESOLVED,
  PIPELINE,
  SANITIZE_SKIPPED,
  STAGE_ASR,
  STAGE_BURN,
  STAGE_DRAMA,
  STAGE_INIT,
  STAGE_OCR,
  STAGE_PERSIST,
  STAGE_TRIM,
  failHint,
  isTailTrimResolved,
  shouldTrimTail,
} from './stages.js';

/** 同时处理的素材数上限（源：MAX_RUNNING=3；本地版沿用，避免把用户账号 QPS 打满）。 */
export const PREPARE_MAX_RUNNING = 3;
/** 单阶段超时：10 分钟（源：STAGE_TIMEOUT_MS）。 */
export const STAGE_TIMEOUT_MS = 10 * 60_000;
/** drama-script 超时：30 分钟（源：DRAMA_TIMEOUT_MS）。 */
export const DRAMA_TIMEOUT_MS = 30 * 60_000;
/** 在途兜底超时：40 分钟（源：recoverStale 的 minusMinutes(40)）。 */
export const STALE_TIMEOUT_MS = 40 * 60_000;
/** 素材时长上限（源：MAX_MATERIAL_SECONDS = MAX_TOTAL_SECONDS = 60）。 */
export const MAX_MATERIAL_SECONDS = MAX_TOTAL_SECONDS;
/** 产物转存的子目录名（源用 `btob/brand-shoot-same-drama`，本地版沿用便于对照）。 */
const ARTIFACT_SUBDIR = 'btob/brand-shoot-same-drama';

/**
 * 一次 tick：回收超时 → 推进在途 → 领取新任务（顺序与源实现一致）。
 *
 * @returns 本轮发生状态变化的素材数（调度器据此打点）
 */
export async function tickPrepare(deps: Deps): Promise<number> {
  let moved = 0;
  moved += await recoverStale(deps);
  moved += await advanceRunning(deps);
  moved += await claimPending(deps);
  return moved;
}

/** 把 40 分钟还挂在 running 的素材判失败（源：recoverStale）。 */
async function recoverStale(deps: Deps): Promise<number> {
  const running = await deps.store.materials.byStatus(ANALYZE_RUNNING);
  const now = deps.now();
  let n = 0;
  for (const material of running) {
    const started = material.analyzeStartedAt ?? 0;
    if (started > 0 && now - started > STALE_TIMEOUT_MS) {
      await fail(deps, material.id, `剧本还原超时（>40分钟）`);
      n++;
    }
  }
  return n;
}

/** 推进所有在途素材一个阶段（源：advanceRunning）。 */
async function advanceRunning(deps: Deps): Promise<number> {
  const running = await deps.store.materials.byStatus(ANALYZE_RUNNING);
  let n = 0;
  for (const material of running) {
    try {
      const moved = await deps.store.materials.withMaterialLock(material.id, async () => {
        const fresh = await deps.store.materials.get(material.id);
        if (!fresh || fresh.analyzeStatus !== ANALYZE_RUNNING) {
          return false;
        }
        return advance(deps, fresh);
      });
      if (moved) {
        n++;
      }
    } catch (ex) {
      // 源：withTenant 的 catch —— 任何异常都落到 script_failed，绝不让调度器崩
      deps.log('warn', `[drama-prepare] id=${material.id} failed: ${(ex as Error).message}`);
      await fail(deps, material.id, maxLength((ex as Error).message || '剧本还原失败', 400));
      n++;
    }
  }
  return n;
}

/** 领取 pending（带并发额度）并启动流水线（源：claimPending + casClaim）。 */
async function claimPending(deps: Deps): Promise<number> {
  const running = await deps.store.materials.byStatus(ANALYZE_RUNNING);
  if (PREPARE_MAX_RUNNING - running.length <= 0) {
    return 0;
  }
  const pending = await deps.store.materials.byStatus(ANALYZE_PENDING);
  pending.sort((a, b) => a.createdAt - b.createdAt);
  let started = 0;
  for (const material of pending) {
    if (started >= PREPARE_MAX_RUNNING - running.length) {
      break;
    }
    const claimed = await deps.store.materials.casClaim(material.id);
    // 没抢到（已被其他轮推走）不占用并发额度，下一轮再试
    if (!claimed) {
      continue;
    }
    started += 1;
    // 云端工具只吃公网 URL：本地上传件必须先把 url 补全（配 TOS 或自行托管），否则直接给出可执行失败原因
    if (isBlank(claimed.url)) {
      await fail(deps, material.id, '素材没有公网可访问地址（url 为空）');
      continue;
    }
    try {
      await startPipeline(deps, claimed);
    } catch (ex) {
      deps.log('warn', `[drama-prepare] start id=${material.id} failed: ${(ex as Error).message}`);
      await fail(deps, material.id, maxLength((ex as Error).message || '剧本还原启动失败', 400));
    }
  }
  return started;
}

/** 手工重跑（源：retryScript）：保留原片地址与「已裁片尾」标记，其余进度清空。 */
export async function retryScript(deps: Deps, id: string): Promise<Material | null> {
  return deps.store.materials.withMaterialLock(id, async () => {
    const material = await deps.store.materials.get(id);
    if (!material) {
      return null;
    }
    if (material.analyzeStatus === ANALYZE_RUNNING) {
      throw new Error('该素材正在剧本还原中，请等待完成');
    }
    const preserved: Record<string, unknown> = {};
    const original = material.analysis?.[META_ORIGINAL_URL];
    if (original !== null && original !== undefined && isNotBlank(String(original))) {
      preserved[META_ORIGINAL_URL] = original;
    }
    if (isTailTrimResolved(material.analysis)) {
      preserved[META_TAIL_TRIM_RESOLVED] = true;
    }
    preserved['pipeline'] = PIPELINE;
    material.analysis = preserved;
    material.analyzeStatus = ANALYZE_PENDING;
    material.sanitizeStatus = SANITIZE_SKIPPED;
    material.analyzeError = undefined;
    material.analyzeStartedAt = undefined;
    await deps.store.materials.save(material);
    return material;
  });
}

/** 流水线起点（源：startPipeline）：探测时长 → 决定要不要先裁片尾，否则直接进 OCR。 */
export async function startPipeline(deps: Deps, material: Material): Promise<void> {
  const analysis = { ...material.analysis };
  analysis['pipeline'] = PIPELINE;
  const sourceUrl = deps.artifact.toConsumableUrl(material.url, `素材 ${material.id} 原片`);
  const probed = await deps.ffmpeg.probeDurationSec(sourceUrl);
  if (probed > 0 && probed > MAX_MATERIAL_SECONDS + 0.5) {
    await fail(deps, material.id, `视频时长 ${Math.round(probed)} 秒，超出支持上限（≤${MAX_MATERIAL_SECONDS} 秒）`);
    return;
  }
  if (probed > 0) {
    analysis['durationSec'] = probed;
    material.duration = Math.round(probed);
  }
  const trimTail = material.trimTailSeconds ?? 0;
  if (shouldTrimTail(trimTail, probed > 0 ? probed : undefined) && !isTailTrimResolved(analysis)) {
    const end = probed - trimTail;
    const taskId = await deps.mediakit.submitToolTask(TRIM_VIDEO, {
      video_url: sourceUrl,
      start_time: 0,
      end_time: end,
    });
    analysis[META_ORIGINAL_URL] = sourceUrl;
    analysis['prepareStage'] = STAGE_TRIM;
    analysis['prepareTaskId'] = taskId;
    analysis['prepareStartTs'] = deps.now();
    await saveAnalysis(deps, material, analysis);
    deps.log('info', `[drama-prepare] id=${material.id} submit trim taskId=${taskId} end=${end}`);
    return;
  }
  await submitOcr(deps, material, sourceUrl, analysis);
}

/** 推进一个阶段后即返回（每阶段只 submit/query 一次，绝不 sleep 等云；规格 §7.3）。 */
async function advance(deps: Deps, material: Material): Promise<boolean> {
  const analysis = { ...material.analysis };
  const stage = trim(str(analysis, 'prepareStage')) || STAGE_INIT;
  const now = deps.now();
  const started = num(analysis, 'prepareStartTs', now);
  switch (stage) {
    case STAGE_TRIM:
      return pollTrim(deps, material, analysis, now, started);
    case STAGE_OCR:
      return pollOcr(deps, material, analysis, now, started);
    case STAGE_ASR:
      return pollAsr(deps, material, analysis, now, started);
    case STAGE_BURN:
      return pollBurn(deps, material, analysis, now, started);
    case STAGE_DRAMA:
      return pollDrama(deps, material, analysis, now, started);
    default:
      // init / 未知阶段：重跑起点（源：default -> startPipeline(id); yield true）
      await startPipeline(deps, material);
      return true;
  }
}

async function pollTrim(
  deps: Deps,
  material: Material,
  analysis: Record<string, unknown>,
  now: number,
  started: number,
): Promise<boolean> {
  const task = await deps.mediakit.queryToolTask(str(analysis, 'prepareTaskId'));
  const status = task.status;
  if (isCompleted(status)) {
    const trimmed = task.videoUrl ?? '';
    if (isBlank(trimmed) || trimmed === 'null') {
      await fail(deps, material.id, '片尾裁切未返回视频');
      return true;
    }
    const permanent = await persistVideo(deps, trimmed, `drama_trim_${material.id}`);
    if (isBlank(str(analysis, META_ORIGINAL_URL))) {
      analysis[META_ORIGINAL_URL] = material.url;
    }
    analysis[META_TAIL_TRIM_RESOLVED] = true;
    material.url = permanent;
    const probed = await deps.ffmpeg.probeDurationSec(permanent);
    if (probed > 0) {
      material.duration = Math.round(probed);
      analysis['durationSec'] = probed;
    }
    await submitOcr(deps, material, toUrlOrThrow(deps, permanent, '裁切产物'), analysis);
    return true;
  }
  if (isFailed(status) || timedOut(now, started, STAGE_TIMEOUT_MS)) {
    await fail(deps, material.id, '片尾裁切失败');
    return true;
  }
  return false;
}

async function submitOcr(
  deps: Deps,
  material: Material,
  videoUrl: string,
  analysis: Record<string, unknown>,
): Promise<void> {
  const taskId = await deps.mediakit.submitToolTask(VIDEO_OCR, {
    video_url: videoUrl,
    mode: 'Subtitle',
    client_token: maxLength(`ocr-${material.id}`, 64),
  });
  analysis['prepareStage'] = STAGE_OCR;
  analysis['prepareTaskId'] = taskId;
  analysis['prepareStartTs'] = deps.now();
  await saveAnalysis(deps, material, analysis);
  deps.log('info', `[drama-prepare] id=${material.id} submit ocr taskId=${taskId}`);
}

async function pollOcr(
  deps: Deps,
  material: Material,
  analysis: Record<string, unknown>,
  now: number,
  started: number,
): Promise<boolean> {
  // OCR 字幕不在 queryToolTask 的映射里，必须读原始任务返回（规格 §6.1 注意事项）
  const task = await deps.mediakit.getTask(str(analysis, 'prepareTaskId'));
  const status = task ? str(task, 'status') : '';
  if (isCompleted(status) || task === null) {
    const duration = num(analysis, 'durationSec', material.duration ?? 15);
    const cues = parseOcrCues(task);
    const hard = hasHardSubtitles(cues, duration);
    analysis['hardSubtitle'] = hard;
    if (hard) {
      await submitDrama(deps, material, analysis, scriptSource(deps, material, analysis));
    } else {
      await submitAsr(deps, material, analysis);
    }
    return true;
  }
  if (isFailed(status) || timedOut(now, started, STAGE_TIMEOUT_MS)) {
    // 源实现：OCR 挂了不判失败，退化为「无硬字幕」继续 ASR
    deps.log('warn', `[drama-prepare] id=${material.id} ocr ${status}, fallback ASR`);
    analysis['hardSubtitle'] = false;
    await submitAsr(deps, material, analysis);
    return true;
  }
  return false;
}

async function submitAsr(deps: Deps, material: Material, analysis: Record<string, unknown>): Promise<void> {
  const source = scriptSource(deps, material, analysis);
  const taskId = await deps.mediakit.submitAsrSubtitles(source);
  analysis['prepareStage'] = STAGE_ASR;
  analysis['prepareTaskId'] = taskId;
  analysis['prepareStartTs'] = deps.now();
  await saveAnalysis(deps, material, analysis);
  deps.log('info', `[drama-prepare] id=${material.id} submit asr taskId=${taskId}`);
}

async function pollAsr(
  deps: Deps,
  material: Material,
  analysis: Record<string, unknown>,
  now: number,
  started: number,
): Promise<boolean> {
  const task = await deps.mediakit.queryAsrSubtitles(str(analysis, 'prepareTaskId'));
  const status = task.status;
  if (isCompleted(status)) {
    const cues = listOfMaps(task.asrSubtitles);
    const duration = num(analysis, 'durationSec', material.duration ?? 15);
    if (!hasSpokenContent(cues, duration)) {
      await fail(deps, material.id, '没有硬字幕且几乎无口播');
      return true;
    }
    analysis['asrCues'] = cues;
    await submitBurn(deps, material, analysis, cues);
    return true;
  }
  if (isFailed(status) || timedOut(now, started, STAGE_TIMEOUT_MS)) {
    await fail(deps, material.id, '语音识别失败');
    return true;
  }
  return false;
}

/** 把 ASR 结果当字幕烧进画面：drama-script 靠画面字幕还原台词，所以必须先烧（源：submitBurn）。 */
async function submitBurn(
  deps: Deps,
  material: Material,
  analysis: Record<string, unknown>,
  cues: Record<string, unknown>[],
): Promise<void> {
  const subtitles: Record<string, unknown>[] = [];
  for (const cue of cues) {
    const text = str(cue, 'text') || str(cue, 'subtitle_text');
    const item: Record<string, unknown> = {
      subtitle_text: text,
      start_time: num(cue, 'start', num(cue, 'start_time', 0)),
      end_time: num(cue, 'end', num(cue, 'end_time', 0)),
    };
    if (isNotBlank(String(item['subtitle_text']))) {
      subtitles.push(item);
    }
  }
  const body: Record<string, unknown> = {
    video_url: toUrlOrThrow(deps, material.url, '待烧录原片'),
    subtitles,
    subtitle_pos_preset: 'bottom_center',
    subtitle_font_size: 50,
    subtitle_font_type: 'sy_black',
  };
  const taskId = await deps.mediakit.submitToolTask(ADD_SUBTITLE, body);
  analysis['prepareStage'] = STAGE_BURN;
  analysis['prepareTaskId'] = taskId;
  analysis['prepareStartTs'] = deps.now();
  await saveAnalysis(deps, material, analysis);
  deps.log('info', `[drama-prepare] id=${material.id} submit burn taskId=${taskId}`);
}

async function pollBurn(
  deps: Deps,
  material: Material,
  analysis: Record<string, unknown>,
  now: number,
  started: number,
): Promise<boolean> {
  const task = await deps.mediakit.queryToolTask(str(analysis, 'prepareTaskId'));
  const status = task.status;
  if (isCompleted(status)) {
    const burned = task.videoUrl ?? '';
    if (isBlank(burned) || burned === 'null') {
      await fail(deps, material.id, '字幕烧录未返回视频');
      return true;
    }
    const permanent = await persistVideo(deps, burned, `drama_burn_${material.id}`);
    analysis['scriptSourceUrl'] = permanent;
    analysis['asrBurned'] = true;
    await submitDrama(deps, material, analysis, toUrlOrThrow(deps, permanent, '烧录产物'));
    return true;
  }
  if (isFailed(status) || timedOut(now, started, STAGE_TIMEOUT_MS)) {
    await fail(deps, material.id, '字幕烧录失败');
    return true;
  }
  return false;
}

async function submitDrama(
  deps: Deps,
  material: Material,
  analysis: Record<string, unknown>,
  sourceUrl: string,
): Promise<void> {
  const token = maxLength(`ds-${material.id}-${deps.now()}`, 64);
  const taskId = await deps.mediakit.submitToolTask(DRAMA_SCRIPT, {
    video_urls: [sourceUrl],
    return_pkg: true,
    client_token: token,
  });
  analysis['prepareStage'] = STAGE_DRAMA;
  analysis['prepareTaskId'] = taskId;
  analysis['dramaClientToken'] = token;
  analysis['prepareStartTs'] = deps.now();
  await saveAnalysis(deps, material, analysis);
  deps.log('info', `[drama-prepare] id=${material.id} submit drama-script taskId=${taskId}`);
}

async function pollDrama(
  deps: Deps,
  material: Material,
  analysis: Record<string, unknown>,
  now: number,
  started: number,
): Promise<boolean> {
  const task = await deps.mediakit.getTask(str(analysis, 'prepareTaskId'));
  const status = task ? str(task, 'status') : '';
  if (isCompleted(status)) {
    const resultUrl = resultUrlOf(task);
    if (isBlank(resultUrl)) {
      return retryOrFailDrama(deps, material, analysis, '剧本还原未返回 result_url');
    }
    await persistDrama(deps, material, analysis, resultUrl);
    return true;
  }
  if (isFailed(status) || timedOut(now, started, DRAMA_TIMEOUT_MS)) {
    const error = task?.['error'];
    const message = error && typeof error === 'object' ? str(error as Record<string, unknown>, 'message') : status;
    return retryOrFailDrama(deps, material, analysis, trim(message) || '剧本还原失败');
  }
  return false;
}

/** drama 失败自愈一次：有硬字幕且没烧过 ASR 时，补 ASR+烧录再来一遍（源：retryOrFailDrama）。 */
async function retryOrFailDrama(
  deps: Deps,
  material: Material,
  analysis: Record<string, unknown>,
  reason: string,
): Promise<boolean> {
  const hadHard = analysis['hardSubtitle'] === true || String(analysis['hardSubtitle']).toLowerCase() === 'true';
  const retried = analysis['dramaRetried'] === true || String(analysis['dramaRetried']).toLowerCase() === 'true';
  const asrBurned = analysis['asrBurned'] === true || String(analysis['asrBurned']).toLowerCase() === 'true';
  if (hadHard && !retried && !asrBurned) {
    analysis['dramaRetried'] = true;
    deps.log('warn', `[drama-prepare] id=${material.id} drama failed with hard-sub, retry ASR+burn: ${reason}`);
    await submitAsr(deps, material, analysis);
    return true;
  }
  await fail(deps, material.id, reason);
  return true;
}

/**
 * 落剧本（源：persistDrama，本地版差异最大的一步）：
 * - 源：下载 zip → 转存 TOS → 图片逐张 createFile；
 * - 本地：下载 → 落 `RETAKE_HOME/scripts/<materialId>/`，剧本 JSON 与人脸/场景帧都是本地路径。
 *   剧本文件路径写进 `material.scriptPath` 与 job.meta.scriptPath，便于用户手工校对/复用。
 */
async function persistDrama(
  deps: Deps,
  material: Material,
  analysis: Record<string, unknown>,
  resultUrl: string,
): Promise<void> {
  const dir = scriptDir(deps, material.id);
  await mkdir(dir, { recursive: true });
  const archivePath = path.join(dir, `drama_${material.id}.bin`);
  if (!existsSync(archivePath)) {
    await deps.ffmpeg.download(resultUrl, archivePath);
  }
  const bytes = await readFile(archivePath);
  if (bytes.length < 16) {
    await fail(deps, material.id, '下载剧本包失败');
    return;
  }
  const parsed = parseArchive(bytes);
  if (Object.keys(parsed.script).length === 0) {
    await fail(deps, material.id, '剧本包无法解析');
    return;
  }
  const scriptJsonPath = path.join(dir, 'result.json');
  await writeFile(scriptJsonPath, JSON.stringify(parsed.script, null, 2), 'utf8');
  const facePaths = await persistNamed(parsed.faces, path.join(dir, 'faces'), 12);
  const scenePaths = await persistNamed(parsed.sceneFrames, path.join(dir, 'scene_frames'), 16);

  const mapped = toAnalysis(parsed.script, facePaths, scenePaths);
  mapped[META_ORIGINAL_URL] = str(analysis, META_ORIGINAL_URL) || material.url;
  mapped['scriptSourceUrl'] = str(analysis, 'scriptSourceUrl') || material.url;
  mapped['scriptArchiveUrl'] = archivePath;
  mapped['scriptJsonPath'] = scriptJsonPath;
  mapped['hardSubtitle'] = analysis['hardSubtitle'];
  mapped['asrBurned'] = analysis['asrBurned'];
  mapped['aspectRatio'] = fromScript(parsed.script);
  mapped['durationSec'] = analysis['durationSec'];
  mapped['prepareStage'] = STAGE_PERSIST;

  material.scriptPath = scriptJsonPath;
  if (isNotBlank(scenePaths[0] ?? '')) {
    material.coverUrl = material.coverUrl ?? scenePaths[0];
  }
  if (scenePaths.length > 0) {
    material.keyframeUrls = scenePaths;
  }
  material.analysis = mapped;
  material.analyzeStatus = ANALYZE_READY;
  material.sanitizeStatus = SANITIZE_SKIPPED;
  material.analyzeError = undefined;
  await deps.store.materials.save(material);
  deps.log(
    'info',
    `[drama-prepare] id=${material.id} script_ready faces=${facePaths.length} scenes=${scenePaths.length}`,
  );
}

/** 素材相关的剧本工作目录（纯路径计算；建目录由调用方负责）。 */
function scriptDir(deps: Deps, materialId: string): string {
  return path.join(deps.config.paths.scripts, materialId.replace(/[^A-Za-z0-9_-]/g, ''));
}

/** 逐张落盘（源：persistNamed：名字里带斜杠要换掉、太长按尾部截、限制张数、忽略坏文件）。 */
async function persistNamed(
  items: Array<{ name: string; data: Buffer }>,
  dir: string,
  limit: number,
): Promise<string[]> {
  const urls: string[] = [];
  if (!items || items.length === 0) {
    return urls;
  }
  await mkdir(dir, { recursive: true });
  let n = 0;
  for (const item of items) {
    if (n >= limit || !item || !item.data || item.data.length < 32) {
      continue;
    }
    const base = path.basename((item.name || `${n}`).replace(/\\/g, '/'));
    const name = (base.length > 80 ? base.slice(-80) : base).replace(/[^\w.\-]/g, '_');
    try {
      const file = path.join(dir, `${n}_${name}`);
      await writeFile(file, item.data);
      urls.push(file);
      n++;
    } catch {
      // 单张图失败不影响主链路（源实现同样只 warn 后继续）
    }
  }
  return urls;
}

/** 送 drama-script 的片源：烧过字幕用烧录产物，否则用当前 url（源：scriptSource）。 */
function scriptSource(deps: Deps, material: Material, analysis: Record<string, unknown>): string {
  const burned = str(analysis, 'scriptSourceUrl');
  return toUrlOrThrow(deps, burned || material.url, '剧本还原片源');
}

/** 中间产物必须仍是云端可访问地址，否则整条链断在这里（规格 §11-1）。 */
function toUrlOrThrow(deps: Deps, value: string, context: string): string {
  return deps.artifact.toConsumableUrl(value, context);
}

/**
 * 中间产物转存（源：persistVideo）。
 *
 * 本地版的一个主动取舍：
 * - 配了 `MEDIKIT_OUTPUT_DEST` 时，产物本来就是 `tos://` 直存 → 转 https 后既是长期地址又能直接喂下一个工具，走转存；
 * - **没配时不去下载 VOD 预览链**：下载回来只会得到一个本地文件，而下一个云端工具需要 URL，
 *   链子反而在本地彻底断掉；保留原链 best-effort 往下走（至多在下一次提交时报 22020001，
 *   错误会带上去配 output_destination 的指引）。
 */
async function persistVideo(deps: Deps, url: string, hint: string): Promise<string> {
  if (deps.config.mediakit.outputDestination.length === 0) {
    deps.log('warn', `[drama-prepare] 未配 MEDIKIT_OUTPUT_DEST，中间产物保留云端原链（24h 失效，不下载成本地文件）hint=${hint}`);
    return url;
  }
  try {
    return await deps.artifact.persistIfEphemeral(url, ARTIFACT_SUBDIR, hint);
  } catch (ex) {
    deps.log('warn', `[drama-prepare] persist video fallback hint=${hint} err=${(ex as Error).message}`);
    return url;
  }
}

/** 读 OCR 字幕数组（源：parseOcrCues：result.subtitles）。 */
function parseOcrCues(task: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!task) {
    return [];
  }
  const result = task['result'];
  if (!result || typeof result !== 'object') {
    return [];
  }
  return listOfMaps((result as Record<string, unknown>)['subtitles']);
}

/** 读 drama 的 result.result_url（源：resultUrl）。 */
function resultUrlOf(task: Record<string, unknown> | null): string {
  if (!task) {
    return '';
  }
  const result = task['result'];
  if (!result || typeof result !== 'object') {
    return '';
  }
  const map = result as Record<string, unknown>;
  return trim(str(map, 'result_url')) || trim(str(map, 'resultUrl'));
}

function timedOut(now: number, started: number, timeout: number): boolean {
  return now - started > timeout;
}

function isCompleted(status: string): boolean {
  const s = status.toLowerCase();
  return s === 'completed' || s === 'succeeded' || s === 'success';
}

function isFailed(status: string): boolean {
  const s = status.toLowerCase();
  return s === 'failed' || s === 'cancelled' || s === 'canceled';
}

/** 只推进 analysis blob（源：saveAnalysis 的 patch 语义）。 */
async function saveAnalysis(
  deps: Deps,
  material: Material,
  analysis: Record<string, unknown>,
): Promise<void> {
  material.analysis = analysis;
  await deps.store.materials.save(material);
}

/** 落失败态：**只**写 script_failed + 引导文案，绝不回到 pending（源类注释）。 */
async function fail(deps: Deps, id: string, message: string): Promise<void> {
  const material = await deps.store.materials.get(id);
  if (!material) {
    return;
  }
  material.analyzeStatus = ANALYZE_FAILED;
  material.analyzeError = maxLength(failHint(message), 1024);
  await deps.store.materials.save(material);
  deps.log('warn', `[drama-prepare] id=${id} script_failed: ${message}`);
}
