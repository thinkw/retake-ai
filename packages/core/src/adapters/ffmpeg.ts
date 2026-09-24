/**
 * 本地 ffmpeg / ffprobe 适配层（交接包规格 §6.4）。
 *
 * 两条硬规则（都是源项目踩过的坑，规格 §11-8）：
 * 1. **绝对路径**：本机 ffmpeg 常常不在 PATH，必须用 `.env` 里的 FFMPEG_BIN / FFPROBE_BIN 拼命令，
 *    代码里不假设可以直接 `ffmpeg` 调用；
 * 2. **参数数组 spawn，不用 shell 字符串拼接**：既防注入，也避开 PowerShell 重定向导致的中文乱码/假故障。
 *
 * retake-ai v1 **不需要浏览器渲染**（那是 hypit 渲染链路的事），只用探测/裁切/拼接/烧字幕/叠图这几条基础命令。
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { isNotBlank } from '../util/text.js';

/** ffmpeg 适配器构造参数。 */
export interface FfmpegOptions {
  ffmpegBin: string;
  ffprobeBin: string;
  /** 单次命令超时（默认 10 分钟；超时杀进程并按失败处理，避免调度器卡死） */
  timeoutMs?: number;
}

/** 子进程执行结果。 */
interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Logo / 贴图位置框（百分比坐标，与 MediaKit add-image-to-video 的 width/height/posX/posY 同口径）。 */
export interface Box {
  /** 宽度（相对画面宽度的百分比，1–100） */
  widthPct: number;
  /** 高度（相对画面高度的百分比；传 0 表示按图片比例自适应） */
  heightPct: number;
  /** 左上角 X（百分比） */
  xPct: number;
  /** 左上角 Y（百分比） */
  yPct: number;
}

/** 探测到的画面信息。 */
export interface ProbeInfo {
  durationSec: number;
  width: number;
  height: number;
}

/** ffmpeg 执行失败：带上 stderr 尾部，便于定位（不含任何 Key 信息）。 */
export class FfmpegError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.name = 'FfmpegError';
    this.stderr = stderr;
  }
}

/** ffmpeg 适配器接口（core 只依赖接口，单测可注入假实现）。 */
export interface Ffmpeg {
  probe(src: string): Promise<ProbeInfo>;
  probeDurationSec(src: string): Promise<number>;
  trim(src: string, start: number, end: number, out: string): Promise<string>;
  concat(files: string[], out: string): Promise<string>;
  burnSubtitle(src: string, srtPath: string, out: string): Promise<string>;
  overlayImage(src: string, img: string, box: Box, out: string): Promise<string>;
  download(url: string, outFile: string): Promise<string>;
}

/** 运行一条命令并收集 stdout/stderr（不经过 shell）。 */
function run(bin: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new FfmpegError(`${path.basename(bin)} 执行超时（${Math.round(timeoutMs / 1000)}s）`, stderr));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // stderr 只保留尾部 4000 字，避免超长进度条把错误信息挤掉
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      // 典型场景：FFMPEG_BIN 配了不存在的路径 → ENOENT
      reject(new FfmpegError(`${bin} 启动失败：${err.message}`, stderr));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** 本地 ffmpeg 实现（源项目里这些操作由 MediaKit 云端工具承担，本地版把确定性操作收回本机）。 */
export class LocalFfmpeg implements Ffmpeg {
  private readonly options: FfmpegOptions;
  private readonly timeoutMs: number;

  constructor(options: FfmpegOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  /**
   * 探测时长与分辨率。
   * 源实现用 javacv 的 FFmpegFrameGrabber 读远程 https；这里直接用 ffprobe —— 它同样支持 http(s) 直链，
   * 因此「本地文件」与「云端产物 URL」走同一条代码路径。
   */
  async probe(src: string): Promise<ProbeInfo> {
    const args = [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height:format=duration',
      '-of',
      'json',
      src,
    ];
    const res = await run(this.options.ffprobeBin, args, this.timeoutMs);
    if (res.code !== 0) {
      throw new FfmpegError(`ffprobe 失败（code=${res.code}）`, res.stderr);
    }
    let parsed: { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
    try {
      parsed = JSON.parse(res.stdout || '{}') as typeof parsed;
    } catch (ex) {
      throw new FfmpegError(`ffprobe 输出无法解析：${(ex as Error).message}`, res.stdout);
    }
    const stream = parsed.streams?.[0];
    const duration = Number(parsed.format?.duration ?? '0');
    return {
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : 0,
      width: Number(stream?.width ?? 0) || 0,
      height: Number(stream?.height ?? 0) || 0,
    };
  }

  /** 仅取时长（秒）；探测不到返回 0（调用方按「未知」处理，等价于源 probeVideoDuration 返回 null）。 */
  async probeDurationSec(src: string): Promise<number> {
    try {
      const info = await this.probe(src);
      return info.durationSec;
    } catch {
      return 0;
    }
  }

  /**
   * 裁切 [start, end]（重编码保证切点精确）。
   * `-ss`/`-to` 放在 `-i` 之后：按帧精确，代价是要解码前面片段——v1 素材 ≤15s，可接受。
   */
  async trim(src: string, start: number, end: number, out: string): Promise<string> {
    await ensureParentDir(out);
    const args = [
      '-y',
      '-i',
      src,
      '-ss',
      String(round3(start)),
      '-to',
      String(round3(end)),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      out,
    ];
    const res = await run(this.options.ffmpegBin, args, this.timeoutMs);
    if (res.code !== 0) {
      throw new FfmpegError(`ffmpeg trim 失败（code=${res.code}）`, res.stderr);
    }
    return out;
  }

  /** 硬切拼接（concat demuxer + 流复制；编码不一致会失败，调用方可回退 MediaKit concat-video）。 */
  async concat(files: string[], out: string): Promise<string> {
    if (files.length === 0) {
      throw new FfmpegError('concat 入参为空', '');
    }
    if (files.length === 1) {
      return files[0] ?? out;
    }
    // concat demuxer 需要一个「文件清单」，用临时目录避免污染数据目录
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'retake-concat-'));
    const listFile = path.join(tmpDir, 'list.txt');
    const list = files.map((f) => `file '${escapeConcatPath(f)}'`).join('\n');
    await writeFile(listFile, list, 'utf8');
    await ensureParentDir(out);
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out];
    const res = await run(this.options.ffmpegBin, args, this.timeoutMs);
    if (res.code !== 0) {
      throw new FfmpegError(`ffmpeg concat 失败（code=${res.code}）`, res.stderr);
    }
    return out;
  }

  /** 烧字幕（srt）；字幕路径需做 ffmpeg filter 转义。 */
  async burnSubtitle(src: string, srtPath: string, out: string): Promise<string> {
    await ensureParentDir(out);
    const args = [
      '-y',
      '-i',
      src,
      '-vf',
      `subtitles=${escapeFilterPath(srtPath)}`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-c:a',
      'copy',
      out,
    ];
    const res = await run(this.options.ffmpegBin, args, this.timeoutMs);
    if (res.code !== 0) {
      throw new FfmpegError(`ffmpeg 烧字幕失败（code=${res.code}）`, res.stderr);
    }
    return out;
  }

  /**
   * 叠 Logo：按百分比换算成像素后 scale + overlay。
   * 先 probe 源视频分辨率再算绝对像素，是因为 scale 滤镜拿不到 main_w，
   * 而 overlay 的表达式在 Windows 引号转义下极易出错——确定性换算比拼表达式更稳。
   */
  async overlayImage(src: string, img: string, box: Box, out: string): Promise<string> {
    await ensureParentDir(out);
    const info = await this.probe(src);
    const baseW = info.width > 0 ? info.width : 1080;
    const baseH = info.height > 0 ? info.height : 1920;
    const targetW = Math.max(2, Math.round((clampPct(box.widthPct) / 100) * baseW));
    const targetH = box.heightPct > 0 ? Math.max(2, Math.round((clampPct(box.heightPct) / 100) * baseH)) : -1;
    const x = Math.max(0, Math.round((clampPct(box.xPct) / 100) * baseW));
    const y = Math.max(0, Math.round((clampPct(box.yPct) / 100) * baseH));
    const args = [
      '-y',
      '-i',
      src,
      '-i',
      img,
      '-filter_complex',
      `[1:v]scale=${targetW}:${targetH}[wm];[0:v][wm]overlay=${x}:${y}`,
      '-c:a',
      'copy',
      out,
    ];
    const res = await run(this.options.ffmpegBin, args, this.timeoutMs);
    if (res.code !== 0) {
      throw new FfmpegError(`ffmpeg 叠图失败（code=${res.code}）`, res.stderr);
    }
    return out;
  }

  /** 下载远端产物到本地文件（含 volces.com → ivolces.com 的国内网络兜底重试，源：downloadVideoBytes）。 */
  async download(url: string, outFile: string): Promise<string> {
    await ensureParentDir(outFile);
    try {
      return await downloadToFile(url, outFile);
    } catch (first) {
      const fallback = url.replace('.volces.com', '.ivolces.com');
      if (fallback !== url) {
        try {
          return await downloadToFile(fallback, outFile);
        } catch {
          throw first;
        }
      }
      throw first;
    }
  }
}

/** 三位小数（避免把浮点尾数写进命令行）。 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 百分比钳制到 [0,100]。 */
function clampPct(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

/** concat 清单里的路径：单引号需按 ffmpeg 规则转义。 */
function escapeConcatPath(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
}

/**
 * ffmpeg filter 路径转义：Windows 盘符冒号与反斜杠在 filter 语法里都要转义，
 * 否则 `subtitles=C:\xxx.srt` 会被解析成参数分隔符。
 */
function escapeFilterPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return `'${normalized.replace(/:/g, '\\:').replace(/'/g, "\\'")}'`;
}

/**
 * 把远端 URL 下载到本地文件（供 artifact 适配器复用）。
 * 用 fetch + 流式写盘，不一次读进内存：成片可能有几百 MB。
 */
export async function downloadToFile(url: string, outFile: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
  if (!response.ok || !response.body) {
    throw new FfmpegError(`下载失败 HTTP ${response.status}：${url.slice(0, 120)}`, '');
  }
  await ensureParentDir(outFile);
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(outFile);
    stream.on('finish', () => resolve());
    stream.on('error', reject);
    Readable.fromWeb(response.body as never).pipe(stream);
  });
  return outFile;
}

/** 保证目标文件的父目录存在（写产物前调用）。 */
export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

/** 该字符串是否是「本地文件路径」（而非 http(s)/tos/asset 协议地址）。 */
export function isLocalPath(value: string): boolean {
  return isNotBlank(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim());
}
