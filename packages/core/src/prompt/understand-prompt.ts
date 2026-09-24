/**
 * 品牌拍同款系统提示词（理解 + 生成 + 兜底指令）的唯一维护点。
 *
 * 逐字移植源仓库 `service/btob/BrandShootSamePromptBuilder.java`（规格 §2.1 / §9）。
 * 说明：drama 新版出片主链路走 `seedance-prompt.ts`，本文件的价值有两点——
 * 1. `DEFAULT_RECOMMENDED_PROMPT` 是「分析抽不出指令 / 生成底稿为空」时的共用兜底（规格 §9 明确要求照搬）；
 * 2. 理解 prompt 与 cast 规则决定了 `analysis.cast`，而 cast 又决定人像槽位上限（cast.ts 校验口径）。
 *
 * 改 UNDERSTAND_PROMPT_STYLE / cast 规则时必须同步升高 UNDERSTAND_CAST_PROMPT_VERSION，
 * 否则本地素材库里缓存的旧 analysis 不会重跑视频理解（源类注释）。
 */

import type { JsonMap } from '../util/maps.js';
import { blankToDefault, isBlank, isNotBlank } from '../util/text.js';
import { PROMPT_LIMIT_NOTICE } from './video-prompt-utils.js';

/** 与理解 prompt 绑定；升高后下次分析会重跑 video-understand。 */
export const UNDERSTAND_CAST_PROMPT_VERSION = 2;

/** 分析抽不出指令、Stub、生成底稿为空时共用。 */
export const DEFAULT_RECOMMENDED_PROMPT =
  '复刻参考视频的运镜、节奏与场景结构，使用品牌人像与产品素材生成同款风格营销短视频，保持人物一致性。';

/** 生成方式：跟参考视频（旧链路，缺省）。 */
export const GENERATE_MODE_REF_VIDEO = 'ref_video';
/** 生成方式：分镜转写（新版剧本还原链路）。 */
export const GENERATE_MODE_SHOT_TRANSCRIPT = 'shot_transcript';
/** 新模式写入 meta.promptVersion，与现役 lite 区分（源：BrandShootSameGenerateMode.PROMPT_VERSION）。 */
export const PROMPT_VERSION = 'shot_transcript_v3';
/** 跟参考视频（有声裁切片、不再静音）（源：LITE_PROMPT_VERSION）。 */
export const LITE_PROMPT_VERSION = 'lite_v2';

const UNDERSTAND_PROMPT_STYLE =
  '请分析该营销短视频：总结风格、情绪、运镜、节奏、BGM风格、口播人声类型；' +
  '并给出一句适合「品牌拍同款」复刻的生成指令（recommendedPrompt）。' +
  '请用简洁中文回答，尽量覆盖：风格、情绪、运镜、节奏、bgm、人声。';

const UNDERSTAND_CAST_RULES =
  '拍同款要给需要对着换脸的人上传人像。cast 只列这些主角：' +
  '1）全程或大段出镜、有对白的人必须列入（品牌老板/口播、对手戏主客），同一人跨多镜用同一id；' +
  '2）一闪而过的配角不要列入（端菜服务员、路过、群演、海报脸），更不要把闪现配角当成唯一主角；' +
  '3）对手戏双方都要列入，不要只留其中一人；围坐但无对白的群演不要每人一条。';

const UNDERSTAND_JSON_TAIL =
  '请在回答末尾输出一段 JSON（不要其它说明），格式：' +
  '{"recommendedPrompt":"...","cast":[{"id":"p1","label":"品牌出镜","sceneIds":["S1","S2"]}]}' +
  '同一主角跨多镜请使用同一id；无主角则 cast 为空数组。';

const ASR_CLIP_MAX = 600;
const SCRIPT_CLIP_MAX = 800;

/**
 * 生成方式归一化（源：BrandShootSameGenerateMode.resolve）：缺省 / 未传 / 非法 = 跟参考视频。
 * 本地版 drama 链路在建 job 时会显式写 `shot_transcript`。
 */
export function resolveGenerateMode(raw: string | undefined | null): string {
  if (isBlank(raw)) {
    return GENERATE_MODE_REF_VIDEO;
  }
  const mode = (raw as string).trim();
  return mode.toLowerCase() === GENERATE_MODE_SHOT_TRANSCRIPT ? GENERATE_MODE_SHOT_TRANSCRIPT : GENERATE_MODE_REF_VIDEO;
}

/** 是否分镜转写模式（源：isShotTranscript(String)）。 */
export function isShotTranscriptMode(raw: string | undefined | null): boolean {
  return resolveGenerateMode(raw) === GENERATE_MODE_SHOT_TRANSCRIPT;
}

/** 是否分镜转写模式（源：isShotTranscript(Map)：读 meta.generateMode）。 */
export function isShotTranscriptMeta(meta: JsonMap | null | undefined): boolean {
  if (!meta) {
    return false;
  }
  const value = meta['generateMode'];
  return isShotTranscriptMode(value === null || value === undefined ? null : String(value));
}

/**
 * 发给 MediaKit video-understand 的完整 prompt。
 *
 * @param scenes     分镜（含 id/name/range/startTime/endTime）
 * @param asrText    口播 ASR，超长截断
 * @param scriptHint 模板剧本摘录，超长截断
 */
export function buildUnderstandPrompt(
  scenes: JsonMap[] | null,
  asrText: string | null,
  scriptHint: string | null,
): string {
  let sb = UNDERSTAND_PROMPT_STYLE + UNDERSTAND_CAST_RULES;
  if (!scenes || scenes.length === 0) {
    sb += '分镜不可用，请只根据片头至多15秒判断主角。';
  } else {
    sb += '对照分镜（含秒数）：';
    for (const scene of scenes) {
      sb += String(scene['id'] ?? '') + ' ' + String(scene['name'] ?? '') + ' ' + String(scene['range'] ?? '');
      const start = scene['startTime'];
      const end = scene['endTime'];
      if (start !== null && start !== undefined || end !== null && end !== undefined) {
        sb += '(' + String(start) + '-' + String(end) + 's)';
      }
      sb += '; ';
    }
  }
  const asr = clipText(asrText, ASR_CLIP_MAX);
  if (isNotBlank(asr)) {
    sb += '口播ASR（用于判断谁在说话）：' + asr + '。';
  }
  const script = clipText(scriptHint, SCRIPT_CLIP_MAX);
  if (isNotBlank(script)) {
    sb += '模板剧本摘录（{name}即品牌主角）：' + script + '。';
  }
  sb += UNDERSTAND_JSON_TAIL;
  return sb;
}

/**
 * 提交 Seedance 前的最终 prompt：用户/模板底稿 + 按时长截断后的分镜/口播 + 硬约束（源：buildGeneratePrompt）。
 * v1 的 drama 链路不使用它（用的是 seedance-prompt），保留是为了 phase 2 接旧 ref_video 模式时口径不变。
 */
export function buildGeneratePrompt(
  basePrompt: string | null,
  clippedMeta: JsonMap | null,
  durationD: number,
  uploadedPortraits: number,
  castLabels: string[],
): string {
  const rounded = Math.round(durationD);
  let sb = PROMPT_LIMIT_NOTICE + '\n';
  sb += blankToDefault(basePrompt, DEFAULT_RECOMMENDED_PROMPT).trim();
  if (isBlank(sb)) {
    sb += DEFAULT_RECOMMENDED_PROMPT;
  }
  const scenesObj = clippedMeta ? clippedMeta['scenes'] : null;
  if (Array.isArray(scenesObj) && scenesObj.length > 0) {
    sb += `\n场景结构（仅 0–${rounded} 秒）：`;
    for (const raw of scenesObj) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const scene = raw as JsonMap;
      const id = scene['id'] ?? '';
      const name = scene['name'] ?? '';
      const range = scene['range'] ?? '';
      sb += ` ${String(id)}:${String(name)}(${String(range)})`;
    }
  }
  const asr = clippedMeta ? clippedMeta['asrText'] : null;
  if (asr !== null && asr !== undefined && isNotBlank(String(asr))) {
    sb += `\n口播语义参考（仅使用 0–${rounded} 秒）：` + String(asr).trim();
  }
  sb += `\n硬约束：成片约 ${rounded} 秒，勿延伸 ${rounded} 秒之后的内容。`;
  if (uploadedPortraits > 0) {
    sb += `\n成片保持 ${uploadedPortraits} 位主角`;
    if (castLabels.length > 0) {
      sb += `（${castLabels.join('、')}）`;
    }
    sb += `，已提供 ${uploadedPortraits} 张人像参考。`;
  }
  return sb.trim();
}

/** 截断辅助（源：clipText：去空白、压换行为空格、按字符数硬截）。 */
function clipText(text: string | null, max: number): string {
  if (isBlank(text)) {
    return '';
  }
  const t = (text as string).trim().replace(/\n/g, ' ');
  return t.length <= max ? t : t.slice(0, max);
}
