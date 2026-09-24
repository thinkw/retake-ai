/**
 * prompt 超长压缩（源：`service/btob/drama/DramaPromptLengthCompressor.java`）。
 *
 * 规则与源一致：**只压缩画面块**，对白轴与头尾「禁止出现字幕」原样拼回；
 * LLM 输出还要过一遍校验（不能吃掉对白、不能超 500 字），不合格就用**原始全量 prompt**——
 * 也就是「宁可能力超限交给模型，也不把台词丢掉」。
 *
 * 与源的差异（本地版必要妥协）：
 * - 源里 callChat 带 Token 钱包冻结/结算，本地版按规格 §2.3 砍掉计费，直接走 `ChatCompleter`；
 * - 未配置 ARK_CHAT_MODEL（chat 为 null）时不再静默失败，而是走 `compactVisual` 的**确定性压缩**。
 */

import type { ChatCompleter } from '../adapters/ark-chat.js';
import type { JsonMap } from '../util/maps.js';
import { bool, str } from '../util/maps.js';
import { isBlank, isNotBlank, trim } from '../util/text.js';
import { type Segment, windowOf } from '../planner/segment-planner.js';
import { NO_SUBTITLE_MARK, type Draft, compactVisual, draft } from './seedance-prompt.js';
import { PROMPT_MAX_LENGTH } from './video-prompt-utils.js';

/**
 * 压缩指令（源：instruction，逐字照搬）。
 * 单独导出便于单测断言「我们到底让模型干什么」。
 */
export function instruction(visual: string, maxChars: number): string {
  return (
    `把下面这段画面描述压缩到不超过 ${maxChars} 字。只输出压缩后的画面，不要输出其它内容。\n\n` +
    (visual ?? '')
  );
}

/** 由段快照重建草稿（源：draftOf）。 */
export function draftOf(
  analysis: JsonMap,
  seg: JsonMap,
  idx: number,
  total: number,
  personCount: number,
  hasAudio: boolean,
): Draft {
  const needLast = bool(seg, 'needLastFrame');
  const hasFirst = needLast && idx > 0;
  // 窗口起止不从这里读：windowOf() 自己按同一口径取 start/end/needLastFrame
  const window: Segment = windowOf(seg);
  return draft(analysis, window, idx, total, personCount, hasFirst, hasAudio);
}

/**
 * 清洗 LLM 输出（源：sanitizeVisual）：
 * 去代码块围栏、去被复读的「禁止出现字幕」、去被一起吞进来的对白块，保证还能安全拼回。
 */
export function sanitizeVisual(raw: string, target: Draft): string {
  if (isBlank(raw)) {
    return '';
  }
  let t = trim(raw);
  if (t.startsWith('```')) {
    const nl = t.indexOf('\n');
    if (nl > 0) {
      t = t.slice(nl + 1);
    }
    const fence = t.lastIndexOf('```');
    if (fence >= 0) {
      t = t.slice(0, fence);
    }
    t = trim(t);
  }
  t = trim(t.split(NO_SUBTITLE_MARK).join(''));
  const dialogue = trim(target.dialogueBlock);
  if (isNotBlank(dialogue) && t.includes(dialogue.trim())) {
    t = trim(t.split(dialogue.trim()).join(''));
  }
  const spokenAt = t.indexOf('须按下列时间');
  if (spokenAt > 0) {
    t = trim(t.slice(0, spokenAt));
  }
  return t;
}

/**
 * 用压缩后的画面块拼回完整 prompt，并做三重校验（源：applyLlmVisual）：
 * 1) 画面块非空；2) 拼回后不超 500 字；3) 对白块必须仍在里面。任一不过返回 null 由上层回退。
 */
export function applyLlmVisual(target: Draft, llmOutput: string): string | null {
  const visual = sanitizeVisual(llmOutput, target);
  if (isBlank(visual)) {
    return null;
  }
  const stitched = target.stitchVisual(visual);
  if (stitched.length > PROMPT_MAX_LENGTH) {
    return null;
  }
  const dialogue = trim(target.dialogueBlock);
  if (isNotBlank(dialogue) && !stitched.includes(dialogue.trim())) {
    return null;
  }
  return stitched;
}

/**
 * 压缩一份草稿（源：compressWith）。
 *
 * @param llm 方舟 chat 调用器；传 null 表示未配 ARK_CHAT_MODEL ⇒ 走本地确定性压缩
 */
export async function compressWith(target: Draft, llm: ChatCompleter | null): Promise<string> {
  const full = target.stitch();
  if (full.length <= PROMPT_MAX_LENGTH) {
    return full;
  }
  const budget = PROMPT_MAX_LENGTH - target.frozenLength();
  if (budget < 8 || isBlank(target.visual)) {
    return full;
  }
  if (llm === null) {
    // 本地兜底：按子句裁到预算内，再走同一套拼回校验
    const deterministic = target.stitchVisual(compactVisual(target.visual, budget));
    return deterministic.length <= PROMPT_MAX_LENGTH ? deterministic : full;
  }
  try {
    const raw = await llm(instruction(target.visual, budget));
    const ok = applyLlmVisual(target, raw);
    return ok !== null ? ok : full;
  } catch {
    // 源实现同样「压缩失败不阻塞主链路」，只是把超限 prompt 原样交给模型
    return full;
  }
}

/** 压缩结果（写回段快照的三个字段，源：prompt / promptLength / promptCompressed）。 */
export interface CompressedSegment {
  prompt: string;
  promptLength: number;
  promptCompressed: boolean;
}

/**
 * 压缩单段（源：compressSegments 的循环体）。
 * 用户手改过的 promptOverride 一律不动——那是用户的表达，不是我们的预算问题。
 */
export async function compressSegment(
  analysis: JsonMap,
  seg: JsonMap,
  idx: number,
  total: number,
  personCount: number,
  hasAudio: boolean,
  llm: ChatCompleter | null,
): Promise<CompressedSegment> {
  const override = str(seg, 'promptOverride');
  if (isNotBlank(override)) {
    return { prompt: override, promptLength: override.length, promptCompressed: false };
  }
  const target = draftOf(analysis, seg, idx, total, personCount, hasAudio);
  let current = str(seg, 'prompt');
  if (isBlank(current)) {
    current = target.stitch();
  }
  if (current.length <= PROMPT_MAX_LENGTH) {
    return { prompt: current, promptLength: current.length, promptCompressed: false };
  }
  const compressed = await compressWith(target, llm);
  return {
    prompt: compressed,
    promptLength: compressed.length,
    promptCompressed: compressed.length <= PROMPT_MAX_LENGTH && compressed.length < current.length,
  };
}

/** 就地压缩所有段（写回 seg.prompt / promptLength / promptMax / promptCompressed）。 */
export async function compressSegments(
  analysis: JsonMap,
  segs: JsonMap[],
  personCount: number,
  hasAudio: boolean,
  llm: ChatCompleter | null,
): Promise<void> {
  const total = segs.length;
  for (let i = 0; i < total; i++) {
    const seg = segs[i];
    if (!seg) {
      continue;
    }
    const result = await compressSegment(analysis, seg, i, total, personCount, hasAudio, llm);
    seg['prompt'] = result.prompt;
    seg['promptLength'] = result.promptLength;
    seg['promptMax'] = PROMPT_MAX_LENGTH;
    if (result.promptCompressed) {
      seg['promptCompressed'] = true;
    }
  }
}
