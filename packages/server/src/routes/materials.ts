/**
 * 素材路由（规格 §8.1 的 materials 部分 + 两个本地版必要的补充接口）。
 *
 * 一条必须讲清楚的现实（README 里也写了）：
 * MediaKit / 方舟的入参**只接受公网可访问 URL**，本地文件不能直接喂给云。
 * 因此这里同时支持两种登记方式：
 * - `POST /api/materials`：直接给 URL（推荐：参考片本来就是从抖音/小红书等平台拿到的链接）；
 * - `POST /api/materials/upload`：上传到本地 materials/ 留档，**并允许同时带 url 字段**；
 *   只上传不给 URL 时，素材会停在待处理态并明确告知「补 URL 后 retry」，不会假装能跑通。
 */

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import {
  MAX_SEGMENT_SECONDS,
  MIN_SEGMENT_SECONDS,
  type Deps,
  type Material,
  webPathOf,
  retryScript,
  ANALYZE_READY,
} from '@retake/core';
import { field, numberField, parsePage, replyError } from '../http-util.js';

/** 上传体积上限（源：DramaShootSameService.MAX_BYTES = 500MB）。 */
export const MAX_BYTES = 500 * 1024 * 1024;

/** 允许的视频后缀（源：ALLOWED_EXT）。 */
const ALLOWED_EXT = new Set(['mp4', 'mov', 'webm', 'm4v']);

/** 注册素材相关路由。 */
export async function registerMaterialRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  /** 以 URL 形式登记素材（不下载，只建记录）。 */
  app.post('/api/materials', async (req, reply) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      const url = field(body, 'url');
      if (!/^https?:\/\//i.test(url)) {
        throw new Error('url 必须是 http(s) 公网可访问地址（云端工具无法读取本地路径）');
      }
      const material = await createMaterial(deps, {
        name: field(body, 'name') || guessName(url),
        url,
        trimTailSeconds: numberField(body, 'trimTailSeconds'),
        segmentMaxSeconds: numberField(body, 'segmentMaxSeconds'),
      });
      return reply.code(201).send(toResp(deps, material));
    } catch (ex) {
      return replyError(reply, ex);
    }
  });

  /** multipart 上传：文件落本地留档，url 可选（有则可直接跑剧本还原）。 */
  app.post('/api/materials/upload', async (req, reply) => {
    try {
      if (!req.isMultipart()) {
        throw new Error('请使用 multipart/form-data（字段：file、url?、name?、trimTailSeconds?、segmentMaxSeconds?）');
      }
      const id = randomUUID();
      let url = '';
      let name = '';
      let trimTailSeconds: number | undefined;
      let segmentMaxSeconds: number | undefined;
      let localPath = '';
      let size = 0;
      let format = '';

      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file') {
            // 非预期文件字段：读完丢弃，否则整个请求的流会挂住
            await part.toBuffer();
            continue;
          }
          const original = path.basename(part.filename || 'video.mp4');
          const ext = extOf(original);
          if (!ALLOWED_EXT.has(ext)) {
            throw new Error(`不支持的文件类型：${ext || '未知'}（仅支持 ${[...ALLOWED_EXT].join('/')}）`);
          }
          const target = path.join(deps.config.paths.materials, `${id}.${ext}`);
          // 流式写盘 + 边写边计数：几百 MB 的文件不能进内存
          let written = 0;
          part.file.on('data', (chunk: Buffer) => {
            written += chunk.length;
          });
          await pipeline(part.file, createWriteStream(target, { flags: 'w' }));
          if (written > MAX_BYTES) {
            throw new Error(`文件超过上限（${Math.round(MAX_BYTES / 1024 / 1024)}MB）`);
          }
          localPath = target;
          size = written;
          format = ext;
          name = name || original.replace(/\.[^.]+$/, '');
        } else {
          const value = typeof part.value === 'string' ? part.value.trim() : '';
          if (part.fieldname === 'url') {
            url = value;
          } else if (part.fieldname === 'name') {
            name = value || name;
          } else if (part.fieldname === 'trimTailSeconds') {
            trimTailSeconds = Number(value) || undefined;
          } else if (part.fieldname === 'segmentMaxSeconds') {
            segmentMaxSeconds = Number(value) || undefined;
          }
        }
      }
      if (!localPath && !url) {
        throw new Error('至少提供 file 或 url 其中之一');
      }
      if (url && !/^https?:\/\//i.test(url)) {
        throw new Error('url 字段必须是 http(s) 地址');
      }
      const material = await createMaterial(deps, {
        id,
        name: name || '未命名素材',
        url,
        localPath,
        size: size || undefined,
        format: format || undefined,
        trimTailSeconds,
        segmentMaxSeconds,
      });
      const resp = toResp(deps, material);
      if (!url) {
        resp.warning =
          '已保存到本地素材库，但还没有公网可访问地址：请把文件传到任意公网位置后调用 ' +
          'POST /api/materials/<id>/retry 带 url 补地址，' +
          '或在 .env 配置 MEDIKIT_OUTPUT_DEST + TOS_PUBLIC_ENDPOINT 让中间产物直接落在你自己的 TOS。';
      }
      return reply.code(201).send(resp);
    } catch (ex) {
      return replyError(reply, ex);
    }
  });

  /** 素材列表。 */
  app.get('/api/materials', async (req, reply) => {
    try {
      const query = (req.query ?? {}) as Record<string, unknown>;
      const page = await deps.store.materials.list(parsePage(req), field(query, 'analyzeStatus'));
      return reply.send({
        total: page.total,
        items: page.items.map((item) => ({
          ...item,
          previewUrl: webPathOf(deps.config.paths, item.url),
        })),
      });
    } catch (ex) {
      return replyError(reply, ex);
    }
  });

  /** 素材详情（含剧本还原进度：analysis.prepareStage / prepareTaskId）。 */
  app.get('/api/materials/:id', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const material = await requireMaterial(deps, id);
      return reply.send(toResp(deps, material));
    } catch (ex) {
      return replyError(reply, ex);
    }
  });

  /**
   * 重跑剧本还原（源：retryScript）；可选带 `{url}` 先补地址再跑。
   * 这是「上传后补公网 URL」的闭环入口，也是失败自愈的手工入口。
   */
  app.post('/api/materials/:id/retry', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown> | undefined;
      const url = field(body, 'url');
      await requireMaterial(deps, id);
      if (url) {
        if (!/^https?:\/\//i.test(url)) {
          throw new Error('url 字段必须是 http(s) 地址');
        }
        await deps.store.materials.withMaterialLock(id, async () => {
          const current = await deps.store.materials.get(id);
          if (!current) {
            return;
          }
          current.url = url;
          await deps.store.materials.save(current);
        });
      }
      const restarted = await retryScript(deps, id);
      return reply.send({ material: restarted ? toResp(deps, restarted) : null });
    } catch (ex) {
      return replyError(reply, ex);
    }
  });
}

/** 建素材记录（统一做字段钳制，源：upload 里的 trimTail/segmentMax 钳制口径）。 */
async function createMaterial(deps: Deps, input: {
  id?: string;
  name: string;
  url: string;
  localPath?: string;
  size?: number;
  format?: string;
  trimTailSeconds?: number;
  segmentMaxSeconds?: number;
}): Promise<Material> {
  const trimTail =
    input.trimTailSeconds && input.trimTailSeconds > 0 ? Math.min(input.trimTailSeconds, 10) : undefined;
  const segmentMax =
    input.segmentMaxSeconds && input.segmentMaxSeconds > 0
      ? Math.max(MIN_SEGMENT_SECONDS, Math.min(input.segmentMaxSeconds, MAX_SEGMENT_SECONDS))
      : undefined;
  // 没有 url 的素材保持 pending：调度器领取时会因「缺公网地址」直接判失败并给出补地址指引
  return deps.store.materials.create({
    id: input.id,
    name: (input.name || '未命名素材').slice(0, 128),
    url: input.url,
    localPath: input.localPath,
    size: input.size,
    format: input.format,
    trimTailSeconds: trimTail,
    segmentMaxSeconds: segmentMax,
  });
}

/** 取素材，不存在抛 NotFoundError（replyError 会映射成 404）。 */
async function requireMaterial(deps: Deps, id: string): Promise<Material> {
  const material = await deps.store.materials.get(id);
  if (!material) {
    const notFound = new Error(`素材不存在：${id}`);
    notFound.name = 'NotFoundError';
    throw notFound;
  }
  return material;
}

/** 素材响应体：摘要 + 剧本还原进度 + 可播地址（本地产物转 /files/...）。 */
function toResp(deps: Deps, material: Material): RespMaterial {
  const analysis = material.analysis ?? {};
  return {
    id: material.id,
    name: material.name,
    url: material.url,
    localPath: material.localPath ?? '',
    previewUrl: webPathOf(deps.config.paths, material.url || material.localPath || ''),
    duration: material.duration ?? 0,
    size: material.size ?? 0,
    format: material.format ?? '',
    analyzeStatus: material.analyzeStatus,
    sanitizeStatus: material.sanitizeStatus,
    analyzeError: material.analyzeError ?? '',
    shootReady: material.analyzeStatus === ANALYZE_READY,
    trimTailSeconds: material.trimTailSeconds ?? 0,
    segmentMaxSeconds: material.segmentMaxSeconds ?? 0,
    scriptPath: material.scriptPath ?? '',
    coverUrl: material.coverUrl ?? '',
    createdAt: material.createdAt,
    updatedAt: material.updatedAt,
    // 进度与结果：prepareStage 给向导显示，cast 决定可用人像槽数量
    prepareStage: String(analysis['prepareStage'] ?? ''),
    prepareTaskId: String(analysis['prepareTaskId'] ?? ''),
    hardSubtitle: analysis['hardSubtitle'] ?? null,
    asrBurned: analysis['asrBurned'] ?? null,
    aspectRatio: String(analysis['aspectRatio'] ?? ''),
    cast: Array.isArray(analysis['cast']) ? analysis['cast'] : [],
    sceneCount: Array.isArray(analysis['scenes']) ? analysis['scenes'].length : 0,
    dialogueCount: Array.isArray(analysis['dialogues']) ? analysis['dialogues'].length : 0,
  };
}

/** 素材响应结构（warning 只在上传未给 URL 时出现）。 */
type RespMaterial = Record<string, unknown> & { warning?: string };

/** 从 URL 猜个素材名（去掉查询串与扩展名）。 */
function guessName(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() ?? '未命名素材';
    return last.replace(/\.[^.]+$/, '').slice(0, 128) || '未命名素材';
  } catch {
    return '未命名素材';
  }
}

/** 取小写扩展名（源：extOf）。 */
function extOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) {
    return '';
  }
  return filename.slice(dot + 1).toLowerCase();
}
