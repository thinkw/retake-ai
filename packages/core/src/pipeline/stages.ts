/**
 * 新版拍同款（drama / 剧本还原）状态与阶段的**唯一真源**。
 *
 * 逐字移植源仓库 `service/btob/drama/DramaShootSameStatuses.java`：
 * 「刻意不用 pending/preparing/generating，避免旧 Job 领取」——本地版同样保留 `script_` 前缀，
 * 便于与源实现对照移植，也避免与将来可能引入的旧链路常量集混用。
 */

/** 业务类型常量（沿用源仓库取值，便于与源数据/日志对照）。 */
export const PIPELINE = 'drama_script';
/** 业务类型（源：DramaShootSameStatuses.BUSINESS_TYPE）。 */
export const BUSINESS_TYPE = 'btob-brand-shoot-same-drama';

// ——————————————————————————————————————————————
// 素材「剧本还原」（prepare）状态：script_pending → script_running → script_ready；失败 script_failed
// ——————————————————————————————————————————————
export const ANALYZE_PENDING = 'script_pending';
export const ANALYZE_RUNNING = 'script_running';
export const ANALYZE_READY = 'script_ready';
export const ANALYZE_FAILED = 'script_failed';

/** 素材脱敏状态：新版上传即 skipped（drama 链路不走 erase/blur 脱敏）。 */
export const SANITIZE_SKIPPED = 'skipped';

// ——————————————————————————————————————————————
// 出片 job 状态：script_preparing → script_generating → script_preview → script_done；失败 script_failed
// ——————————————————————————————————————————————
export const JOB_PREPARING = 'script_preparing';
export const JOB_GENERATING = 'script_generating';
export const JOB_PREVIEW = 'script_preview';
export const JOB_DONE = 'script_done';
export const JOB_FAILED = 'script_failed';

/** job 的 TS 字面量联合类型（取值与上面常量一一对应）。 */
export type JobStatus =
  | typeof JOB_PREPARING
  | typeof JOB_GENERATING
  | typeof JOB_PREVIEW
  | typeof JOB_DONE
  | typeof JOB_FAILED;

/** 素材剧本还原状态的 TS 字面量联合类型。 */
export type MaterialScriptStatus =
  | typeof ANALYZE_PENDING
  | typeof ANALYZE_RUNNING
  | typeof ANALYZE_READY
  | typeof ANALYZE_FAILED;

/** 素材列表可选的状态集合（源：MATERIAL_STATUSES）。 */
export const MATERIAL_STATUSES: readonly MaterialScriptStatus[] = [
  ANALYZE_PENDING,
  ANALYZE_RUNNING,
  ANALYZE_READY,
  ANALYZE_FAILED,
];

/** 出片列表可选的状态集合（源：JOB_LIST_STATUSES）。 */
export const JOB_LIST_STATUSES: readonly JobStatus[] = [
  JOB_PREPARING,
  JOB_GENERATING,
  JOB_PREVIEW,
  JOB_DONE,
  JOB_FAILED,
];

/** 调度器需要继续推进的「在途」状态集合（源：JOB_RUNNING_STATUSES）。 */
export const JOB_RUNNING_STATUSES: readonly JobStatus[] = [JOB_PREPARING, JOB_GENERATING];

// ——————————————————————————————————————————————
// A. 素材预处理阶段（meta.stage / analysis.prepareStage 复用同一套取值）
//    init → trim（可选裁片尾）→ ocr（判硬字幕）→ asr（无硬字幕才做）→ burn（有 ASR 无字幕时烧录）
//    → drama（drama-script 还原剧本）→ persist（落本地剧本）
// ——————————————————————————————————————————————
export const STAGE_INIT = 'init';
export const STAGE_TRIM = 'trim';
export const STAGE_OCR = 'ocr';
export const STAGE_ASR = 'asr';
export const STAGE_BURN = 'burn';
export const STAGE_DRAMA = 'drama';
export const STAGE_PERSIST = 'persist';

/** 预处理阶段字面量类型。 */
export type PrepareStage =
  | typeof STAGE_INIT
  | typeof STAGE_TRIM
  | typeof STAGE_OCR
  | typeof STAGE_ASR
  | typeof STAGE_BURN
  | typeof STAGE_DRAMA
  | typeof STAGE_PERSIST;

// ——————————————————————————————————————————————
// B. 出片生成阶段（job.meta.stage）：plan → video_seg →（phase 2 才有）concat → done
// ——————————————————————————————————————————————
export const JOB_STAGE_PLAN = 'plan';
export const JOB_STAGE_VIDEO = 'video_seg';
export const JOB_STAGE_CONCAT = 'concat';
export const JOB_STAGE_DONE = 'done';

/** 生成阶段字面量类型。 */
export type JobStage =
  | typeof JOB_STAGE_PLAN
  | typeof JOB_STAGE_VIDEO
  | typeof JOB_STAGE_CONCAT
  | typeof JOB_STAGE_DONE;

/** 失败提示：剧本还原失败时引导用户（源：FAIL_HINT_LEGACY，逐字照搬）。 */
export const FAIL_HINT_LEGACY =
  '剧本还原失败。没有硬字幕且几乎无口播的素材请改用旧版拍同款（页头「使用旧版」后重新上传）。';

/** 是否属于「素材剧本还原」状态集（源：MATERIAL_STATUSES.contains）。 */
export function isMaterialStatus(value: string): value is MaterialScriptStatus {
  return (MATERIAL_STATUSES as readonly string[]).includes(value);
}

/** 是否属于「在途 job」状态集（调度器领取判据）。 */
export function isJobRunningStatus(value: string): value is JobStatus {
  return (JOB_RUNNING_STATUSES as readonly string[]).includes(value);
}

/** 剧本还原超时的兜底引导文案（源：各类 fail(...) 里拼的 FAIL_HINT_LEGACY）。 */
export function failHint(message: string): string {
  return `${message}。${FAIL_HINT_LEGACY}`;
}

/**
 * 片尾裁切判定（源：`service/viral/AiViralMaterialTailTrimPolicy.java` 的 shouldTrim 分支）。
 *
 * 裁切必须发生在分析/去字幕之前，否则会把抖音视频结尾的片尾卡分析成一个无用场景。
 * 时长必须明显长于「裁掉秒数 + 1s 护栏」，避免裁完只剩空壳或探测失败时误裁。
 */
export function shouldTrimTail(trimTailSeconds: number | undefined, durationSeconds: number | undefined): boolean {
  if (!trimTailSeconds || trimTailSeconds <= 0) {
    return false;
  }
  if (durationSeconds === undefined || durationSeconds === null || !(durationSeconds > 0)) {
    return false;
  }
  return durationSeconds > trimTailSeconds + 1;
}

/** 片尾裁切是否已处理完毕（源：isTailTrimResolved；重试时避免对已裁地址再裁一次）。 */
export function isTailTrimResolved(analysis: Record<string, unknown> | null | undefined): boolean {
  if (!analysis) {
    return false;
  }
  const value = analysis['tailTrimResolved'];
  return value === true || String(value).toLowerCase() === 'true';
}

/** meta.analysis 里「已裁片尾」标记的键名（源：META_TAIL_TRIM_RESOLVED）。 */
export const META_TAIL_TRIM_RESOLVED = 'tailTrimResolved';
/** meta.analysis 里原片地址的键名（源：META_ORIGINAL_URL）。 */
export const META_ORIGINAL_URL = 'originalUrl';
