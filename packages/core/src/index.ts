/**
 * @retake/core 对外出口。
 *
 * server 层只从这一个入口取东西（`import { ... } from '@retake/core'`），
 * 内部文件怎么拆都不影响外部 —— 也方便单测直接 import 单个模块。
 */

// 配置与目录
export * from './config.js';
export * from './paths.js';
export * from './deps.js';

// 数据模型
export * from './types.js';

// 状态机：阶段/状态常量、素材预处理、出片生成
export * from './pipeline/stages.js';
export * from './pipeline/prepare.js';
export * from './pipeline/state-machine.js';

// 存储
export * from './store/job-store.js';
export * from './store/material-store.js';

// 适配层
export * from './adapters/mediakit.js';
export * from './adapters/mediakit-paths.js';
export * from './adapters/seedance.js';
export * from './adapters/artifact.js';
export * from './adapters/ffmpeg.js';
export * from './adapters/ark-chat.js';

// prompt 资产（逐字移植自源仓库）
export * from './prompt/seedance-prompt.js';
export * from './prompt/understand-prompt.js';
export * from './prompt/video-prompt-utils.js';
export * from './prompt/prompt-length-compressor.js';
export * from './prompt/segment-prompt-assembler.js';

// 主角/画幅/剧本/分段
export * from './cast/cast.js';
export * from './script/aspect-ratio.js';
export * from './script/ocr-heuristic.js';
export * from './script/archive-parser.js';
export * from './script/script-mapper.js';
export * from './planner/limits.js';
export * from './planner/segment-planner.js';

// 通用工具
export * from './util/maps.js';
export * from './util/text.js';
