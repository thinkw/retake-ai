/**
 * 本地目录解析：整个产品的「持久层」就是 RETAKE_HOME 下的几堆文件（无数据库服务）。
 *
 * 目录约定（对应交接包规格 §2 / §5）：
 *   RETAKE_HOME/
 *   ├─ jobs/        一个 job 一个 JSON（+ index.jsonl 追加式列表索引）
 *   ├─ materials/   本地素材库 JSON（替代源仓库的 ai_viral_material 表）
 *   ├─ artifacts/   云端产物转存（裁切/烧录/成片等，替代源仓库的 TOS FileApi）
 *   └─ scripts/     drama-script 还原出的剧本包与解析后的剧本 JSON
 *
 * 相对路径统一相对工程根（本文件所在目录的上两级），避免「从哪个 cwd 启动」影响数据落点。
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 工程根：packages/core/src/paths.ts → 上三级即仓库根。 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 数据目录名常量（集中定义，避免各处硬编码拼写）。 */
export const DIR_JOBS = 'jobs';
export const DIR_MATERIALS = 'materials';
export const DIR_ARTIFACTS = 'artifacts';
export const DIR_SCRIPTS = 'scripts';

/** 归一化 RETAKE_HOME：相对路径按工程根解析，绝对路径原样使用。 */
export function resolveHome(retakeHome: string | undefined): string {
  const raw = (retakeHome ?? '').trim();
  if (raw.length === 0) {
    return path.join(PROJECT_ROOT, 'data');
  }
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(PROJECT_ROOT, raw);
}

/** 数据根与各类子目录的解析结果（不可变快照，构造后仅读）。 */
export interface DataPaths {
  readonly home: string;
  readonly jobs: string;
  readonly materials: string;
  readonly artifacts: string;
  readonly scripts: string;
}

/** 由 RETAKE_HOME 构造目录集合（不自动建目录，建目录交给 {@link ensurePaths}）。 */
export function buildPaths(home: string): DataPaths {
  return {
    home,
    jobs: path.join(home, DIR_JOBS),
    materials: path.join(home, DIR_MATERIALS),
    artifacts: path.join(home, DIR_ARTIFACTS),
    scripts: path.join(home, DIR_SCRIPTS),
  };
}

/** 幂等建目录（服务启动时调用一次；后续写入也各自兜底）。 */
export function ensurePaths(paths: DataPaths): DataPaths {
  for (const dir of [paths.home, paths.jobs, paths.materials, paths.artifacts, paths.scripts]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}

/**
 * 产物子目录：把云端返回的临时链落到本地。
 *
 * ⚠️ 与源仓库 `MediaKitArtifactStore` 的 `directory`（形如 `btob/brand-shoot-same-drama`）同口径，
 * 这里把它映射到 RETAKE_HOME/artifacts 下，并剔除 `..` 等穿越片段，防止写到 home 之外。
 */
export function artifactDir(paths: DataPaths, subDir: string, extra?: string): string {
  const safe = subDir
    .split(/[\\/]/)
    .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..')
    .join(path.sep);
  const dir = path.join(paths.artifacts, safe, extra ?? '');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 本地绝对路径 → 供浏览器预览的相对 web 路径（`/files/...`，由 server 静态目录挂载）。 */
export function webPathOf(paths: DataPaths, localPathOrUrl: string): string {
  const value = (localPathOrUrl ?? '').trim();
  if (value.length === 0) {
    return '';
  }
  // 已经是 http(s)/tos 协议地址：原样返回，交给前端直接播
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return value;
  }
  const abs = path.isAbsolute(value) ? path.normalize(value) : path.resolve(paths.home, value);
  const rel = path.relative(paths.home, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    // 落在 home 之外（例如用户手工登记的别处文件）：不暴露绝对路径，返回空由调用方决定回退
    return '';
  }
  return '/files/' + rel.split(path.sep).join('/');
}
