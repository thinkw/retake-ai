/**
 * JSON 文件存储底座：原子写、index.jsonl 追加、进程内互斥。
 *
 * 为什么需要这些（规格 §6.5 / §8.2）：
 * - **原子写（tmp → rename）**：轮询调度器每 3s 读一次 job，半截 JSON 会让列表/进度直接崩；
 * - **进程内互斥**：本地版假设单进程，但同一 job 的两次 tick 仍可能交叠（上一次云端调用没返回），
 *   用 id 维度的 Promise 链把「读—改—写」串起来，等价于源项目 Redisson 锁的单机版替身。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** 读 JSON；不存在返回 null（调用方据此判「记录不存在」而不是抛 ENOENT）。 */
export async function readJson<T>(file: string): Promise<T | null> {
  if (!existsSync(file)) {
    return null;
  }
  try {
    const text = await readFile(file, 'utf8');
    if (text.trim().length === 0) {
      return null;
    }
    return JSON.parse(text) as T;
  } catch (ex) {
    throw new Error(`读取 ${path.basename(file)} 失败：${(ex as Error).message}`);
  }
}

/** 原子写：先写 `.tmp` 再 rename（同目录 rename 在 Windows/Linux 上都是原子的）。 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, file);
}

/** 追加一行 JSON 到 index.jsonl（列表用；失败不阻塞主流程，由调用方决定）。 */
export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value) + '\n', { encoding: 'utf8', flag: 'a' });
}

/** 逐行读 index.jsonl；坏行（半截写入）跳过。 */
export async function readJsonl<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) {
    return [];
  }
  const text = await readFile(file, 'utf8');
  const out: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // 半截行：忽略，下一次 append 会补上完整记录
    }
  }
  return out;
}

/** 目录下的 *.json 文件绝对路径（排除 .tmp）。 */
export async function listJsonFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.includes('.tmp'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/**
 * 按 key 串行的进程内互斥。
 * 用法：`await withLock('job:123', async () => {...})`；同一 key 的调用按到达顺序排队。
 */
const chains = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 把本轮排队尾巴挂上；前一轮无论成败都要放行，避免死锁
  const tail = previous.then(() => gate);
  chains.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (chains.get(key) === tail) {
      chains.delete(key);
    }
  }
}
