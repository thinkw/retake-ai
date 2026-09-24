/**
 * Seedance prompt 辅助常量与字幕策略工具。
 *
 * 逐字移植源仓库 `service/video/util/VideoPromptUtils.java`（规格 §9 移植点：常量不要自己发挥）。
 */

/** 火山 Ark 创意指令上限 */
export const PROMPT_MAX_LENGTH = 500;

/** 写入 Seedance 正文，提醒模型控制篇幅 */
export const PROMPT_LIMIT_NOTICE = '提示词限制500字。';

/** 无字幕时的画面约束（完整版） */
export const NO_SUBTITLE_INSTRUCTION =
  '画面禁止出现任何字幕、花字、标题条、文字叠加或台词文字，仅人物口播说话，不要在画面上显示任何文字。';

/** 无字幕时的画面约束（截断兜底短版） */
export const NO_SUBTITLE_INSTRUCTION_SHORT = '画面禁止出现任何字幕、花字或文字叠加。';

/**
 * 对已有 prompt 应用字幕策略（源：applySubtitlePolicy，withSubtitle 恒 false 的分支）。
 * 已显式写过「禁止出现字幕」的不重复追加，避免浪费 500 字预算。
 */
export function applySubtitlePolicy(prompt: string, withSubtitle = false): string {
  if (prompt.trim().length === 0 || withSubtitle) {
    return prompt;
  }
  if (prompt.includes('禁止出现字幕') || prompt.includes('禁止出现任何字幕')) {
    return prompt;
  }
  const suffix = `\n【画面要求】${NO_SUBTITLE_INSTRUCTION}`;
  const trimmed = prompt.trim();
  if (trimmed.length + suffix.length <= PROMPT_MAX_LENGTH) {
    return trimmed + suffix;
  }
  const keepPrompt = PROMPT_MAX_LENGTH - suffix.length;
  if (keepPrompt > 0) {
    return trimmed.slice(0, Math.min(trimmed.length, keepPrompt)) + suffix;
  }
  return trimmed.slice(0, PROMPT_MAX_LENGTH);
}
