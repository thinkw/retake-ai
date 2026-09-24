/**
 * 分段切点规划（交接包规格 §2.1：源 `DramaSegmentPlanner.java` → `core/planner/**`，v1 **先留接口**）。
 *
 * 时间口径工具（msOrSec / millisToSec / firstMillisOrSec）**逐字移植**，因为剧本包里的时间字段
 * 在不同版本间混用「毫秒/秒」，script-mapper 与本文件共用同一套判定，必须一处维护。
 *
 * v1 只实现 `planSingle`（整片一段、≤15s）：
 * - 与规格 §3「单段 ≤15s happy path 一条打穿」一致；
 * - 源实现是按细镜头切点 + 同场合并 + 尾帧衔接的完整算法（415 行），属规格 §13 的 phase 2 范围。
 */

import type { JsonMap } from '../util/maps.js';
import { strOf } from '../util/maps.js';
import { blankToDefault, isNotBlank } from '../util/text.js';
import { MAX_SEGMENT_SECONDS, MIN_SEGMENT_SECONDS, clampSegmentDuration, normalizeTargetSegmentSeconds } from './limits.js';

/** 一个生成段（源：DramaSegmentPlanner.Segment）。 */
export class Segment {
  readonly start: number;
  readonly end: number;
  readonly duration: number;
  /** 是否需要上一段尾帧作本段首帧（同场续段才 true；v1 单段恒 false） */
  readonly needLastFrame: boolean;
  readonly sceneGroupId: string;
  readonly shotGroupId: string;

  constructor(start: number, end: number, needLastFrame: boolean, sceneGroupId: string, shotGroupId?: string) {
    this.start = round1(start);
    this.end = round1(end);
    this.duration = Math.max(MIN_SEGMENT_SECONDS, Math.round(this.end - this.start));
    this.needLastFrame = needLastFrame;
    this.sceneGroupId = blankToDefault(sceneGroupId, 's');
    this.shotGroupId = blankToDefault(shotGroupId ?? '', this.sceneGroupId);
  }
}

/** 规划结果（源：PlanResult：error 非空即失败，调用方把 error 直接展示给用户）。 */
export interface PlanResult {
  segments: Segment[];
  error: string;
}

function okPlan(segments: Segment[]): PlanResult {
  return { segments, error: '' };
}

function failPlan(error: string): PlanResult {
  return { segments: [], error };
}

/** 规划是否成功（源：plan.ok()）。 */
export function planOk(result: PlanResult): boolean {
  return result.error.length === 0 && result.segments.length > 0;
}

/**
 * v1：整片一段。
 *
 * 与源实现的口径差异（务必知情）：源版会把 ≤15s 的片子按细镜头切成多段再链式衔接；
 * 本地版 v1 明确只走「一次 Seedance 调用出全片」，因此：
 * - 段窗口 = [0, totalSec]，duration 钳到 [4,15]；
 * - needLastFrame 恒 false ⇒ 提交时不会带 firstFrame（规格 §7.3 第 4 步「新版不传 reference_video，只带剧本 prompt + 人像 + 音色」）。
 */
export function planSingle(totalSec: number, segmentMaxSeconds = MAX_SEGMENT_SECONDS): PlanResult {
  const max = normalizeTargetSegmentSeconds(segmentMaxSeconds);
  if (totalSec < MIN_SEGMENT_SECONDS) {
    return failPlan(`成片短于 ${MIN_SEGMENT_SECONDS} 秒，无法生成`);
  }
  if (totalSec > max + 0.5) {
    return failPlan(
      `v1 仅支持 ≤${max} 秒的单段复刻（当前 ${Math.round(totalSec)} 秒）；` +
        '长视频分段链式生成/断点续跑属 phase 2，请换一条不超过 15 秒的参考片',
    );
  }
  const end = Math.min(totalSec, max);
  return okPlan([new Segment(0, end, false, 's1', 's1-1')]);
}

/** 段 → meta.segments 元素（源：DramaSegmentPromptAssembler.toSegMaps，含 status=pending）。 */
export function toSegMaps(segments: Segment[]): JsonMap[] {
  const out: JsonMap[] = [];
  segments.forEach((segment, index) => {
    out.push({
      index,
      start: segment.start,
      end: segment.end,
      duration: segment.duration,
      needLastFrame: segment.needLastFrame,
      sceneGroupId: segment.sceneGroupId,
      shotGroupId: segment.shotGroupId,
      status: 'pending',
    });
  });
  return out;
}

/**
 * meta.segments 元素 → Segment（源：DramaSegmentPromptAssembler.windowOf）。
 * 提交阶段只用到窗口与 needLastFrame，因此这里做一次「快照 → 值对象」的还原。
 */
export function windowOf(seg: JsonMap): Segment {
  const start = numberOf(seg, 'start', 0);
  const end = numberOf(seg, 'end', start + 4);
  const needLast = boolOf(seg, 'needLastFrame');
  const scene = strOf(seg['sceneGroupId'] ?? '');
  return new Segment(start, end, needLast, scene, blankToDefault(strOf(seg['shotGroupId'] ?? ''), scene));
}

function numberOf(seg: JsonMap, key: string, fallback: number): number {
  const value = seg[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolOf(seg: JsonMap, key: string): boolean {
  const value = seg[key];
  return value === true || String(value ?? '').toLowerCase() === 'true';
}

/** 保留一位小数（源：round1）。 */
function round1(value: number): number {
  return Math.round(value * 10.0) / 10.0;
}

// ——————————————————————————————————————————————
// 时间口径工具（逐字移植源：DramaSegmentPlanner 的 static 方法）
// ——————————————————————————————————————————————

/** 明确是毫秒的字段（如 StartInMillis），一律 /1000。 */
export function millisToSec(millis: unknown): number {
  const value = firstNum(millis);
  if (value === null) {
    return 0;
  }
  return value / 1000.0;
}

/** 先看毫秒字段，再看秒字段，最后看兜底时钟字段（源：firstMillisOrSec）。 */
export function firstMillisOrSec(millis: unknown, sec: unknown, clock: unknown): number {
  if (millis !== null && millis !== undefined && firstNum(millis) !== null) {
    return millisToSec(millis);
  }
  return msOrSec(sec, clock, null);
}

/**
 * 三个候选字段里取第一个能解析出数字的，并按「≥1000 判为毫秒」换算（源：msOrSec）。
 * ⚠️ 该启发式的边界：真正的 1000 秒以上长视频会被误判成毫秒，但本产品的硬上限是 60 秒，不会触发。
 */
export function msOrSec(a: unknown, b: unknown, c: unknown): number {
  let value = firstNum(a);
  if (value === null) {
    value = firstNum(b);
  }
  if (value === null) {
    value = firstNum(c);
  }
  if (value === null) {
    return 0;
  }
  if (value >= 1000) {
    return value / 1000.0;
  }
  return value;
}

function firstNum(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (!isNotBlank(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 供 prompt 组装用的钳制（源：Math.max(MIN, Math.min(duration, MAX))）。 */
export function clampDuration(seconds: number): number {
  return clampSegmentDuration(seconds);
}
