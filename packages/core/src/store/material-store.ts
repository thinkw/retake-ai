/**
 * 本地素材库存储（规格 §3：`store/material-store.ts`），替代源仓库的 `ai_viral_material` 表。
 *
 * 一个素材一个 JSON：`RETAKE_HOME/materials/<id>.json`；`analysis` blob 里既放剧本还原结果，
 * 也放 prepare 流水线进度（`prepareStage` / `prepareTaskId` / `prepareStartTs`），与源实现同构。
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DataPaths } from '../paths.js';
import {
  ANALYZE_PENDING,
  ANALYZE_RUNNING,
  MATERIAL_STATUSES,
  SANITIZE_SKIPPED,
  STAGE_INIT,
  type MaterialScriptStatus,
} from '../pipeline/stages.js';
import type { Material, MaterialSummary, PageReq, PageResp } from '../types.js';
import { PIPELINE } from '../pipeline/stages.js';
import { listJsonFiles, readJson, withLock, writeJsonAtomic } from './json-file.js';

export class MaterialStore {
  private readonly paths: DataPaths;

  constructor(paths: DataPaths) {
    this.paths = paths;
  }

  private file(id: string): string {
    return path.join(this.paths.materials, `${safeId(id)}.json`);
  }

  /** 登记素材（URL 或本地留档路径均可；剧本还原状态从 pending 起）。 */
  async create(seed: Partial<Material>): Promise<Material> {
    const now = Date.now();
    const material: Material = {
      id: seed.id ?? randomUUID(),
      createdAt: seed.createdAt ?? now,
      updatedAt: now,
      name: seed.name ?? '未命名素材',
      url: seed.url ?? '',
      localPath: seed.localPath,
      size: seed.size,
      format: seed.format,
      duration: seed.duration,
      analyzeStatus: seed.analyzeStatus ?? ANALYZE_PENDING,
      sanitizeStatus: seed.sanitizeStatus ?? SANITIZE_SKIPPED,
      analyzeError: seed.analyzeError,
      analyzeStartedAt: seed.analyzeStartedAt,
      trimTailSeconds: seed.trimTailSeconds ?? 0,
      segmentMaxSeconds: seed.segmentMaxSeconds,
      // 源实现建素材时只写 pipeline 标记，其余由剧本还原填
      analysis: seed.analysis ?? { pipeline: PIPELINE, prepareStage: STAGE_INIT },
      scriptPath: seed.scriptPath,
      coverUrl: seed.coverUrl,
      keyframeUrls: seed.keyframeUrls,
    };
    await this.save(material);
    return material;
  }

  async get(id: string): Promise<Material | null> {
    return readJson<Material>(this.file(id));
  }

  async save(material: Material): Promise<void> {
    material.updatedAt = Date.now();
    await writeJsonAtomic(this.file(material.id), material);
  }

  /** 单个素材的串行读改写（剧本还原链路的 tick 用）。 */
  async withMaterialLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    return withLock(`material:${id}`, task);
  }

  /**
   * 领取待处理素材：把 `pending` 原子改成 `running`（源：casClaim 的 SQL 守卫）。
   * 本地版在锁内「读—判—写」，语义等价（单进程下不存在跨进程竞争）。
   */
  async casClaim(id: string): Promise<Material | null> {
    return this.withMaterialLock(id, async () => {
      const current = await this.get(id);
      if (!current || current.analyzeStatus !== ANALYZE_PENDING) {
        return null;
      }
      current.analyzeStatus = ANALYZE_RUNNING;
      current.analyzeStartedAt = Date.now();
      current.analyzeError = undefined;
      await this.save(current);
      return current;
    });
  }

  /** 分页列表（按 createdAt 倒序；可按剧本还原状态过滤）。 */
  async list(page: PageReq, analyzeStatus?: string): Promise<PageResp<MaterialSummary>> {
    const all = await this.readAll();
    // 与源一致：只认 drama 的四种状态，脏数据不进列表
    const scoped = all.filter((row) => (MATERIAL_STATUSES as readonly string[]).includes(row.analyzeStatus));
    const filtered =
      analyzeStatus && (MATERIAL_STATUSES as readonly string[]).includes(analyzeStatus)
        ? scoped.filter((row) => row.analyzeStatus === analyzeStatus)
        : scoped;
    filtered.sort((a, b) => b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id)));
    const pageNo = Math.max(1, page.pageNo);
    const pageSize = Math.max(1, Math.min(page.pageSize, 100));
    const start = (pageNo - 1) * pageSize;
    return {
      total: filtered.length,
      items: filtered.slice(start, start + pageSize).map(toSummary),
    };
  }

  /** 处于某个剧本还原状态的素材（调度器找 running/pending 用）。 */
  async byStatus(status: MaterialScriptStatus): Promise<Material[]> {
    const all = await this.readAll();
    return all.filter((row) => row.analyzeStatus === status);
  }

  private async readAll(): Promise<Material[]> {
    const files = await listJsonFiles(this.paths.materials);
    const out: Material[] = [];
    for (const file of files) {
      const row = await readJson<Material>(file);
      if (row && row.id) {
        out.push(row);
      }
    }
    return out;
  }
}

/** 素材摘要（源：toMaterialResp 的 shootReady 口径：剧本 ready 才可建 job）。 */
function toSummary(material: Material): MaterialSummary {
  return {
    id: material.id,
    name: material.name,
    url: material.url,
    duration: material.duration,
    analyzeStatus: material.analyzeStatus,
    sanitizeStatus: material.sanitizeStatus,
    analyzeError: material.analyzeError,
    shootReady: material.analyzeStatus === 'script_ready',
    createdAt: material.createdAt,
  };
}

/** 文件名安全（防路径穿越）。 */
function safeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, '');
  if (cleaned.length === 0) {
    throw new Error('非法 materialId');
  }
  return cleaned;
}
