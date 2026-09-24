/**
 * MediaKit 工具路径常量。
 *
 * 逐字照搬源仓库两处：
 * - `framework/mediakit/MediaKitPaths.java`（通用工具路径）
 * - `service/btob/drama/DramaMediaKitPaths.java`（drama 新链路专用：video-ocr / drama-script）
 *
 * 保留注释与常量命名，便于和源实现一对一对照（规格 §9「移植点」要求）。
 */

/** 查询任务：GET /api/v1/tasks/{task_id} → running | completed | failed */
export const QUERY_TASK = '/api/v1/tasks/{task_id}';

// —— 视频工具（异步）——
export const SEGMENT_SCENES = '/api/v1/tools/segment-scenes';
export const ASR_SUBTITLES = '/api/v1/tools/asr-subtitles';
export const EXTRACT_FRAMES = '/api/v1/tools/extract-frames';
export const EXTRACT_AUDIO = '/api/v1/tools/extract-audio';
export const SEPARATE_VOICE = '/api/v1/tools/separate-voice';
export const VIDEO_UNDERSTAND = '/api/v1/tools/video-understand-router';
export const ENHANCE_VIDEO = '/api/v1/tools/enhance-video';
export const ENHANCE_VIDEO_GENERATIVE = '/api/v1/tools/enhance-video-generative';
export const ADD_SUBTITLE = '/api/v1/tools/add-subtitle-to-video';
export const ADD_IMAGE = '/api/v1/tools/add-image-to-video';
export const APPLY_FILTER = '/api/v1/tools/apply-video-filter';
export const MUX_AUDIO_VIDEO = '/api/v1/tools/mux-audio-video';
export const ADD_INVISIBLE_WATERMARK = '/api/v1/tools/add-video-invisible-watermark';
export const TRANSCODE_VIDEO = '/api/v1/tools/transcode-video';
export const TRIM_VIDEO = '/api/v1/tools/trim-video';
export const TRIM_AUDIO = '/api/v1/tools/trim-audio';
/** 视频拼接（多段按顺序首尾相连，支持可选转场；拍同款长视频分段后拼接成片） */
export const CONCAT_VIDEO = '/api/v1/tools/concat-video';
/** 标准版视频去字幕（异步） */
export const ERASE_VIDEO_SUBTITLE = '/api/v1/tools/erase-video-subtitle';
/** 视频人脸打码（异步） */
export const FACE_BLUR_VIDEO = '/api/v1/tools/face-blur-video';

// —— 图像工具（同步 tools-sync）——
export const EVALUATE_IMAGE_QUALITY = '/api/v1/tools-sync/evaluate-image-quality';
export const ENHANCE_IMAGE = '/api/v1/tools-sync/enhance-image';
export const REMOVE_IMAGE_BACKGROUND = '/api/v1/tools-sync/remove-image-background';
export const ERASE_IMAGE_PSORIASIS = '/api/v1/tools/erase-image-psoriasis';
export const ECOMMERCE_SCENE = '/api/v1/tools/ecommerce-scene-generation';

// —— drama 新链路专用（源：DramaMediaKitPaths；ASR/烧录/裁切/拼接仍引用上面的通用路径）——
export const DRAMA_SCRIPT = '/api/v1/tools/drama-script';
export const VIDEO_OCR = '/api/v1/tools/video-ocr';

/**
 * v1 链路真正会调用的工具集合（用于 /api/health 自检「能力对齐」，也是规格 §6.1 清单的落地映射）。
 */
export const USED_IN_V1 = [
  TRIM_VIDEO,
  VIDEO_OCR,
  ASR_SUBTITLES,
  ADD_SUBTITLE,
  DRAMA_SCRIPT,
  CONCAT_VIDEO,
] as const;
