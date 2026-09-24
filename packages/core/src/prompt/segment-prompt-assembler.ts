/**
 * 分段 prompt 装配（源：`service/btob/drama/DramaSegmentPromptAssembler.java`）。
 *
 * 职责：把「规划出的段」变成「可提交的段快照」——填自动 prompt、套用用户覆盖、提交时决定最终 prompt。
 * 长度压缩不在这里做，交给 `prompt-length-compressor.ts`（与源调用顺序一致：先 fillAutoPrompts 再 compressSegments）。
 */

import type { JsonMap } from '../util/maps.js';
import { bool, str } from '../util/maps.js';
import { isBlank, isNotBlank } from '../util/text.js';
import { windowOf } from '../planner/segment-planner.js';
import { build } from './seedance-prompt.js';
import { PROMPT_MAX_LENGTH, applySubtitlePolicy } from './video-prompt-utils.js';

/**
 * 给没有用户覆盖的段填自动 prompt（源：fillAutoPrompts）。
 * 注意 `hasFirst` 的口径：**首段即使 needLastFrame 也当没有首帧**（无上一段可接）。
 */
export function fillAutoPrompts(
  analysis: JsonMap,
  segs: JsonMap[],
  personCount: number,
  hasAudio: boolean,
): void {
  if (segs.length === 0) {
    return;
  }
  const total = segs.length;
  for (let i = 0; i < total; i++) {
    const seg = segs[i];
    if (!seg) {
      continue;
    }
    if (isNotBlank(str(seg, 'promptOverride'))) {
      continue;
    }
    // 源实现先读出 start/end/needLastFrame 再构造窗口；本地 windowOf() 自己读同一批字段，口径一致
    const needLast = bool(seg, 'needLastFrame');
    const hasFirst = needLast && i > 0;
    const prompt = build(analysis, windowOf(seg), i, total, personCount, hasFirst, hasAudio);
    seg['prompt'] = prompt;
    seg['promptLength'] = prompt.length;
    seg['promptMax'] = PROMPT_MAX_LENGTH;
  }
}

/**
 * 套用用户逐段覆盖的 prompt（源：applyOverrides）。
 *
 * @returns 错误文案；成功返回 null。空列表表示不用覆盖。
 */
export function applyOverrides(segs: JsonMap[], prompts: string[] | undefined | null): string | null {
  if (!prompts || prompts.length === 0 || segs.length === 0) {
    return null;
  }
  if (prompts.length !== segs.length) {
    return `提示词段数与规划不一致（规划 ${segs.length} 段，提交 ${prompts.length} 段），请重新预览后再生成`;
  }
  for (let i = 0; i < segs.length; i++) {
    const raw = (prompts[i] ?? '').trim();
    if (isBlank(raw)) {
      continue;
    }
    if (raw.length > PROMPT_MAX_LENGTH) {
      return `第 ${i + 1} 段提示词超过 ${PROMPT_MAX_LENGTH} 字（当前 ${raw.length}），请删短后再生成`;
    }
    const seg = segs[i];
    if (seg) {
      seg['promptOverride'] = fittedOverride(raw);
    }
  }
  return null;
}

/** 用户覆盖也要过一遍字幕策略（源：fittedOverride）。 */
export function fittedOverride(raw: string): string {
  return applySubtitlePolicy(raw, false);
}

/**
 * 提交时的最终 prompt（源：resolveSubmitPrompt）。
 * 优先级：用户覆盖 > 已生成的自动 prompt > 现场重新组装。
 */
export function resolveSubmitPrompt(
  analysis: JsonMap,
  seg: JsonMap,
  idx: number,
  total: number,
  personCount: number,
  hasFirstFrame: boolean,
  hasAudio: boolean,
): string {
  const override = str(seg, 'promptOverride');
  if (isNotBlank(override)) {
    return fittedOverride(override);
  }
  const stored = str(seg, 'prompt');
  if (isNotBlank(stored)) {
    return stored;
  }
  return build(analysis, windowOf(seg), idx, total, personCount, hasFirstFrame, hasAudio);
}
