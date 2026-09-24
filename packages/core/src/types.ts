/**
 * 数据模型（交接包规格 §4）。
 *
 * 字段名尽量与源仓库 Java 侧保持一致（`pipelineMeta` / `scriptSnapshot` / `assetMaterials` …），
 * 因为源项目的流水线状态本来就整体序列化在一个 JSON blob 里 —— 本地版「一个 job 一个 JSON 文件」
 * 近似 drop-in，对照移植时可以直接 grep 字段名。
 */

import type { JobStage, JobStatus, MaterialScriptStatus, PrepareStage } from './pipeline/stages.js';
import type { JsonMap } from './util/maps.js';

/** 画幅（源：DramaAspectRatio 支持取值）。 */
export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4';

/** 人像引用（源：assetMaterials 里的 spokesperson / spokesperson2… 槽位）。 */
export interface PortraitRef {
  /** 剧本主角 id（与 analysis.cast[].id 对齐，用于「人像张数 ≤ 窗口内主角数」校验） */
  castId: string;
  /** `asset://asset-xxx`（方舟私域人像库；Seedance 参考真人只吃这个或方舟原始尾帧） */
  url: string;
  /** 来源：asset = 已是 asset://；local = 本地文件（v1 需用户自行换成 asset://，见 README「素材入云」） */
  source: 'asset' | 'local';
}

/**
 * 分段元信息（落在 job.meta.segments 里；phase 2 长视频才多项，v1 数组长度恒为 1）。
 * 字段与源仓库 meta.segments 元素一致：{index,start,end,duration,needLastFrame,sceneGroupId,shotGroupId,status,videoTaskId,videoUrl,lastFrameUrl,prompt,promptLength}
 *
 * 命名说明：本接口叫 `SegmentMeta` 而不叫 `Segment`，是为了与 `planner/segment-planner.ts` 里
 * 移植 Java `DramaSegmentPlanner.Segment` 的**值对象类**区分（一个是落盘结构，一个是计算用的窗口）。
 */
export interface SegmentMeta {
  index: number;
  start: number;
  end: number;
  duration: number;
  /** 是否需要用上一段尾帧作本段首帧（同场续段才 true） */
  needLastFrame: boolean;
  sceneGroupId: string;
  shotGroupId: string;
  /** pending / generating / done */
  status: string;
  /** 方舟任务 id（源仓库是本地视频任务主键，本地版直接存方舟 task_id 字符串） */
  videoTaskId?: string;
  videoUrl?: string;
  lastFrameUrl?: string;
  prompt?: string;
  promptLength?: number;
  promptMax?: number;
  promptOverride?: string;
  promptCompressed?: boolean;
}

/** 出片 job 的「剧本快照」（源：DramaShootSameJobDO.script_snapshot）。 */
export interface ScriptSnapshot {
  /** 素材剧本还原后的完整 analysis（scenes / dialogues / cast / durationSec / aspectRatio …） */
  analysis: JsonMap;
  /** 规划出的分段（v1 只有一段） */
  segments: JsonMap[];
  aspectRatio: string;
  hardSubtitle?: unknown;
  asrBurned?: unknown;
  segmentMaxSeconds?: number;
  scriptSourceUrl?: string;
  scriptArchiveUrl?: string;
  /** 用户手工改过剧本 / 改过分段 prompt 的标记（仅用于展示与排查） */
  userScriptOverride?: boolean;
  userPromptOverride?: boolean;
}

/** 状态机 blob（字段名与源仓库 meta.* 对齐）。 */
export interface PipelineMeta {
  /** 当前阶段：出片链用 JobStage（plan/video_seg/concat/done）；素材预处理链用 PrepareStage */
  stage: JobStage | PrepareStage | string;
  /** 阶段内状态（源：running / ok / failed） */
  status: 'running' | 'ok' | 'failed';
  /** 参考/原片来源 */
  sourceUrl?: string;
  /** 脱敏后（新版上传即 skipped，一般留空） */
  sanitizedUrl?: string;
  sanitizedCached?: boolean;
  /** 按 D 裁切后 */
  trimmedUrl?: string;
  /** 送 Seedance 的最终参考（drama 新版不传参考视频 → 见规格 §8.3）；本地版用来记「最终成片的本机地址」 */
  outputUrl?: string;
  /** 云端原始成片链接（24h 失效，仅用于排查；长期可用性以 resultVideoUrl 的本地文件为准） */
  remoteResultUrl?: string;
  trimSkipped?: boolean;
  /** 送模型的时长（≤15.2，实现裁到 15.0） */
  durationD?: number;
  /** v1 恒 false；phase 2 分段链式才 true */
  longForm?: boolean;
  targetDurationSec?: number;
  segmentTargetSeconds?: number;
  /** 'ref_video' | 'shot_transcript'（源：BrandShootSameGenerateMode） */
  generateMode?: string;
  promptVersion?: string;
  /** drama-script 还原出的剧本（本地文件路径） */
  scriptPath?: string;
  /** 所有在途 MediaKit/Seedance taskId，便于排查 */
  taskIds?: string[];
  segments?: SegmentMeta[];
  /** 分段游标（源：meta.segmentIndex / segmentTotal） */
  segmentIndex?: number;
  segmentTotal?: number;
  /** 画幅（源：meta.aspectRatio） */
  aspectRatio?: string;
  /** 拼接任务 id（phase 2） */
  concatTaskId?: string;
  /** 方舟视频任务 id（当前段） */
  videoTaskId?: string;
  /** 人像槽位表（源：job.assetMaterials，本地版冗余一份方便单文件回放） */
  assetMaterials?: Record<string, string>;
  startTs?: number;
  stageStartTs?: number;
  elapsedMs?: number;
  error?: string;
}

/** 出片 job（源：DramaShootSameJobDO 中本地版真正用到的字段）。 */
export interface ShootSameJob {
  /** 本地生成（crypto.randomUUID），替代自增主键 */
  id: string;
  createdAt: number;
  updatedAt: number;
  status: JobStatus;
  /** 向导步骤号，前端进度用；服务端仅透传（源 drama 固定 "4"） */
  step: string;
  /** 本地素材库 id（替代 viralMaterialId） */
  materialId?: string;
  /** 最终生成指令（recommendedPrompt 或用户编辑后） */
  prompt?: string;
  aspectRatio: AspectRatio;
  /** 目标成片时长（秒），v1 恒 ≤15 */
  duration: number;
  portraits: PortraitRef[];
  /** 音色源（drama 链路要求 asset://，见 README「素材入云」） */
  voiceUrl?: string;
  /** 本地成片路径（或 durable url） */
  resultVideoUrl?: string;
  errorMessage?: string;
  /** ★ 状态机全部进度塞这里（落 job JSON） */
  meta: PipelineMeta;
  /** 剧本快照（建 job 时冻结，避免素材后续变更影响在途任务） */
  snapshot?: ScriptSnapshot;
}

/** job 列表项（分页只回必要的摘要字段）。 */
export interface JobSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: JobStatus;
  stage: string;
  materialId?: string;
  materialName?: string;
  aspectRatio: string;
  duration: number;
  resultVideoUrl?: string;
  errorMessage?: string;
}

/**
 * 本地素材（源：AiViralMaterialDO 的 drama 相关字段）。
 * `analysis` 即源仓库的 `analysis_result` blob：剧本还原结果 + prepare 流水线进度都塞这里。
 */
export interface Material {
  id: string;
  createdAt: number;
  updatedAt: number;
  name: string;
  /** 公网可访问地址（MediaKit / Seedance 的入参只吃 URL） */
  url: string;
  /** 本地留档路径（上传接口落盘，便于回溯；不参与云调用） */
  localPath?: string;
  size?: number;
  format?: string;
  /** 时长（秒，ffprobe 探测） */
  duration?: number;
  /** 剧本还原状态 */
  analyzeStatus: MaterialScriptStatus;
  /** 脱敏状态：新版恒 skipped */
  sanitizeStatus: string;
  analyzeError?: string;
  /** 剧本还原流水线开始时间（源：analyze_started_at；用于 40 分钟兜底超时） */
  analyzeStartedAt?: number;
  /** 片尾裁切秒数（0 = 不裁） */
  trimTailSeconds?: number;
  /** 单段上限（v1 忽略，phase 2 分段用） */
  segmentMaxSeconds?: number;
  /** 剧本还原结果 + prepare 进度 blob（源：analysis_result） */
  analysis: JsonMap;
  /** 本地剧本文件（drama-script 原始 JSON / result.json） */
  scriptPath?: string;
  coverUrl?: string;
  keyframeUrls?: string[];
}

/** 素材摘要（列表返回）。 */
export interface MaterialSummary {
  id: string;
  name: string;
  url: string;
  duration?: number;
  analyzeStatus: MaterialScriptStatus;
  sanitizeStatus: string;
  analyzeError?: string;
  /** 是否可用于建 job（源：toMaterialResp 的 shootReady） */
  shootReady: boolean;
  createdAt: number;
}

/** 分页入参/出参（对齐源仓库 pageNo/pageSize 口径）。 */
export interface PageReq {
  pageNo: number;
  pageSize: number;
}

/** 分页出参。 */
export interface PageResp<T> {
  total: number;
  items: T[];
}
