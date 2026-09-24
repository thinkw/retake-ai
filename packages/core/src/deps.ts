/**
 * 依赖注入容器（规格 §7.3：`Deps = { mediakit, seedance, artifact, ffmpeg, store, config }`）。
 *
 * core 不感知 HTTP，也不自己读 env：所有外部能力由 server 层构造后注入，
 * 单测里换上一组假实现就能把整条状态机跑完（这是「core 可单测」的落点）。
 */

import type { AppConfig } from './config.js';
import { loadConfig } from './config.js';
import type { ArtifactStore } from './adapters/artifact.js';
import { LocalArtifactStore } from './adapters/artifact.js';
import type { ChatCompleter } from './adapters/ark-chat.js';
import { createArkChat } from './adapters/ark-chat.js';
import type { Ffmpeg } from './adapters/ffmpeg.js';
import { LocalFfmpeg } from './adapters/ffmpeg.js';
import type { MediaKit } from './adapters/mediakit.js';
import { VolcengineMediaKit } from './adapters/mediakit.js';
import type { Seedance } from './adapters/seedance.js';
import { VolcengineSeedance } from './adapters/seedance.js';
import { JobStore } from './store/job-store.js';
import { MaterialStore } from './store/material-store.js';

/** 存储集合（job + 素材）。 */
export interface Store {
  jobs: JobStore;
  materials: MaterialStore;
}

/** 日志回调（server 层给 fastify logger，单测给收集器）。 */
export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;

/** 状态机运行所需的全部外部能力。 */
export interface Deps {
  config: AppConfig;
  mediakit: MediaKit;
  seedance: Seedance;
  artifact: ArtifactStore;
  ffmpeg: Ffmpeg;
  /** prompt 超长压缩用的 LLM；null = 未配 ARK_CHAT_MODEL，走本地确定性压缩 */
  chat: ChatCompleter | null;
  store: Store;
  /** 时钟（注入便于单测推进超时判定） */
  now: () => number;
  log: Logger;
}

/**
 * 由配置构造全套依赖。
 *
 * ⚠️ Key 只在构造期进入各适配器闭包，Deps 上不再暴露明文；/api/health 回显走
 * `maskedConfigView`（规格 §12：任何日志/错误回显必须掩码）。
 */
export function buildDeps(config: AppConfig, options: { log?: Logger } = {}): Deps {
  const log: Logger = options.log ?? (() => undefined);
  return {
    config,
    mediakit: new VolcengineMediaKit({
      apiKey: config.mediakit.apiKey,
      baseUrl: config.mediakit.baseUrl,
      outputDestination: config.mediakit.outputDestination,
      tosPublicEndpoint: config.mediakit.tosPublicEndpoint,
      queueId: config.mediakit.queueId,
    }),
    seedance: new VolcengineSeedance({
      apiKey: config.ark.apiKey,
      baseUrl: config.ark.baseUrl,
      model: config.ark.model,
      resolution: config.ark.resolution,
    }),
    artifact: new LocalArtifactStore({
      paths: config.paths,
      tosPublicEndpoint: config.mediakit.tosPublicEndpoint,
    }),
    ffmpeg: new LocalFfmpeg({
      ffmpegBin: config.ffmpeg.ffmpegBin,
      ffprobeBin: config.ffmpeg.ffprobeBin,
    }),
    chat: createArkChat({
      apiKey: config.ark.apiKey,
      baseUrl: config.ark.baseUrl,
      model: config.ark.chatModel,
    }),
    store: {
      jobs: new JobStore(config.paths),
      materials: new MaterialStore(config.paths),
    },
    now: () => Date.now(),
    log,
  };
}

/** 便捷：读 env → 校验 → 构造 Deps（server 启动用；配置缺失会抛带开通指引的 ConfigError）。 */
export function buildDepsFromEnv(): Deps {
  const config = loadConfig({ ensureDirs: true });
  return buildDeps(config);
}
