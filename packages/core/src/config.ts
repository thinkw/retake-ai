/**
 * 配置与环境变量（交接包规格 §5）。
 *
 * 设计要点：
 * 1. **自带云 Key（BYO）**：任一必填项缺失时，抛出的错误信息本身就是「分步开通指引」，
 *    让用户不必去翻文档就知道去哪儿建 Key、要勾哪些权限（规格 §5 明确要求写进错误里）。
 * 2. **不假设 ffmpeg 在 PATH**：源项目踩过的坑（规格 §5 运行环境事实），这里必须配绝对路径并校验存在。
 * 3. **Key 只在本地 .env**：任何回显（日志 / /api/health）都必须走 {@link maskSecret}。
 * 4. 手写极简 .env 解析，不引入 dotenv 依赖：只支持 `KEY=VALUE` / `#` 注释 / 可选引号，
 *    已存在于 process.env 的变量不被覆盖（方便临时 `ARK_API_KEY=xxx pnpm start` 覆盖）。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildPaths, ensurePaths, resolveHome, type DataPaths } from './paths.js';
import { isBlank, trim } from './util/text.js';

/** 云开通指引（同时被 README 引用；改这里就等于改指引）。 */
export const SETUP_GUIDE = [
  '缺少的配置项可按下面步骤补齐（全部为用户自带 Key，只落本地 .env）：',
  '',
  '1) 火山方舟 Ark —— 用于 Seedance 视频生成',
  '   a. 打开 https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement 开通 Seedance 2.0 系列模型',
  '      （开通门槛：账户余额 > 200 元，或购买节省计划/资源包；见模型开通说明）',
  '   b. 打开 https://console.volcengine.com/ark/region:cn-beijing/apiKey 创建并复制「长效 API Key」→ 填入 ARK_API_KEY',
  '   c. 在模型广场复制视频模型 ID（形如 doubao-seedance-2-0-xxxxxx）→ 填入 SEEDANCE_MODEL',
  '   d. 建议 ARK_BASE_URL 保持官方直连；第三方中转站对未知路径会返回 200 + HTML，会让 JSON 解析误判成功',
  '',
  '2) AI MediaKit —— 用于 OCR / ASR / 字幕烧录 / drama-script 剧本还原 / 拼接',
  '   a. 打开 https://console.volcengine.com/mediakit 开通智能处理 AI MediaKit 并创建 API Key → 填入 MEDIKIT_API_KEY',
  '   b. 账号需具备服务关联角色 AmkServiceLinkedRole，否则 video-understand-router 等能力会报 AccessDenied/RoleNotExist',
  '   c. 强烈建议配置 MEDIKIT_OUTPUT_DEST（形如 tos://<你的桶名>/retake-ai/out）：',
  '      需要在 MediaKit 控制台单独授权「跨服务写」权限；不配置时产物只能拿到带 auth_key 的 VOD 预览链（24h 失效，',
  '      且难以作为下一步工具的入参），链路会在 trim/ocr/asr/burn 之间断裂',
  '   d. 若配置了 c，请同时填 TOS_PUBLIC_ENDPOINT（如 tos-cn-beijing.volces.com，不含桶名）以便 tos:// 转公网 https',
  '',
  '3) ffmpeg / ffprobe —— 本地确定性媒体操作（探测时长、必要时裁切、最终落盘校验）',
  '   本机通常不在 PATH，请在 .env 中填写 FFMPEG_BIN / FFPROBE_BIN 的绝对路径',
  '',
  '4) 人像与音色：Seedance 不接受「含真人人脸的普通 http 参考图」，',
  '   人像必须是方舟私域素材库的 asset://asset-xxx（先完成真人认证拿到 GroupId，再 CreateAsset）；',
  '   drama 链路的音色同样只吃 asset://（见 README「素材入云」一节）。',
].join('\n');

/** 配置错误：携带可直接展示给用户的开通指引。 */
export class ConfigError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`配置不完整，缺少：${missing.join(', ')}\n\n${SETUP_GUIDE}`);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

/** 加载工程根 `.env`（不覆盖已有环境变量）。 */
export function loadDotEnv(envFilePath = path.resolve(process.cwd(), '.env')): void {
  if (!existsSync(envFilePath)) {
    return;
  }
  let content: string;
  try {
    content = readFileSync(envFilePath, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去掉成对引号；未加引号时按字面量处理（Windows 路径写单反斜杠即可）
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key.length > 0 && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** 运行时配置（由 env 解析而来，core 内部只读这一份，便于单测注入）。 */
export interface AppConfig {
  /** 数据根与子目录 */
  paths: DataPaths;
  /** 方舟（Seedance 生成） */
  ark: {
    apiKey: string;
    baseUrl: string;
    model: string;
    /** 可选分辨率档（480p/720p/1080p）；留空不传，避免「白名单通过但模型不支持」 */
    resolution: string;
    /** 可选：prompt 超长压缩用的对话模型 */
    chatModel: string;
  };
  /** AI MediaKit */
  mediakit: {
    apiKey: string;
    baseUrl: string;
    /** media_output_destination（tos://桶/目录），配置后产物才是长期地址 */
    outputDestination: string;
    /** tos:// → https 的端点（不含桶名） */
    tosPublicEndpoint: string;
    queueId: string;
  };
  /** 本地 ffmpeg 绝对路径 */
  ffmpeg: {
    ffmpegBin: string;
    ffprobeBin: string;
  };
  server: {
    port: number;
    host: string;
  };
}

function envStr(key: string): string {
  return trim(process.env[key]);
}

function envInt(key: string, fallback: number): number {
  const raw = envStr(key);
  if (isBlank(raw)) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/**
 * 读取并校验配置。
 *
 * @param options.ensureDirs 是否顺手建好数据目录（服务启动时 true；单测可传 false）
 * @throws ConfigError 必填项缺失或 ffmpeg 路径不可用时抛出（错误里带开通指引）
 */
export function loadConfig(options: { ensureDirs?: boolean } = {}): AppConfig {
  const missing: string[] = [];
  const home = envStr('RETAKE_HOME');
  const arkApiKey = envStr('ARK_API_KEY');
  const seedanceModel = envStr('SEEDANCE_MODEL');
  const mediakitApiKey = envStr('MEDIKIT_API_KEY');
  const ffmpegBin = envStr('FFMPEG_BIN');
  const ffprobeBin = envStr('FFPROBE_BIN');

  if (isBlank(arkApiKey)) {
    missing.push('ARK_API_KEY');
  }
  if (isBlank(seedanceModel)) {
    missing.push('SEEDANCE_MODEL');
  }
  if (isBlank(mediakitApiKey)) {
    missing.push('MEDIKIT_API_KEY');
  }
  if (isBlank(ffmpegBin)) {
    missing.push('FFMPEG_BIN');
  }
  if (isBlank(ffprobeBin)) {
    missing.push('FFPROBE_BIN');
  }
  if (missing.length > 0) {
    throw new ConfigError(missing);
  }
  // 路径存在性校验：比「跑到某一步再 spawn ENOENT」更早暴露问题
  for (const [key, bin] of [
    ['FFMPEG_BIN', ffmpegBin],
    ['FFPROBE_BIN', ffprobeBin],
  ] as const) {
    if (!existsSync(bin)) {
      throw new ConfigError([`${key}（文件不存在：${bin}）`]);
    }
  }

  const paths = buildPaths(resolveHome(home));
  if (options.ensureDirs !== false) {
    ensurePaths(paths);
  }

  return {
    paths,
    ark: {
      apiKey: arkApiKey,
      // 规格 §5：建议直连官方方舟，中转站协议有差异
      baseUrl: (envStr('ARK_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, ''),
      model: seedanceModel,
      resolution: envStr('SEEDANCE_RESOLUTION'),
      chatModel: envStr('ARK_CHAT_MODEL'),
    },
    mediakit: {
      apiKey: mediakitApiKey,
      baseUrl: (envStr('MEDIKIT_BASE_URL') || 'https://mediakit.cn-beijing.volces.com').replace(/\/+$/, ''),
      outputDestination: envStr('MEDIKIT_OUTPUT_DEST'),
      tosPublicEndpoint: envStr('TOS_PUBLIC_ENDPOINT'),
      queueId: envStr('MEDIKIT_QUEUE_ID'),
    },
    ffmpeg: { ffmpegBin, ffprobeBin },
    server: {
      port: envInt('SERVER_PORT', 8787),
      host: envStr('SERVER_HOST') || '127.0.0.1',
    },
  };
}

/** Key 掩码：保留前 4 后 4，中间打星；短于 12 位则整体打星（/api/health 与错误回显必须走它）。 */
export function maskSecret(secret: string | undefined | null): string {
  const value = trim(secret);
  if (value.length === 0) {
    return '(未配置)';
  }
  if (value.length < 12) {
    return '*'.repeat(value.length);
  }
  return `${value.slice(0, 4)}${'*'.repeat(6)}${value.slice(-4)}`;
}

/** 配置的掩码视图（供 /api/health 回显，确认「加载了哪份配置」而不泄露 Key）。 */
export function maskedConfigView(config: AppConfig): JsonishRecord {
  return {
    retakeHome: config.paths.home,
    ark: {
      baseUrl: config.ark.baseUrl,
      model: config.ark.model,
      apiKey: maskSecret(config.ark.apiKey),
      resolution: config.ark.resolution || '(不传，用模型默认)',
      chatModel: config.ark.chatModel || '(未配置，超长走本地压缩)',
    },
    mediakit: {
      baseUrl: config.mediakit.baseUrl,
      apiKey: maskSecret(config.mediakit.apiKey),
      outputDestination: config.mediakit.outputDestination || '(未配置：产物只能拿 VOD 预览链，见 README 坑位说明)',
      tosPublicEndpoint: config.mediakit.tosPublicEndpoint || '(未配置)',
    },
    ffmpeg: config.ffmpeg,
    server: config.server,
  };
}

/** 松散的「可 JSON 序列化对象」别名（避免在 health 视图里到处写 Record<string, unknown>）。 */
export type JsonishRecord = Record<string, unknown>;
