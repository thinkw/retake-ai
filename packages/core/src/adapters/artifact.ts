/**
 * 产物转存适配层（交接包规格 §6.3）。
 *
 * 为什么必须转存：MediaKit / 方舟的产物链接 **24h 失效**（未配 media_output_destination 时更是带 auth_key 的
 * VOD 预览链），本地版把它落到 RETAKE_HOME/artifacts，用户隔天还能播、还能续跑。
 *
 * 与源实现（MediaKitArtifactStore）的三处刻意差异：
 * 1. 源里转存后仍是「自有 TOS 的 URL」，本地版转存后是**本地文件路径**；
 * 2. 因此新增 {@link toConsumableUrl}：把「本地路径」在需要喂给云端工具前显式拦下并给出可执行指引
 *    ——云端工具只吃公网 URL，这是本地版最容易踩的空洞；
 * 3. 非 .mp4 输入补 `.mp4` 后缀（源：ensurePlayableUrl，规格 §11-5），否则浏览器按 octet-stream 拒播。
 */

import path from 'node:path';
import type { DataPaths } from '../paths.js';
import { artifactDir } from '../paths.js';
import { isBlank, trim } from '../util/text.js';
import { downloadToFile } from './ffmpeg.js';
import { isEphemeralMediaUrl, tosToHttpUrl } from './mediakit.js';

/** 转存所需的极小依赖（避免 artifact 适配器直接依赖整个 config）。 */
export interface ArtifactOptions {
  paths: DataPaths;
  /** MediaKit 的 tos:// → https 端点（不含桶名） */
  tosPublicEndpoint: string;
  /** 可注入下载实现，便于单测 */
  download?: (url: string, outFile: string) => Promise<string>;
}

/** 产物转存器接口。 */
export interface ArtifactStore {
  /** 临时链 → 下载到本地；durable（含 tos:// 已转 https）→ 原样返回 */
  persistIfEphemeral(url: string, subDir: string, nameHint: string): Promise<string>;
  /** **无论什么链接都落一份到本地**（成片用：方舟/MediaKit 的产物链 24h 就失效，规格 §6.3） */
  persistLocal(url: string, subDir: string, nameHint: string): Promise<string>;
  /** 保证拿到「可播且长期」的地址（补 .mp4 后缀） */
  ensurePlayable(url: string, subDir: string, nameHint: string): Promise<string>;
  /** 判定是否临时链（透传 MediaKit 口径，便于缓存命中判定） */
  isEphemeralUrl(url: string): boolean;
  /** 本地路径 or URL → 云端工具可用的 URL；本地路径直接抛可执行错误 */
  toConsumableUrl(localPathOrUrl: string, context: string): string;
}

/** 「本地产物无法回喂云端」错误：给出两条具体出路，而不是让人猜。 */
export class NeedsPublicUrlError extends Error {
  constructor(localPath: string, context: string) {
    super(
      [
        `${context}：需要一个公网可访问地址，但当前拿到的是本地文件 ${localPath}`,
        '',
        '两条出路（任选其一）：',
        `1. 推荐：在 .env 配置 MEDIKIT_OUTPUT_DEST=tos://<你的桶名>/<目录>（并在 MediaKit 控制台授权跨服务写），`,
        `   同时配置 TOS_PUBLIC_ENDPOINT=<区域端点>；配置后中间产物直接落在你自己的 TOS，链路是 tos:// → https，`,
        `   下一步工具可直接消费（源项目正是这么做的）。`,
        `2. 手工：把该文件上传到任意公网可访问位置，然后用 POST /api/materials 以 URL 形式登记素材后重跑。`,
      ].join('\n'),
    );
    this.name = 'NeedsPublicUrlError';
  }
}

/** 本地版产物转存实现。 */
export class LocalArtifactStore implements ArtifactStore {
  private readonly options: ArtifactOptions;

  constructor(options: ArtifactOptions) {
    this.options = options;
  }

  async persistIfEphemeral(url: string, subDir: string, nameHint: string): Promise<string> {
    const mediaUrl = trim(url);
    if (isBlank(mediaUrl)) {
      throw new Error('视频地址为空');
    }
    // tos:// 是 MediaKit 直存产物（配了 media_output_destination 才会有），永久有效，不需下载转存
    if (mediaUrl.startsWith('tos://')) {
      const httpUrl = tosToHttpUrl(mediaUrl, this.options.tosPublicEndpoint);
      if (httpUrl.startsWith('tos://')) {
        throw new Error(
          `产物是 tos:// 直存地址但未配置 TOS_PUBLIC_ENDPOINT，无法播放/继续处理：${httpUrl}`,
        );
      }
      return httpUrl;
    }
    if (!this.isEphemeralUrl(mediaUrl)) {
      // 已是长期地址：源实现同样原样返回，避免无谓下载
      return mediaUrl;
    }
    // 命中临时链：下载到 RETAKE_HOME/artifacts/<subDir>/
    const fileName = `${sanitize(nameHint) || 'media'}_${Date.now()}.mp4`;
    const outFile = path.join(artifactDir(this.options.paths, subDir), fileName);
    const downloader = this.options.download ?? downloadToFile;
    await downloader(mediaUrl, outFile);
    return outFile;
  }

  /**
   * 无论什么链接都落一份到本地（**成片必须本机留存**，规格 §6.3）。
   *
   * 为何不直接复用 persistIfEphemeral：方舟产出的 `https://ark-acg-*.volces.com/...` 不带 `auth_key`，
   * 在 isEphemeralUrl 的启发式下会被当成「长期地址」而跳过下载，但它同样 **24h 过期**；
   * 不强制下载就会出现「第二天打不开成片」这类难查的问题。
   */
  async persistLocal(url: string, subDir: string, nameHint: string): Promise<string> {
    const mediaUrl = trim(url);
    if (isBlank(mediaUrl)) {
      throw new Error('视频地址为空');
    }
    // tos:// 先转成可下载的 https（未配端点时会抛错，指引用户去填）
    let source = mediaUrl;
    if (source.startsWith('tos://')) {
      source = tosToHttpUrl(source, this.options.tosPublicEndpoint);
      if (source.startsWith('tos://')) {
        throw new Error(`产物是 tos:// 直存地址但未配置 TOS_PUBLIC_ENDPOINT，无法下载到本地：${source}`);
      }
    }
    if (!/^https?:\/\//i.test(source)) {
      // 已经是本地路径（或 asset:// 等不可下载形式）：本地路径直接返回，其他报错
      if (source.includes('://')) {
        throw new Error(`无法下载到本地：不支持的地址形式 ${source.slice(0, 40)}`);
      }
      return source;
    }
    const fileName = `${sanitize(nameHint) || 'media'}_${Date.now()}.mp4`;
    const outFile = path.join(artifactDir(this.options.paths, subDir), fileName);
    const downloader = this.options.download ?? downloadToFile;
    await downloader(source, outFile);
    return outFile;
  }

  async ensurePlayable(url: string, subDir: string, nameHint: string): Promise<string> {
    const persisted = await this.persistIfEphemeral(url, subDir, nameHint);
    // 本地文件天然可播（已补 .mp4 后缀）；远端地址则必须带 .mp4，否则重下一份保证后缀
    if (!/^https?:\/\//i.test(persisted)) {
      return persisted;
    }
    if (persisted.toLowerCase().split('?')[0]?.endsWith('.mp4')) {
      return persisted;
    }
    return this.persistLocal(persisted, subDir, `${nameHint}_playable`);
  }

  isEphemeralUrl(url: string): boolean {
    return isEphemeralMediaUrl(url);
  }

  toConsumableUrl(localPathOrUrl: string, context: string): string {
    const value = trim(localPathOrUrl);
    if (isBlank(value)) {
      throw new Error(`${context}：地址为空`);
    }
    if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('asset://')) {
      return value;
    }
    throw new NeedsPublicUrlError(value, context);
  }
}

/** 文件名清洗：去掉路径分隔符与非法字符，保留中文（Windows 文件名合法集内）。 */
function sanitize(nameHint: string): string {
  return trim(nameHint)
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(-80);
}
