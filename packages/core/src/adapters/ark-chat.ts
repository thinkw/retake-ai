/**
 * 方舟 Chat Completions 适配层（只服务一件事：prompt 超长时压缩画面块）。
 *
 * 源实现 `DramaPromptLengthCompressor.callChat` 走的是 SaaS 侧「模型配置 + Token 钱包」那一套
 * （AiModelService / AiVideoTokenWalletService），本地版按规格 §2.3 砍掉计费，
 * 只保留「拿 ARK_API_KEY 直连官方 chat 接口」的最小实现；未配置 ARK_CHAT_MODEL 时整个压缩步骤跳过。
 */

import type { JsonMap } from '../util/maps.js';
import { isBlank, maxLength, trim } from '../util/text.js';

/** chat 调用器（core 只依赖函数签名，单测直接注入假实现）。 */
export type ChatCompleter = (prompt: string) => Promise<string>;

/** 连接参数。 */
export interface ArkChatOptions {
  apiKey: string;
  baseUrl: string;
  /** 对话模型 ID（如 doubao-seed-1-6-...）；留空表示不启用 LLM 压缩 */
  model: string;
  maxTokens?: number;
}

const CHAT_TIMEOUT_MS = 60_000;

/**
 * 构造 chat 调用器。
 *
 * @returns 未配置 model 时返回 `null`——调用方（压缩器）据此走「本地确定性压缩」兜底，
 *          这比默默调一个贵的模型更符合个人本地版定位。
 */
export function createArkChat(options: ArkChatOptions, fetchImpl: typeof fetch = fetch): ChatCompleter | null {
  if (isBlank(options.model) || isBlank(options.apiKey)) {
    return null;
  }
  return async (prompt: string): Promise<string> => {
    const body: JsonMap = {
      model: trim(options.model),
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    };
    if (options.maxTokens && options.maxTokens > 0) {
      body['max_tokens'] = options.maxTokens;
    }
    const response = await fetchImpl(`${options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    const text = await response.text();
    const head = text.trimStart();
    if (!head.startsWith('{')) {
      // 规格 §11-3：200 + HTML 的假成功必须显式识别
      throw new Error(`方舟 chat 返回非 JSON（HTTP ${response.status}）：${maxLength(text, 160)}`);
    }
    const json = JSON.parse(text) as JsonMap;
    if (!response.ok) {
      throw new Error(`方舟 chat HTTP ${response.status}：${maxLength(text, 240)}`);
    }
    const choices = Array.isArray(json['choices']) ? (json['choices'] as unknown[]) : [];
    const first = choices[0];
    const message = first && typeof first === 'object' ? (first as JsonMap)['message'] : undefined;
    const content = message && typeof message === 'object' ? (message as JsonMap)['content'] : undefined;
    if (typeof content !== 'string' || isBlank(content)) {
      throw new Error('方舟 chat 返回为空');
    }
    return content.trim();
  };
}
