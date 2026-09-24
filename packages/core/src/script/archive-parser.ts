/**
 * 解析 drama-script 的产物包（源：`service/btob/drama/DramaScriptArchiveParser.java`）。
 *
 * drama-script 用 `return_pkg=true` 提交，返回的是一个 **gzip**：
 * - 里面可能直接是 JSON（无图版）；
 * - 也可能是 **tar.gz**：`result.json` + `faces/*.jpg` + `scene_frames/*.jpg`。
 *
 * 本地版用 `node:zlib` 解 gzip（零依赖），tar 按 POSIX ustar 的 512 字节头手工解析——
 * 与源实现同一套「不依赖第三方库」的做法，也便于精确对照 Java 的 entry 判定规则。
 */

import { gunzipSync } from 'node:zlib';
import type { JsonMap } from '../util/maps.js';
import { isBlank } from '../util/text.js';

/** 一个带名字的字节块（源：NamedBytes）。 */
export interface NamedBytes {
  name: string;
  data: Buffer;
}

/** 解析结果（源：Parsed）。 */
export interface ParsedScript {
  script: JsonMap;
  faces: NamedBytes[];
  sceneFrames: NamedBytes[];
}

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
const TAR_BLOCK = 512;

/** 解析剧本包（源：parse）。传进来的就是 result_url 下载到的原始字节。 */
export function parseArchive(data: Buffer | null): ParsedScript {
  const parsed: ParsedScript = { script: {}, faces: [], sceneFrames: [] };
  if (!data || data.length < 2) {
    return parsed;
  }
  let inner = data;
  if (isGzip(data)) {
    inner = gunzipOrSelf(data);
  }
  if (looksLikeJson(inner)) {
    parsed.script = toMap(inner);
    return parsed;
  }
  parseTar(inner, parsed);
  return parsed;
}

/** 解 gzip；失败时返回原始字节（源：gunzip 的 catch 分支——很多情况下云端直接给了未压缩 JSON）。 */
function gunzipOrSelf(data: Buffer): Buffer {
  try {
    return gunzipSync(data);
  } catch {
    return data;
  }
}

function isGzip(data: Buffer): boolean {
  return data.length >= 2 && data[0] === GZIP_MAGIC_0 && data[1] === GZIP_MAGIC_1;
}

/** 前导空白后是 `{` 或 `[` 就当 JSON（源：looksLikeJson）。 */
function looksLikeJson(data: Buffer): boolean {
  let i = 0;
  while (i < data.length && isWhitespaceByte(data[i] as number)) {
    i++;
  }
  if (i >= data.length) {
    return false;
  }
  const c = data[i] as number;
  return c === 0x7b /* { */ || c === 0x5b /* [ */;
}

function isWhitespaceByte(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0b || byte === 0x0c || byte === 0x0d;
}

/** POSIX tar 顺序解析（源：parseTar：512 头 + 名称 0..100 + 八进制 size 在 124..136）。 */
function parseTar(tar: Buffer, parsed: ParsedScript): void {
  let offset = 0;
  while (offset + TAR_BLOCK <= tar.length) {
    if (isAllZero(tar, offset, TAR_BLOCK)) {
      break;
    }
    const name = readCString(tar, offset, 100);
    const size = parseOctal(tar, offset + 124, 12);
    offset += TAR_BLOCK;
    if (size < 0 || offset + size > tar.length) {
      break;
    }
    const payload = tar.subarray(offset, offset + size);
    const padded = Math.floor((size + TAR_BLOCK - 1) / TAR_BLOCK) * TAR_BLOCK;
    offset += padded;
    if (isBlank(name)) {
      continue;
    }
    if (isResultJson(name)) {
      parsed.script = toMap(payload);
    } else if (isFaceEntry(name)) {
      parsed.faces.push({ name, data: Buffer.from(payload) });
    } else if (isSceneFrameEntry(name)) {
      parsed.sceneFrames.push({ name, data: Buffer.from(payload) });
    }
  }
  // tar 解析不出结构时，最后一搏：整体当 JSON（源：同逻辑）
  if (Object.keys(parsed.script).length === 0 && looksLikeJson(tar)) {
    parsed.script = toMap(tar);
  }
}

/** 归一化 entry 名：反斜杠→斜杠、小写、去 `./` 前缀（源：normalizeEntry）。 */
function normalizeEntry(name: string | null): string {
  if (name === null) {
    return '';
  }
  let n = name.replace(/\\/g, '/').toLowerCase().trim();
  while (n.startsWith('./')) {
    n = n.slice(2);
  }
  return n;
}

/** 剧本主文件：result.json（源：isResultJson）。 */
export function isResultJson(name: string): boolean {
  const n = normalizeEntry(name);
  return n === 'result.json' || n.endsWith('/result.json');
}

/** 人脸图：faces/ 与 /faces/ 都识别（源：isFaceEntry）。 */
export function isFaceEntry(name: string): boolean {
  const n = normalizeEntry(name);
  return isImage(n) && (n.startsWith('faces/') || n.includes('/faces/'));
}

/** 场景帧：scene_frames/ 或旧写法 sceneframes/（源：isSceneFrameEntry）。 */
export function isSceneFrameEntry(name: string): boolean {
  const n = normalizeEntry(name);
  return (
    isImage(n) &&
    (n.startsWith('scene_frames/') || n.includes('/scene_frames/') || n.startsWith('sceneframes/') || n.includes('/sceneframes/'))
  );
}

function isImage(name: string): boolean {
  return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.webp');
}

function isAllZero(data: Buffer, off: number, len: number): boolean {
  for (let i = 0; i < len && off + i < data.length; i++) {
    if (data[off + i] !== 0) {
      return false;
    }
  }
  return true;
}

/** 读 C 风格字符串（源：readCString）。 */
function readCString(data: Buffer, off: number, len: number): string {
  let end = off;
  const max = Math.min(data.length, off + len);
  while (end < max && data[end] !== 0) {
    end++;
  }
  return data.subarray(off, end).toString('utf8').trim();
}

/** 八进制长度字段（源：parseOctal；解析不出当 0）。 */
function parseOctal(data: Buffer, off: number, len: number): number {
  const raw = readCString(data, off, len).trim();
  if (raw.length === 0) {
    return 0;
  }
  const size = parseInt(raw, 8);
  return Number.isFinite(size) ? size : 0;
}

/** 字节 → JSON 对象（源：toMap；不是对象时给空对象，保证调用方永远拿到可判空的 map）。 */
function toMap(bytes: Buffer): JsonMap {
  const text = bytes.toString('utf8');
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as JsonMap;
    }
  } catch {
    // 解析失败与源实现一样：交给上层按「剧本包无法解析」处理
  }
  return {};
}
