/**
 * 硬字幕判定启发式（源：`service/btob/drama/DramaOcrHeuristic.java`）。
 * 口径：Subtitle 模式 OCR 条数 ≥ 3 且覆盖时长 ≥ 成片 20% ⇒ 认为片子里已经烧了硬字幕。
 *
 * 为什么要判：有硬字幕就直接进 drama-script（模型能读画面字幕还原台词）；
 * 没有硬字幕才走 ASR → 把字幕烧上去 → 再 drama-script（源预处理链）。
 */

import type { JsonMap } from '../util/maps.js';
import { numOf, strOf } from '../util/maps.js';
import { isBlank } from '../util/text.js';

/** 最少字幕条数（源：MIN_CUE_COUNT）。 */
export const MIN_CUE_COUNT = 3;
/** 最少覆盖时长占比（源：MIN_COVERAGE_RATIO）。 */
export const MIN_COVERAGE_RATIO = 0.2;

/** 是否存在硬字幕（源：hasHardSubtitles；兼容 subtitle_text/text 与 start_time/start 两套字段名）。 */
export function hasHardSubtitles(cues: JsonMap[] | null, durationSec: number): boolean {
  if (!cues || cues.length < MIN_CUE_COUNT || durationSec <= 0) {
    return false;
  }
  let covered = 0;
  for (const cue of cues) {
    if (!cue) {
      continue;
    }
    let text = strOf(cue['subtitle_text']);
    if (isBlank(text)) {
      text = strOf(cue['text']);
    }
    if (isBlank(text)) {
      continue;
    }
    const start = numOf(cue['start_time'], numOf(cue['start'], 0));
    const end = numOf(cue['end_time'], numOf(cue['end'], start));
    if (end > start) {
      covered += end - start;
    }
  }
  return covered >= durationSec * MIN_COVERAGE_RATIO;
}

/** 是否有可用口播（源：hasSpokenContent：≥2 句且覆盖 ≥ min(2s, 时长 8%)）。 */
export function hasSpokenContent(asrCues: JsonMap[] | null, durationSec: number): boolean {
  if (!asrCues || asrCues.length === 0 || durationSec <= 0) {
    return false;
  }
  let lines = 0;
  let covered = 0;
  for (const cue of asrCues) {
    if (!cue) {
      continue;
    }
    let text = strOf(cue['text']);
    if (isBlank(text)) {
      text = strOf(cue['subtitle_text']);
    }
    if (isBlank(text)) {
      continue;
    }
    lines++;
    const start = numOf(cue['start'], numOf(cue['start_time'], 0));
    const end = numOf(cue['end'], numOf(cue['end_time'], start));
    if (end > start) {
      covered += end - start;
    }
  }
  return lines >= 2 && covered >= Math.min(2.0, durationSec * 0.08);
}
