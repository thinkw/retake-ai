/**
 * HTTP 层共用小工具：分页解析、错误映射。
 *
 * 错误映射的原则：**本地版没有多租户/没有错误码表**，直接把「人能看懂的一句话」回给调用方，
 * 但绝不允许把 Key、绝对路径之外的敏感信息带出去（ConfigError/NeedsPublicUrlError 的文案本身就是给用户看的）。
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { ConfigError, NeedsPublicUrlError, SETUP_GUIDE } from '@retake/core';

/** 分页入参（规格 §8.1 沿用源仓库 pageNo/pageSize 口径）。 */
export interface PageQuery {
  pageNo: number;
  pageSize: number;
}

/** 从 query 里解析分页，缺省 1/20，单页上限 100（本地文件遍历，防止一次拉爆）。 */
export function parsePage(req: FastifyRequest): PageQuery {
  const query = (req.query ?? {}) as Record<string, unknown>;
  const pageNo = toPositiveInt(query['pageNo'], 1);
  const pageSize = Math.min(100, toPositiveInt(query['pageSize'], 20));
  return { pageNo, pageSize };
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

/** 统一错误响应：400（用户可修正）/ 500（配置或实现问题），并把开通指引单独回传便于前端展示。 */
export function replyError(reply: FastifyReply, ex: unknown): FastifyReply {
  const error = ex instanceof Error ? ex : new Error(String(ex));
  if (error instanceof ConfigError) {
    return reply.code(500).send({ error: error.message, missing: error.missing, guide: SETUP_GUIDE });
  }
  if (error instanceof NeedsPublicUrlError) {
    // 这是「使用方式」问题，不是 bug：给 400 + 完整出路说明
    return reply.code(400).send({ error: error.message, code: 'NEEDS_PUBLIC_URL' });
  }
  const status = error.name === 'NotFoundError' ? 404 : 400;
  return reply.code(status).send({ error: error.message });
}

/** 取字符串字段（去掉两端空白；非字符串一律当未传）。 */
export function field(body: Record<string, unknown> | undefined, key: string): string {
  const value = body?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** 取数字字段。 */
export function numberField(body: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = body?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/** 取字符串数组字段。 */
export function stringArray(body: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const value = body?.[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}
