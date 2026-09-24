/**
 * 火山方舟 Ark —— Seedance 视频生成适配层（交接包规格 §6.2）。
 *
 * **请求体形状以源仓库 `framework/ai/core/model/doubao/api/DoubaoVideoApi.java` 为准**（已逐字段核对，不臆造）：
 * - POST {base}/contents/generations/tasks；GET {base}/contents/generations/tasks/{id}
 * - content 是数组：先 `{type:'text'}`，再 `{type:'image_url', image_url:{url}, role:'reference_image'}`，
 *   再 `{type:'audio_url', audio_url:{url}, role:'reference_audio'}`，可选 `{type:'video_url', ..., role:'reference_video'}`
 * - 顶层参数：model / ratio / duration / resolution / generate_audio / return_last_frame / watermark
 * - `return_last_frame=true` 时查询返回 `content.last_frame_url`（串行链式分段用，phase 2）
 *
 * 两条来自规格的红线：
 * - **drama 新版出片不传 reference_video**（只有旧版 ref_video 模式才传），别搞混（§6.2 / §8.3）；
 * - `resolution`/`ratio` 的取值**按 SEEDANCE_MODEL 实测**：客户端白名单通过 ≠ 目标模型支持（§11-2），
 *   因此本实现只在显式配置时才带 resolution。
 */

import type { JsonMap } from '../util/maps.js';
import { isBlank, isNotBlank, maxLength, trim } from '../util/text.js';

/** 官方 base（源实现刻意忽略外部传入 base，视频 API 只认这个标准地址）。 */
export const ARK_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const CREATE_PATH = '/contents/generations/tasks';
const TASK_PATH = '/contents/generations/tasks/';

/** 提交超时：请求体里带多张参考图，给足 2 分钟。 */
const SUBMIT_TIMEOUT_MS = 120_000;
/** 查询超时：轮询高频，30s 足够。 */
const QUERY_TIMEOUT_MS = 30_000;

/** 归一化后的任务状态（源：STATUS_SUCCEEDED/FAILED/PROCESSING + 文档的 queued/running/cancelled/expired）。 */
export type SeedanceStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/** 提交入参（core 内部契约，不直接暴露给 HTTP 层）。 */
export interface SeedanceSubmitReq {
  prompt: string;
  /** 成片秒数（调用方已钳到 [4,15]） */
  durationSec: number;
  ratio: string;
  /** 上一段尾帧（方舟 asset:// 或 ark-acg 原始 last-frame）；v1 单段一般留空 */
  firstFrameUrl?: string;
  /** 人像 asset:// 列表（顺序即 prompt 里「第 N 张参考图」） */
  portraits: string[];
  /** 音色 asset://（drama 链路只吃 asset://） */
  audioUrl?: string;
  /** 参照视频：**v1/drama 链路留空**，仅为旧 ref_video 模式预留 */
  referenceVideo?: string;
  /** 是否要求返回尾帧（链式生段用） */
  returnLastFrame?: boolean;
  /** 可选分辨率档；留空不传 */
  resolution?: string;
}

/** 查询结果。 */
export interface SeedanceQueryResult {
  status: SeedanceStatus;
  videoUrls: string[];
  /** 链式生段用（phase 2）；return_last_frame=true 时返回 */
  lastFrameUrl?: string;
  error?: string;
  /** 模型回显的 token 用量（仅记录，不做计费） */
  totalTokens?: number;
}

/** Seedance 契约面。 */
export interface Seedance {
  submit(req: SeedanceSubmitReq): Promise<{ taskId: string }>;
  query(taskId: string): Promise<SeedanceQueryResult>;
}

/** 方舟调用错误（消息里不含 Key）。 */
export class SeedanceError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'SeedanceError';
    this.status = status;
  }
}

/** 方舟连接参数。 */
export interface SeedanceOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  resolution: string;
}

/** 官方方舟实现（fetch 可注入便于单测）。 */
export class VolcengineSeedance implements Seedance {
  private readonly options: SeedanceOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SeedanceOptions, fetchImpl: typeof fetch = fetch) {
    this.options = options;
    this.fetchImpl = fetchImpl;
  }

  async submit(req: SeedanceSubmitReq): Promise<{ taskId: string }> {
    const body = buildContentGenerationBody(req, this.options);
    const json = await this.execute('POST', CREATE_PATH, body, SUBMIT_TIMEOUT_MS);
    const taskId = readString(json, ['id'], ['task_id'], ['output', 'task_id']);
    // 用 `!taskId` 而非 isBlank：能让 TS 把类型从 string | undefined 收窄到 string
    if (!taskId) {
      throw new SeedanceError(`方舟未返回任务 id：${maxLength(JSON.stringify(json), 400)}`);
    }
    return { taskId };
  }

  async query(taskId: string): Promise<SeedanceQueryResult> {
    const id = trim(taskId);
    if (isBlank(id)) {
      return { status: 'failed', videoUrls: [], error: 'taskId 为空' };
    }
    let json: JsonMap;
    try {
      json = await this.execute('GET', TASK_PATH + encodeURIComponent(id), null, QUERY_TIMEOUT_MS);
    } catch (ex) {
      return { status: 'failed', videoUrls: [], error: (ex as Error).message };
    }
    return parseTaskResponse(json);
  }

  private async execute(
    method: 'GET' | 'POST',
    path: string,
    body: JsonMap | null,
    timeoutMs: number,
  ): Promise<JsonMap> {
    const url = this.options.baseUrl + path;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (method === 'POST') {
      init.body = JSON.stringify(body ?? {});
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (ex) {
      throw new SeedanceError(`方舟请求失败 ${method} ${path}: ${(ex as Error).message}`);
    }
    const text = await response.text();
    // 规格 §11-3：中转站常对未知路径返回 200 + HTML，必须在解析前拦住，否则会误判成功
    const trimmed = text.trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      throw new SeedanceError(
        `方舟返回非 JSON（HTTP ${response.status}，疑似中转站拦截页）：${maxLength(text, 200)}`,
        response.status,
      );
    }
    let json: JsonMap;
    try {
      json = JSON.parse(text) as JsonMap;
    } catch (ex) {
      throw new SeedanceError(`方舟 JSON 解析失败：${(ex as Error).message}`, response.status);
    }
    if (!response.ok) {
      throw new SeedanceError(`方舟 HTTP ${response.status}: ${extractError(json)}`, response.status);
    }
    // 200 但带 error 体（部分代理行为）：交给上层按失败处理
    if (json['error']) {
      throw new SeedanceError(`方舟返回错误：${extractError(json)}`, response.status);
    }
    return json;
  }
}

/**
 * 构造请求体（源：DoubaoVideoApi.buildContentGenerationBody + presetAvatarRequest 的 content 顺序）。
 * 单独抽出为纯函数，方便「提交前 payload 长什么样」直接被单测断言。
 */
export function buildContentGenerationBody(req: SeedanceSubmitReq, options: SeedanceOptions): JsonMap {
  const contents: JsonMap[] = [];
  // 1. 文本 prompt（永远是第一个 content 项）
  contents.push({ type: 'text', text: req.prompt });

  // 2. 参考图：上一段尾帧排首位（prompt 里用「第 1 张参考图」引用），随后是人像
  const images: string[] = [];
  if (isNotBlank(req.firstFrameUrl)) {
    images.push(trim(req.firstFrameUrl));
  }
  for (const portrait of req.portraits) {
    if (isNotBlank(portrait)) {
      images.push(trim(portrait));
    }
  }
  for (const url of images) {
    contents.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
  }

  // 3. 参考音频（音色克隆/口型同步）
  if (isNotBlank(req.audioUrl)) {
    contents.push({ type: 'audio_url', audio_url: { url: trim(req.audioUrl) }, role: 'reference_audio' });
  }

  // 4. 参照视频：**drama 新版不传**，仅旧 ref_video 模式使用
  if (isNotBlank(req.referenceVideo)) {
    contents.push({ type: 'video_url', video_url: { url: trim(req.referenceVideo) }, role: 'reference_video' });
  }

  const body: JsonMap = {
    model: options.model,
    content: contents,
    ratio: isNotBlank(req.ratio) ? req.ratio : '9:16',
    duration: req.durationSec,
    // generate_audio 必须为 true 才会产出音频；传入 reference_audio 时以其为语音源（源注释）
    generate_audio: true,
    watermark: false,
  };
  if (req.returnLastFrame !== undefined) {
    body['return_last_frame'] = req.returnLastFrame;
  }
  // resolution 仅在显式配置时带（避免「白名单通过但模型拒绝」）
  const resolution = isNotBlank(req.resolution) ? trim(req.resolution) : trim(options.resolution);
  if (isNotBlank(resolution)) {
    body['resolution'] = resolution;
  }
  return body;
}

/**
 * 解析查询响应（源：parseVideoTaskResponse + extractVideoUrlFromContent + applyLastFrameUrl）。
 * 兼容三种形态：官方 `{status, content:{video_url,last_frame_url}}`、数组型 content、以及 `output.*`。
 */
export function parseTaskResponse(root: JsonMap): SeedanceQueryResult {
  const result: SeedanceQueryResult = { status: 'running', videoUrls: [] };
  const errorText = extractError(root);
  const rawStatus = (readString(root, ['status'], ['output', 'task_status'], ['data', 'status']) ?? '').toLowerCase();

  const urls: string[] = [];
  collectVideoUrls(root, urls);
  result.videoUrls = urls;

  const lastFrame = readString(root, ['content', 'last_frame_url'], ['last_frame_url'], ['data', 'content', 'last_frame_url']);
  if (isNotBlank(lastFrame)) {
    result.lastFrameUrl = lastFrame;
  }

  const usage = pickObject(root, ['usage']) ?? pickObject(pickObject(root, ['data']) ?? {}, ['usage']);
  if (usage) {
    const total = Number(usage['total_tokens']);
    if (Number.isFinite(total)) {
      result.totalTokens = total;
    }
  }

  if (rawStatus === 'succeeded' || rawStatus === 'success' || rawStatus === 'completed') {
    // 成功但没拿到视频地址：视为失败（源实现同样要求 resultUrl 非空）
    result.status = urls.length > 0 ? 'succeeded' : 'failed';
    if (urls.length === 0) {
      result.error = errorText || '任务成功但未返回视频地址';
    }
    return result;
  }
  if (rawStatus === 'failed' || rawStatus === 'cancelled' || rawStatus === 'canceled' || rawStatus === 'expired') {
    result.status = 'failed';
    result.error = errorText || '生成失败';
    return result;
  }
  if (rawStatus === 'queued' || rawStatus === 'pending') {
    result.status = 'queued';
    return result;
  }
  if (rawStatus.length === 0 && errorText.length > 0) {
    result.status = 'failed';
    result.error = errorText;
    return result;
  }
  // running / processing / 其它未知态一律按在途处理，交给上层超时判定兜底
  result.status = 'running';
  return result;
}

/** 递归收集视频地址：content.video_url / content[]（type 含 video）/ output.video_url / result_url。 */
function collectVideoUrls(node: JsonMap | JsonMap[], out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectVideoUrls(item, out);
    }
    return;
  }
  const type = String(node['type'] ?? '');
  const videoUrl = node['video_url'];
  if (typeof videoUrl === 'string' && isNotBlank(videoUrl)) {
    pushUnique(out, videoUrl);
  } else if (videoUrl && typeof videoUrl === 'object') {
    const inner = (videoUrl as JsonMap)['url'];
    if (typeof inner === 'string' && isNotBlank(inner)) {
      pushUnique(out, inner);
    }
  }
  const resultUrl = node['result_url'];
  if (typeof resultUrl === 'string' && isNotBlank(resultUrl) && (type.length === 0 || type.includes('video'))) {
    pushUnique(out, resultUrl);
  }
  // type=video 的数组元素即使地址在 url 字段里也要收（弱规范代理常见）
  if (type.includes('video')) {
    const url = node['url'];
    if (typeof url === 'string' && isNotBlank(url)) {
      pushUnique(out, url);
    }
  }
  for (const key of ['content', 'output', 'data', 'result']) {
    const child = node[key];
    if (Array.isArray(child)) {
      collectVideoUrls(child as JsonMap[], out);
    } else if (child && typeof child === 'object') {
      collectVideoUrls(child as JsonMap, out);
    }
  }
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}

/** 读取嵌套路径。 */
function readPath(node: unknown, pathArr: string[]): unknown {
  let current = node;
  for (const key of pathArr) {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      current = (current as JsonMap)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * 按多个候选键路径取第一个非空字符串。
 * 方舟与各类代理的字段位置不统一（id / task_id / output.task_id），一次查询兼容多种形状。
 */
function readString(node: JsonMap, ...paths: string[][]): string | undefined {
  for (const pathArr of paths) {
    const value = readPath(node, pathArr);
    if (typeof value === 'string' && isNotBlank(value)) {
      return value.trim();
    }
  }
  return undefined;
}

/** 取嵌套对象。 */
function pickObject(node: JsonMap, pathArr: string[]): JsonMap | null {
  const value = readPath(node, pathArr);
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonMap) : null;
}

/** 提取错误信息：兼容 {error:{code,message}} 与 {fail_reason}。 */
function extractError(root: JsonMap): string {
  const error = root['error'];
  if (typeof error === 'string' && isNotBlank(error)) {
    return maxLength(error, 400);
  }
  if (error && typeof error === 'object') {
    const map = error as JsonMap;
    const code = String(map['code'] ?? '').trim();
    const message = String(map['message'] ?? '').trim();
    return maxLength([code, message].filter(Boolean).join(' '), 400) || maxLength(JSON.stringify(map), 400);
  }
  const failReason = root['fail_reason'];
  if (typeof failReason === 'string' && isNotBlank(failReason)) {
    return maxLength(failReason, 400);
  }
  return '';
}

/** 供 routes 层做「提交前自检」用的最小可用判定：不联网，只查配置。 */
export function seedanceConfigHint(options: SeedanceOptions): string {
  if (isBlank(options.apiKey)) {
    return 'ARK_API_KEY 未配置';
  }
  if (isBlank(options.model)) {
    return 'SEEDANCE_MODEL 未配置';
  }
  return '';
}
