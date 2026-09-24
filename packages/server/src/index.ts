/**
 * 本地 HTTP 服务入口（规格 §3 / §8）。
 *
 * 启动顺序刻意做成「配置先于一切」：
 * 1. 读 `.env`（不覆盖已有环境变量）→ 校验必填项与 ffmpeg 路径 → 缺什么直接把**开通指引**打出来并退出，
 *    避免用户对着半死的链路猜；
 * 2. 构造 Deps（云适配器 + ffmpeg + 存储，全部注入，core 不感知 HTTP）；
 * 3. 挂路由 + `/files/` 静态目录（本机成片直接浏览器预览）；
 * 4. 启动 3s 轮询调度器；进程退出时优雅停表。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import {
  type AppConfig,
  type Deps,
  buildDeps,
  loadConfig,
  loadDotEnv,
  maskedConfigView,
} from '@retake/core';
import { registerJobRoutes } from './routes/jobs.js';
import { registerMaterialRoutes, MAX_BYTES } from './routes/materials.js';
import { Scheduler } from './scheduler.js';

/** 产品版本（/api/health 回显，便于排查「我跑的是哪份代码」）。 */
const VERSION = '0.1.0';

/** v1 能力自述：让接手的人一眼看清「现在这条链到底跑到哪一步」，也方便 phase 2 对照更新。 */
const V1_SCOPE = [
  '单段 ≤15s 的真人换脸复刻 happy path：',
  '参考片(URL) → 剧本还原(trim?→ocr→asr→burn→drama→persist) → 建 job → Seedance 生成 → 轮询 → 成片落本地并预览',
].join('');

async function main(): Promise<void> {
  loadDotEnv();

  const app: FastifyInstance = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      // 本地命令行下用 ISO 时间戳，便于对着云端返回排查
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
    },
    bodyLimit: 8 * 1024 * 1024,
  });

  // 配置缺失时**不启动半成品服务**：直接把分步开通指引打出来并退出
  let config: AppConfig | null = null;
  let configError: Error | null = null;
  try {
    config = loadConfig({ ensureDirs: true });
  } catch (ex) {
    configError = ex instanceof Error ? ex : new Error(String(ex));
  }
  if (!config) {
    app.log.error(`配置不完整：${configError?.message}`);
    app.log.info('提示：复制 .env.example 为 .env 后填写各项，参考 README「开通云 Key」一节');
    await app.close();
    process.exitCode = 1;
    return;
  }

  const deps: Deps = buildDeps(config, {
    log: (level, message) => {
      if (level === 'error') {
        app.log.error(message);
      } else if (level === 'warn') {
        app.log.warn(message);
      } else {
        app.log.info(message);
      }
    },
  });

  // 上传：单文件、限尺寸；大文件走流式（见 routes/materials.ts）
  await app.register(multipart, {
    limits: { fileSize: MAX_BYTES, files: 1, fields: 8 },
  });
  // 静态挂载数据根目录：本地产物用 /files/artifacts/... 直接在浏览器里播
  await app.register(fastifyStatic, {
    root: config.paths.home,
    prefix: '/files/',
    index: false,
    // 本地文件不会多变，禁 etag 反而省事（浏览器刷新即得最新内容）
    maxAge: 0,
  });

  /** 探活 + 回显已加载的 config（Key 一律掩码，规格 §12）。 */
  app.get('/api/health', async () => {
    const running = await deps.store.jobs.listRunning();
    return {
      ok: true,
      version: VERSION,
      scope: V1_SCOPE,
      config: maskedConfigView(deps.config),
      runningJobs: running.map((job) => ({ id: job.id, status: job.status, stage: job.meta?.stage })),
      outputDestinationConfigured: deps.config.mediakit.outputDestination.length > 0,
    };
  });

  await registerMaterialRoutes(app, deps);
  await registerJobRoutes(app, deps);

  const scheduler = new Scheduler(deps);
  scheduler.start();
  app.addHook('onClose', async () => {
    scheduler.stop();
  });

  /** 浏览器打开根路径时给一份「能用什么」的清单（v1 无 UI，先当接口导航页）。 */
  app.get('/', async (_req, reply) => {
    reply.type('text/plain; charset=utf-8');
    return [
      `拍同款 · 个人本地版 retake-ai v${VERSION}（服务已就绪）`,
      '',
      '接口：',
      '  GET  /api/health                     探活 + 配置掩码回显',
      '  POST /api/materials                  以公网 URL 登记参考片（推荐）',
      '  POST /api/materials/upload           multipart 上传留档（可带 url 字段）',
      '  GET  /api/materials                  素材列表',
      '  GET  /api/materials/:id              素材详情（含剧本还原进度）',
      '  POST /api/materials/:id/retry        重跑剧本还原（可带 {"url":"..."} 补公网地址）',
      '  POST /api/jobs                       建 job（立即返回，流水线由调度器推进）',
      '  GET  /api/jobs/:id                   查进度（轮询这个）',
      '  GET  /api/jobs                       分页列表',
      '  POST /api/jobs/:id/generate          触发生成（失败任务=续跑）',
      '  POST /api/jobs/:id/resume            失败续跑',
      '  GET  /files/...                      本机数据目录静态预览（成片/剧本）',
      '',
      'v1 范围：',
      `  ${V1_SCOPE}`,
      '',
      '详细用法见 README.md。',
    ].join('\n');
  });

  try {
    await app.listen({ port: config.server.port, host: config.server.host });
  } catch (ex) {
    app.log.error(ex, '启动失败');
    process.exitCode = 1;
    return;
  }
  app.log.info(
    `retake-ai 已启动：http://${config.server.host}:${config.server.port} （数据目录 ${config.paths.home}）`,
  );
}

void main();
