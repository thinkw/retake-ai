/**
 * 画幅判定（源：`service/btob/drama/DramaAspectRatio.java`）。
 * 口径：**画幅跟原片** —— 优先剧本 Videos 宽高，否则 9:16。
 */

import type { JsonMap } from '../util/maps.js';
import { strOf } from '../util/maps.js';
import { isBlank, isNotBlank } from '../util/text.js';

/** 本地版支持的画幅集合（规格 §4）。 */
export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const;

/** 缺省画幅：竖屏。 */
export const DEFAULT_ASPECT = '9:16';

/** 由宽高推导画幅（源：fromWh；阈值与源一致，容差内就近吸附）。 */
export function fromWh(w: number, h: number): string {
  if (w <= 0 || h <= 0) {
    return DEFAULT_ASPECT;
  }
  const r = w / h;
  if (Math.abs(r - 16.0 / 9) < 0.12) {
    return '16:9';
  }
  if (Math.abs(r - 9.0 / 16) < 0.12) {
    return '9:16';
  }
  if (Math.abs(r - 1.0) < 0.08) {
    return '1:1';
  }
  if (Math.abs(r - 4.0 / 3) < 0.1) {
    return '4:3';
  }
  if (Math.abs(r - 3.0 / 4) < 0.1) {
    return '3:4';
  }
  return w >= h ? '16:9' : DEFAULT_ASPECT;
}

/** 从剧本 JSON 推导画幅（源：fromScript：读 Videos[0].Width/Height，兼容小写字段）。 */
export function fromScript(script: JsonMap | null | undefined): string {
  if (!script) {
    return DEFAULT_ASPECT;
  }
  let raw: unknown = script['Videos'];
  if (!Array.isArray(raw) || raw.length === 0) {
    raw = script['videos'];
  }
  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0];
    if (first && typeof first === 'object') {
      const video = first as JsonMap;
      const w = toInt(video['Width'], toInt(video['width'], 0));
      const h = toInt(video['Height'], toInt(video['height'], 0));
      return fromWh(w, h);
    }
  }
  return DEFAULT_ASPECT;
}

/** 从 analysis 推导画幅（源：fromAnalysis：优先已存的 aspectRatio，再退到剧本宽高）。 */
export function fromAnalysis(analysis: JsonMap | null | undefined): string {
  if (!analysis) {
    return DEFAULT_ASPECT;
  }
  const stored = strOf(analysis['aspectRatio']);
  if (isNotBlank(stored)) {
    // 源实现直接返回存量值；本地版多一步吸附，遇到不认识的写法仍然原样交出去（不臆造成 9:16）
    return normalizeAspect(stored) || stored;
  }
  return fromScript(analysis);
}

/** 校验/归一化用户传入的画幅；不在支持集合内返回空串（调用方据此报参数错误）。 */
export function normalizeAspect(value: string): string {
  const v = value.trim();
  return (ASPECT_RATIOS as readonly string[]).includes(v) ? v : '';
}

function toInt(value: unknown, fallback: number): number {
  if (typeof value === 'number') {
    return Math.trunc(value);
  }
  if (value === null || value === undefined || isBlank(String(value))) {
    return fallback;
  }
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}
