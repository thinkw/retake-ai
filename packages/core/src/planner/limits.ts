/**
 * 时长与分段硬约束常量。
 *
 * 逐字移植源仓库 `service/btob/BrandShootSameLongFormPromptBuilder.java` 里的常量段
 * （规格 §6.2「硬约束」与 §9「移植点」）；这些数字决定能不能提交、提交多少秒，不能改。
 */

/** Seedance 2.0 单段生成时长下限（秒） */
export const MIN_SEGMENT_SECONDS = 4;
/** Seedance 2.0 单段生成时长上限（秒） */
export const MAX_SEGMENT_SECONDS = 15;
/** 拍同款长视频成片总时长上限（秒）——源项目「60s 硬上限」（规格 §11-9） */
export const MAX_TOTAL_SECONDS = 60;
/** Seedance reference_video 时长上限（文档值 15.2 秒） */
export const REF_VIDEO_MAX_SECONDS = 15.2;
/** reference_video 实现侧裁到 15.0 留余量（规格 §6.2） */
export const REF_VIDEO_TRIM_TO_SECONDS = 15.0;
/** 人像槽位工程上限（>10 视为误检；与 cast.ts 共用同一常量） */
export const SANITY_MAX_PORTRAITS = 10;

/**
 * 归一化用户指定的单段时长上限：为空/非法回退 15；合法值钳制到 [4, 15]。
 * （源：normalizeTargetSegmentSeconds）
 */
export function normalizeTargetSegmentSeconds(value: unknown): number {
  const fallback = MAX_SEGMENT_SECONDS;
  let seconds: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    seconds = Math.round(value);
  } else if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) {
    seconds = Math.round(Number(value));
  } else {
    seconds = fallback;
  }
  if (seconds <= 0) {
    return fallback;
  }
  return Math.max(MIN_SEGMENT_SECONDS, Math.min(seconds, MAX_SEGMENT_SECONDS));
}

/** 成片时长是否超过本次单段上限，需要走分段链式生成（v1 恒 false）。 */
export function isLongFormDuration(totalSeconds: number, segmentMaxSeconds: number): boolean {
  return totalSeconds > normalizeTargetSegmentSeconds(segmentMaxSeconds);
}

/** 把目标时长钳到 Seedance 可提交的 [4,15] 整数秒。 */
export function clampSegmentDuration(seconds: number): number {
  const rounded = Math.round(Number.isFinite(seconds) ? seconds : MIN_SEGMENT_SECONDS);
  return Math.max(MIN_SEGMENT_SECONDS, Math.min(rounded, MAX_SEGMENT_SECONDS));
}
