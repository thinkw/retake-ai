/**
 * AI MediaKit 适配层（交接包规格 §6.1）。
 *
 * 对照源实现：`VolcengineMediaKitHttpClient.java`（HTTP 约定）+ `VolcengineMediaKitClient.java`
 * 的 `submitToolTask` / `queryToolTask` / `queryAsrSubtitles` 映射逻辑。
 *
 * 关键约定（照搬，不要臆造）：
 * - 鉴权：`Authorization: Bearer {MEDIKIT_API_KEY}`
 * - 异步提交：POST {base}/api/v1/tools/{name} → `task_id`
 * - 查询：GET {base}/api/v1/tasks/{task_id} → `running | completed | failed`
 * - 图像同步：POST {base}/api/v1/tools-sync/{name} → 直接带 `result`
 * - `media_output_destination` **只有异步工具支持**：同步图像工具传了会 400
 *   （源注释：实测 evaluate-image-quality / enhance-image 报 sync api does not support media_output_destination）
 * - 查询映射只给 `video_url`；OCR 字幕与 drama 的 `result_url` 必须走 `getTask` 拿原始返回（规格 §6.1 注意事项）
 */

import type { JsonMap } from '../util/maps.js';
import { listOfMaps, num, strOf } from '../util/maps.js';
import { isBlank, isNotBlank, maxLength, trim } from '../util/text.js';
import { ASR_SUBTITLES, CONCAT_VIDEO, QUERY_TASK } from './mediakit-paths.js';

/** 单次 HTTP 超时（源实现 hutool timeout=120_000）。 */
const HTTP_TIMEOUT_MS = 120_000;
/** UA 标识：便于在云端工单里定位调用来源。 */
const USER_AGENT = 'retake-ai/0.1 (local)';

/** MediaKit 连接参数（从 AppConfig.mediakit 传入，core 不直接读 env）。 */
export interface MediaKitOptions {
  apiKey: string;
  baseUrl: string;
  /** tos://桶/目录：配置后产物才是长期地址（规格 §5 / §11-1） */
  outputDestination: string;
  /** tos:// → https 端点（不含桶名） */
  tosPublicEndpoint: string;
  queueId: string;
}

/** `queryToolTask` 的映射结果（源：VolcengineMediaKitClient.queryToolTask 的 Map 结构）。 */
export interface ToolTaskResult {
  status: string;
  /** 视频产物（tos:// 已转 https） */
  videoUrl?: string;
  /** 未转换的原始产物地址（tos://）：下一级工具吃它更稳（源注释：https 公网地址会让 output_destination 回退 VOD） */
  rawVideoUrl?: string;
  /** 音频类工具（trim-audio）产物 */
  audioUrl?: string;
  /** drama-script 等「返回包」工具的 result_url */
  resultUrl?: string;
  /** 抽帧类工具（extract-frames）产物 */
  keyframes?: string[];
  /** video-understand-router 原文 */
  understandText?: string;
  error?: string;
}

/** ASR 查询结果（源：queryAsrSubtitles）。 */
export interface AsrTaskResult {
  status: string;
  asrSubtitles: JsonMap[];
  asrText: string;
  error?: string;
}

/** MediaKit 能力面（core 只依赖这个接口，便于单测替换）。 */
export interface MediaKit {
  /** 异步提交：POST {base}/api/v1/tools/{name}，返回 task_id；入参也可传完整路径 */
  submitToolTask(pathOrName: string, body: JsonMap): Promise<string>;
  /** 查询：GET {base}/api/v1/tasks/{task_id}（映射后的常用字段） */
  queryToolTask(taskId: string): Promise<ToolTaskResult>;
  /** 查询原始返回（OCR subtitles / drama result_url 必须用它） */
  getTask(taskId: string): Promise<JsonMap | null>;
  /** 图像同步：POST {base}/api/v1/tools-sync/{name} → 直接带 result */
  syncTool(pathOrName: string, body: JsonMap): Promise<JsonMap>;
  /** 判定产物是否临时 VOD 预览链 */
  isEphemeralUrl(url: string): boolean;
  /** tos:// → 公网 https（未配置端点时原样返回） */
  tosToHttpUrl(url: string): string;
  /** 便捷：仅提交 ASR */
  submitAsrSubtitles(videoUrl: string): Promise<string>;
  /** 便捷：查询 ASR 结果 */
  queryAsrSubtitles(taskId: string): Promise<AsrTaskResult>;
  /** 便捷：仅提交拼接（硬切、按顺序首尾相连） */
  submitConcatVideo(videoUrls: string[]): Promise<string>;
}

/** 临时链判定（源：MediaKitArtifactStore.isEphemeralMediaUrl；空地址也按「不可用」处理）。 */
export function isEphemeralMediaUrl(url: string | null | undefined): boolean {
  if (isBlank(url)) {
    return true;
  }
  const lower = (url as string).toLowerCase();
  return lower.includes('preview=1') || lower.includes('volcvideo.com') || lower.includes('auth_key=');
}

/** 「URL 不合法」类错误判定（源：MediaKitArtifactStore.isUnvalidMediaUrlError，用于 22020001 重试一次）。 */
export function isUnvalidMediaUrlError(error: string | null | undefined): boolean {
  if (isBlank(error)) {
    return false;
  }
  const lower = (error as string).toLowerCase();
  return lower.includes('22020001') || lower.includes('unvalid') || lower.includes('is invalid');
}

/** 把 `/api/v1/tools/xxx` 这类完整路径或裸工具名统一成请求路径。 */
function normalizeToolPath(pathOrName: string): string {
  const value = trim(pathOrName);
  if (value.startsWith('/')) {
    return value;
  }
  return `/api/v1/tools/${value}`;
}

/** MediaKit HTTP 错误：带上 status / code / message，且**必须**已由调用方做过 Key 掩码（不含请求头）。 */
export class MediaKitError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 0, code = '') {
    super(message);
    this.name = 'MediaKitError';
    this.status = status;
    this.code = code;
  }
}

/** 火山 MediaKit 实现：Bearer + JSON（fetch 可注入，便于单测）。 */
export class VolcengineMediaKit implements MediaKit {
  private readonly options: MediaKitOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MediaKitOptions, fetchImpl: typeof fetch = fetch) {
    this.options = options;
    this.fetchImpl = fetchImpl;
  }

  /** 异步提交工具任务，立即返回 task_id（不等待完成）。 */
  async submitToolTask(pathOrName: string, body: JsonMap): Promise<string> {
    const path = normalizeToolPath(pathOrName);
    const json = await this.execute('POST', path, this.decorateBody(path, body));
    const taskId = strOf(json['task_id']) || strOf(readNested(json, ['result', 'task_id']));
    if (isBlank(taskId)) {
      // 源同款提示：拿到空 task_id 通常是把同步接口当异步调了
      throw new MediaKitError(`MediaKit 未返回 task_id（该工具可能是同步接口）: ${path}`);
    }
    return taskId;
  }

  /** 查询任务并映射常用字段（源：queryToolTask）。 */
  async queryToolTask(taskId: string): Promise<ToolTaskResult> {
    const task = await this.getTaskOrEmpty(taskId);
    const result: ToolTaskResult = { status: strOf(task['status']) || 'queued' };
    const videoUrl = this.firstResultStr(task, 'video_url');
    if (isNotBlank(videoUrl)) {
      result.videoUrl = videoUrl;
    }
    const rawVideoUrl = this.rawResultStr(task, 'video_url');
    if (isNotBlank(rawVideoUrl)) {
      result.rawVideoUrl = rawVideoUrl;
    }
    const audioUrl = this.firstResultStr(task, 'audio_url');
    if (isNotBlank(audioUrl)) {
      result.audioUrl = audioUrl;
    }
    const resultUrl = this.firstResultStr(task, 'result_url') || this.firstResultStr(task, 'resultUrl');
    if (isNotBlank(resultUrl)) {
      result.resultUrl = resultUrl;
    }
    const frames = this.parseKeyframes(task);
    if (frames.length > 0) {
      result.keyframes = frames;
    }
    const understandText = this.parseUnderstandText(task);
    if (isNotBlank(understandText)) {
      result.understandText = understandText;
    }
    const error = task['error'];
    if (error && typeof error === 'object') {
      const message = strOf((error as JsonMap)['message']) || JSON.stringify(error);
      result.error = message;
    } else if (typeof error === 'string' && isNotBlank(error)) {
      result.error = error;
    }
    return result;
  }

  /** 查询原始任务 JSON（源：VolcengineMediaKitHttpClient.getTask）。 */
  async getTask(taskId: string): Promise<JsonMap | null> {
    const id = trim(taskId);
    if (isBlank(id)) {
      return null;
    }
    return this.execute('GET', QUERY_TASK.replace('{task_id}', encodeURIComponent(id)), null);
  }

  /** 同步图像工具（tools-sync）：直接返回 result。 */
  async syncTool(pathOrName: string, body: JsonMap): Promise<JsonMap> {
    const value = trim(pathOrName);
    const path = value.startsWith('/') ? value : `/api/v1/tools-sync/${value}`;
    return this.execute('POST', path, this.decorateBody(path, body));
  }

  async submitAsrSubtitles(videoUrl: string): Promise<string> {
    return this.submitToolTask(ASR_SUBTITLES, { video_url: videoUrl });
  }

  async queryAsrSubtitles(taskId: string): Promise<AsrTaskResult> {
    const task = await this.getTaskOrEmpty(taskId);
    const status = strOf(task['status']) || 'queued';
    const out: AsrTaskResult = { status, asrSubtitles: [], asrText: '' };
    const error = task['error'];
    if (error && typeof error === 'object') {
      out.error = strOf((error as JsonMap)['message']) || JSON.stringify(error);
    }
    if (status.toLowerCase() === 'completed' || status.toLowerCase() === 'succeeded' || status.toLowerCase() === 'success') {
      out.asrSubtitles = this.parseAsrSubtitles(task);
      out.asrText = joinAsrText(out.asrSubtitles);
    }
    return out;
  }

  async submitConcatVideo(videoUrls: string[]): Promise<string> {
    return this.submitToolTask(CONCAT_VIDEO, { video_urls: videoUrls });
  }

  isEphemeralUrl(url: string): boolean {
    return isEphemeralMediaUrl(url);
  }

  tosToHttpUrl(url: string): string {
    return tosToHttpUrl(url, this.options.tosPublicEndpoint);
  }

  // ———————————————————— 内部 ————————————————————

  /** 查询失败（taskId 过期/不存在）时返回空对象而非抛错：由状态机按「未知状态」处理并走超时判失败。 */
  private async getTaskOrEmpty(taskId: string): Promise<JsonMap> {
    try {
      return (await this.getTask(taskId)) ?? {};
    } catch (ex) {
      return { status: 'failed', error: { message: (ex as Error).message } };
    }
  }

  /** 统一注入 queue_id / media_output_destination（源：VolcengineMediaKitHttpClient.postTool）。 */
  private decorateBody(path: string, body: JsonMap): JsonMap {
    const payload: JsonMap = { ...body };
    if (isNotBlank(this.options.queueId) && payload['queue_id'] === undefined) {
      payload['queue_id'] = this.options.queueId;
    }
    // 产物直存仅异步工具支持：同步图像工具（/tools-sync/）传该参数会 400
    if (
      isNotBlank(this.options.outputDestination) &&
      !path.includes('/tools-sync/') &&
      payload['media_output_destination'] === undefined
    ) {
      payload['media_output_destination'] = this.options.outputDestination;
    }
    return payload;
  }

  private async execute(method: 'GET' | 'POST', path: string, body: JsonMap | null): Promise<JsonMap> {
    const url = this.options.baseUrl + path;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (ex) {
      throw new MediaKitError(`MediaKit 请求失败 ${method} ${path}: ${(ex as Error).message}`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new MediaKitError(`MediaKit HTTP ${response.status}: ${extractErrorMessage(text)}`, response.status);
    }
    // 规格 §11-3：SPA 型中转站对未知路径返回 200 + HTML，直接 JSON 解析会误判成功
    const looksJson = text.trimStart().startsWith('{') || text.trimStart().startsWith('[');
    if (!looksJson) {
      throw new MediaKitError(
        `MediaKit 返回非 JSON（疑似中转站/网关拦截页）${method} ${path}: ${maxLength(text, 200)}`,
        response.status,
      );
    }
    let json: JsonMap;
    try {
      json = JSON.parse(text) as JsonMap;
    } catch (ex) {
      throw new MediaKitError(`MediaKit JSON 解析失败: ${(ex as Error).message}`, response.status);
    }
    // 源约定：非 2xx 且 success=false 才判错；2xx 带 error 的响应交给状态机识别
    if (json['success'] === false && json['result'] === undefined) {
      throw new MediaKitError(`MediaKit 业务失败: ${extractErrorMessage(text)}`, response.status);
    }
    return json;
  }

  private resultObj(task: JsonMap): JsonMap | null {
    const result = task['result'];
    return result && typeof result === 'object' && !Array.isArray(result) ? (result as JsonMap) : null;
  }

  /** result.<field> 且 tos:// 已转 https（源：firstResultStr）。 */
  private firstResultStr(task: JsonMap, field: string): string {
    const raw = this.rawResultStr(task, field);
    return isNotBlank(raw) ? this.tosToHttpUrl(raw) : '';
  }

  /** result.<field> 原始值（不转换协议，源：rawVideoUrl 的用途）。 */
  private rawResultStr(task: JsonMap, field: string): string {
    const result = this.resultObj(task);
    return result ? strOf(result[field]) : '';
  }

  /** result.snapshots[].image_url（源：parseKeyframes）。 */
  private parseKeyframes(task: JsonMap): string[] {
    const result = this.resultObj(task);
    const snapshots = Array.isArray(result?.['snapshots']) ? (result?.['snapshots'] as unknown[]) : [];
    const frames: string[] = [];
    for (const item of snapshots) {
      if (item && typeof item === 'object') {
        const url = strOf((item as JsonMap)['image_url']);
        if (isNotBlank(url)) {
          frames.push(url);
        }
      }
    }
    return frames;
  }

  /** result.contents[0] / result.content（源：parseUnderstandText）。 */
  private parseUnderstandText(task: JsonMap): string {
    const result = this.resultObj(task);
    if (!result) {
      return '';
    }
    const contents = Array.isArray(result['contents']) ? (result['contents'] as unknown[]) : [];
    if (contents.length > 0) {
      return String(contents[0]);
    }
    return strOf(result['content']);
  }

  /**
   * result.subtitles[] → {startTime,endTime,text}
   * （源：parseAsrSubtitles —— MediaKit 的字段是 subtitle_text/start_time/end_time，统一摊平成内部命名）
   */
  private parseAsrSubtitles(task: JsonMap): JsonMap[] {
    const result = this.resultObj(task);
    const raw = result?.['subtitles'];
    const out: JsonMap[] = [];
    for (const item of listOfMaps(raw)) {
      const text = strOf(item['subtitle_text']) || strOf(item['text']);
      if (isBlank(text)) {
        continue;
      }
      out.push({
        startTime: num(item, 'start_time', 0),
        endTime: num(item, 'end_time', 0),
        text,
      });
    }
    return out;
  }
}

/** ASR 文本拼接（源：joinAsrText，用空格连接）。 */
function joinAsrText(subtitles: JsonMap[]): string {
  const parts: string[] = [];
  for (const sub of subtitles) {
    const text = strOf(sub['text']);
    if (isNotBlank(text)) {
      parts.push(text);
    }
  }
  return parts.join(' ');
}

/**
 * tos://bucket/path → https://bucket.{endpoint}/path（源：MediaKitArtifactStore.tosToHttpUrl）。
 * 未配置端点时原样返回，避免拼出错误域名。
 */
export function tosToHttpUrl(url: string | null | undefined, endpoint: string): string {
  const value = trim(url);
  if (!value.startsWith('tos://')) {
    return value;
  }
  if (isBlank(endpoint)) {
    return value;
  }
  const rest = value.slice('tos://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) {
    return value;
  }
  const bucket = rest.slice(0, slash);
  const path = rest.slice(slash);
  return `https://${bucket}.${trim(endpoint)}${path}`;
}

/** 读取嵌套字段（仅两层，够用）。 */
function readNested(json: JsonMap, keys: [string, string]): unknown {
  const outer = json[keys[0]];
  if (outer && typeof outer === 'object') {
    return (outer as JsonMap)[keys[1]];
  }
  return undefined;
}

/** 从响应体里抽错误信息（兼容 {error:{code,message}} / {message} / 裸文本）。 */
function extractErrorMessage(text: string): string {
  try {
    const json = JSON.parse(text) as JsonMap;
    const error = json['error'];
    if (error && typeof error === 'object') {
      const code = strOf((error as JsonMap)['code']);
      const message = strOf((error as JsonMap)['message']);
      return maxLength([code, message].filter(Boolean).join(' '), 400) || maxLength(text, 400);
    }
    if (isNotBlank(strOf(json['message']))) {
      return maxLength(strOf(json['message']), 400);
    }
  } catch {
    // 非 JSON：走下面兜底
  }
  return maxLength(text, 400);
}
