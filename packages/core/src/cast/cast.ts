/**
 * 拍同款主角时间轴与人像槽位约定（源：`service/btob/BrandShootSameCastSupport.java`，规格 §2.1）。
 *
 * 口径与源前端 `utils/btob/brandShootSameCast.ts` 一致：
 * - 人像张数上限 = 与 **[0, D+1s]** 有交集的不同主角 id 数；
 * - 产品侧不封顶 3（规格 §9 写「产品≤3」是历史口径，源实现实际是 `min(n, 10)`，此处**以源实现为准**）；
 * - 工程侧 > 10 视为误检（`SANITY_MAX_PORTRAITS`）。
 */

import type { PortraitRef } from '../types.js';
import type { JsonMap } from '../util/maps.js';
import { SANITY_MAX_PORTRAITS } from '../planner/limits.js';
import { listOfMaps, num, strOf } from '../util/maps.js';
import { isBlank, isNotBlank } from '../util/text.js';

/** 人像槽位工程上限（与 limits.ts 同源，导出便于外部只依赖本模块）。 */
export { SANITY_MAX_PORTRAITS };

/** 与窗口判定的宽松秒数（源：WINDOW_SLACK_SECONDS）。 */
export const WINDOW_SLACK_SECONDS = 1.0;

/** 固定槽位（非人像）：产品、背景、Logo、音频。 */
const FIXED_SLOTS = new Set(['product', 'background', 'logo', 'audio']);

/** 是否人像槽：spokesperson / spokesperson2 / spokesperson3 …（源：isSpokespersonSlot）。 */
export function isSpokespersonSlot(slot: string | null | undefined): boolean {
  return !!slot && /^spokesperson[0-9]*$/.test(slot);
}

/** 是否合法素材槽（人像或固定槽）。 */
export function isMaterialSlot(slot: string | null | undefined): boolean {
  return isSpokespersonSlot(slot) || (!!slot && FIXED_SLOTS.has(slot));
}

/** 0 → spokesperson，1 → spokesperson2（源：spokespersonKey）。 */
export function spokespersonKey(indexZeroBased: number): string {
  if (indexZeroBased <= 0) {
    return 'spokesperson';
  }
  return 'spokesperson' + (indexZeroBased + 1);
}

/**
 * 从槽位表里取人像 asset:// 列表（源：listSpokespersonAssets）。
 * 只有 `asset://` 才算数：Seedance 参考真人不吃普通 http 图（会触发 PrivacyInformation）。
 */
export function listSpokespersonAssets(assets: Record<string, string> | null | undefined): string[] {
  const out: string[] = [];
  if (!assets) {
    return out;
  }
  for (let i = 0; i < SANITY_MAX_PORTRAITS; i++) {
    const value = assets[spokespersonKey(i)];
    if (isNotBlank(value) && (value as string).trim().startsWith('asset://')) {
      out.push((value as string).trim());
    }
  }
  return out;
}

/** 从槽位表里取人像原始 URL（不要求 asset://，源：listSpokespersonMaterialUrls）。 */
export function listSpokespersonMaterialUrls(materials: Record<string, string> | null | undefined): string[] {
  const out: string[] = [];
  if (!materials) {
    return out;
  }
  for (let i = 0; i < SANITY_MAX_PORTRAITS; i++) {
    const value = materials[spokespersonKey(i)];
    if (isNotBlank(value)) {
      out.push((value as string).trim());
    }
  }
  return out;
}

/** 把 job.portraits（结构化）摊成源仓库的槽位表：spokesperson / spokesperson2 … + audio。 */
export function toAssetSlots(portraits: PortraitRef[] | undefined, voiceUrl?: string): Record<string, string> {
  const assets: Record<string, string> = {};
  (portraits ?? []).forEach((portrait, index) => {
    if (isNotBlank(portrait.url)) {
      assets[spokespersonKey(index)] = portrait.url.trim();
    }
  });
  if (isNotBlank(voiceUrl)) {
    assets['audio'] = (voiceUrl as string).trim();
  }
  return assets;
}

/** 清洗槽位表：只留 asset:// 值（源：DramaShootSameService.sanitizeAssets）。 */
export function sanitizeAssets(raw: Record<string, string> | null | undefined): Record<string, string> {
  const cleaned: Record<string, string> = {};
  if (!raw) {
    return cleaned;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === null || isBlank(value)) {
      continue;
    }
    const v = value.trim();
    if (v.startsWith('asset://')) {
      cleaned[key] = v;
    }
  }
  return cleaned;
}

/** 落在 [0, D+1s] 窗口内的 cast 行（源：castInWindow）。 */
export function castInWindow(analysis: JsonMap | null | undefined, durationD: number): JsonMap[] {
  const out: JsonMap[] = [];
  if (!analysis || !Array.isArray(analysis['cast'])) {
    return out;
  }
  const endBound = durationD + WINDOW_SLACK_SECONDS;
  for (const row of listOfMaps(analysis['cast'])) {
    const start = num(row, 'startTime', 0);
    let end = num(row, 'endTime', start);
    if (end <= start) {
      end = start + 0.5;
    }
    if (start < endBound && end > 0) {
      out.push(row);
    }
  }
  return out;
}

/** 窗口内不同主角数（源：uniqueCastCount）。 */
export function uniqueCastCount(rows: JsonMap[]): number {
  return uniqueCastIds(rows).size;
}

/** 窗口内主角标签（源：uniqueCastLabels：有 label 用 label，否则用 id）。 */
export function uniqueCastLabels(rows: JsonMap[]): string[] {
  const ids = new Set<string>();
  const labels: string[] = [];
  for (const row of rows) {
    const id = personKey(row);
    if (!ids.has(id)) {
      ids.add(id);
      const label = strOf(row['label']);
      labels.push(isNotBlank(label) && label !== 'null' ? label : id);
    }
  }
  return labels;
}

/**
 * 上传/生成人像槽上限（源：portraitSlotLimit）。
 * 无 cast 或解析失败 → 1；窗口内 0 人 → 1；再与工程上限 10 取小。
 */
export function portraitSlotLimit(analysis: JsonMap | null | undefined, durationD: number): number {
  if (!analysis || analysis['cast'] === undefined || analysis['cast'] === null) {
    return 1;
  }
  if (!Array.isArray(analysis['cast'])) {
    return 1;
  }
  const n = uniqueCastCount(castInWindow(analysis, durationD));
  if (n <= 0) {
    return 1;
  }
  return Math.min(n, SANITY_MAX_PORTRAITS);
}

/** 主角数是否异常（>10 视为误检；源：isCastCountAnomalous）。 */
export function isCastCountAnomalous(analysis: JsonMap | null | undefined, durationD: number): boolean {
  if (!analysis || !Array.isArray(analysis['cast'])) {
    return false;
  }
  return uniqueCastCount(castInWindow(analysis, durationD)) > SANITY_MAX_PORTRAITS;
}

function uniqueCastIds(rows: JsonMap[]): Set<string> {
  const ids = new Set<string>();
  if (!rows) {
    return ids;
  }
  for (const row of rows) {
    ids.add(personKey(row));
  }
  ids.delete('');
  ids.delete('null');
  ids.delete('label:');
  return ids;
}

/** 主角唯一键：优先 id，其次 label:xxx（源：personKey）。 */
function personKey(row: JsonMap): string {
  const id = strOf(row['id']);
  if (isNotBlank(id) && id !== 'null') {
    return id;
  }
  const label = strOf(row['label']);
  return isNotBlank(label) && label !== 'null' ? 'label:' + label : '';
}

/**
 * Seedance 首帧白名单（源：DramaShootSameService.seedanceSafeFirstFrameUrl / BtobBrandShootSameServiceImpl 同注释）：
 * 只允许 `asset://` 或方舟本账号刚生成的原始尾帧（ark-acg … last-frame 24h 签名链）。
 * ⚠️ 转存到自有 TOS 的截图会被 Privacy 拦（源 P1-13），不能当 firstFrame。
 */
export function seedanceSafeFirstFrameUrl(lastFrameUrl: string | null | undefined): string {
  if (isBlank(lastFrameUrl)) {
    return '';
  }
  const url = (lastFrameUrl as string).trim();
  if (url.startsWith('asset://')) {
    return url;
  }
  const u = url.toLowerCase();
  return u.startsWith('https://') && u.includes('ark-acg') && u.includes('volces.com') && u.includes('last-frame')
    ? url
    : '';
}
