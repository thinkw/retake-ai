/**
 * ffmpeg 适配层离线冒烟脚本（不需要任何云 Key，用完即可验证本机媒体链路）。
 *
 * 为什么单独有这样一个脚本：v1 链路里只有 ffprobe/ffmpeg 是**可离线验证**的一环，
 * 而它在 Windows 上最容易踩的三类问题恰好都能在这里被提前抓出来：
 *   1. 绝对路径 spawn（不走 shell、不做字符串拼接）；
 *   2. 中文/空格/反斜杠路径下的 filter 参数转义；
 *   3. stderr 捕获与超时杀进程。
 *
 * 用法：`pnpm tsx scripts/smoke-ffmpeg.ts`（可选传一个真实视频路径做探测）。
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalFfmpeg } from '../packages/core/src/adapters/ffmpeg.js';
import { buildPaths, ensurePaths, resolveHome } from '../packages/core/src/paths.js';
import { loadDotEnv } from '../packages/core/src/config.js';

loadDotEnv();

const ffmpegBin = process.env['FFMPEG_BIN'] ?? '';
const ffprobeBin = process.env['FFPROBE_BIN'] ?? '';
if (ffmpegBin.length === 0 || ffprobeBin.length === 0) {
  console.error('缺少 FFMPEG_BIN / FFPROBE_BIN（.env 未填），无法跑冒烟');
  process.exitCode = 1;
} else {
  const paths = ensurePaths(buildPaths(resolveHome(process.env['RETAKE_HOME'])));
  // 故意把工作目录放在带空格与中文的路径下，验证 Windows 路径不会把命令拆坏
  const workDir = path.join(paths.home, 'smoke 冒烟', randomUUID().slice(0, 8));
  await mkdir(workDir, { recursive: true });
  const ffmpeg = new LocalFfmpeg({ ffmpegBin, ffprobeBin });
  const clip = path.join(workDir, '源片段 中文.mp4');
  const cut = path.join(workDir, '裁切后.mp4');
  const joined = path.join(workDir, '拼接后.mp4');
  let failed = 0;

  const step = async (name: string, run: () => Promise<unknown>): Promise<unknown> => {
    try {
      const value = await run();
      console.log(`  ✓ ${name}`);
      return value;
    } catch (ex) {
      failed += 1;
      const stderr = (ex as Error & { stderr?: string }).stderr;
      console.error(`  ✗ ${name}：${(ex as Error).message}`);
      // stderr 尾部常常才是真正的 ffmpeg 报错（缺编码器 / 路径转义错 / 滤镜名写错）
      if (stderr) {
        console.error(`    stderr: ${stderr.slice(-300)}`);
      }
      return null;
    }
  };

  console.log(`ffmpeg 冒烟：bin=${ffmpegBin}`);

  // 1) 本机 ffmpeg 生成一条 3 秒彩条测试片（含音轨），作为后续所有操作的输入
  await step('生成测试片（ffmpeg testsrc + sine）', async () => {
    const { spawn } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        ffmpegBin,
        [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc=size=320x240:rate=25:duration=3',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=3',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          clip,
        ],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`生成失败 code=${code} ${stderr.slice(-200)}`)),
      );
    });
    if (!existsSync(clip)) {
      throw new Error('文件未生成');
    }
  });

  // 2) 探测时长/分辨率（状态机靠它决定 durationD 与画幅）
  const probe = await step('ffprobe 探测时长与分辨率', () => ffmpeg.probe(clip));
  if (probe) {
    const info = probe as { durationSec: number; width: number; height: number };
    console.log(`    → duration=${info.durationSec.toFixed(2)}s ${info.width}x${info.height}`);
    if (!(info.durationSec > 2.5 && info.durationSec < 3.5)) {
      failed += 1;
      console.error('    ✗ 时长不在预期区间（3s ±0.5）');
    }
  }

  // 3) 精确裁切（成片时长 D 的实现入口）
  await step('ffmpeg 裁切 [0.5, 2.5]', async () => {
    await ffmpeg.trim(clip, 0.5, 2.5, cut);
    const info = await ffmpeg.probe(cut);
    console.log(`    → 裁切后 duration=${info.durationSec.toFixed(2)}s`);
    if (!(info.durationSec > 1.6 && info.durationSec < 2.4)) {
      throw new Error(`裁切结果异常：${info.durationSec}`);
    }
  });

  // 4) 硬切拼接（phase 2 的分段拼接入口）
  await step('ffmpeg 拼接两份裁切片', async () => {
    await ffmpeg.concat([cut, cut], joined);
    const info = await ffmpeg.probe(joined);
    console.log(`    → 拼接后 duration=${info.durationSec.toFixed(2)}s`);
  });

  // 5) 字幕烧录（drama 预处理链在云上做，本机这条给 phase 2 后期加工兜底）
  await step('ffmpeg 烧录 srt 字幕', async () => {
    const srt = path.join(workDir, '测试字幕.srt');
    await writeFile(
      srt,
      '1\n00:00:00,500 --> 00:00:01,500\n中文字幕测试\n\n',
      'utf8',
    );
    const out = path.join(workDir, '带字幕.mp4');
    await ffmpeg.burnSubtitle(clip, srt, out);
    if (!existsSync(out)) {
      throw new Error('输出未生成');
    }
  });

  // 6) 坏输入必须**报错**而不是静默成功（调度器超时判失败依赖这个行为）
  await step('坏路径应抛错', async () => {
    try {
      await ffmpeg.probe(path.join(workDir, '不存在.mp4'));
    } catch {
      return 'ok';
    }
    throw new Error('探测不存在的文件竟然没报错');
  });

  console.log(failed === 0 ? `\n全部通过 ✅ 工作目录：${workDir}` : `\n失败 ${failed} 项 ❌ 工作目录：${workDir}`);
  process.exitCode = failed === 0 ? 0 : 1;
}
