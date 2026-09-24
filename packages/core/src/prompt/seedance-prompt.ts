/**
 * 剧本 → Seedance prompt 拼装（**本产品的核心 know-how**）。
 *
 * 逐字移植源仓库 `service/btob/drama/DramaScriptSeedancePromptBuilder.java`（743 行）：
 * 所有中文串、标点、顺序、钳制规则都按源实现照搬（规格 §9「移植时逐字照搬源仓库常量，不要自己发挥文案」）。
 *
 * 组装结构：清洗后的 Plot+Camera+Visual 在前，对白轴在后；超 500 字不在这里截 Plot，
 * 由 `prompt-length-compressor.ts` 只压缩画面块（源注释）。
 */

import { Segment } from '../planner/segment-planner.js';
import { clampSegmentDuration } from '../planner/limits.js';
import type { SeedanceSubmitReq } from '../adapters/seedance.js';
import type { JsonMap } from '../util/maps.js';
import { listOfMaps, num, strOf, trim1 } from '../util/maps.js';
import { blankToDefault, isBlank, isNotBlank, nullToEmpty, trim } from '../util/text.js';
import { PROMPT_MAX_LENGTH } from './video-prompt-utils.js';

/** 禁字幕标记（源：NO_SUBTITLE_MARK，压缩器会按此串剥离 LLM 复读的头尾）。 */
export const NO_SUBTITLE_MARK = '禁止出现字幕';

/** 一个镜头（源：record Shot：start/end/plot/desc + 运镜与画面参数）。 */
export interface Shot {
  start: number;
  end: number;
  plot: string;
  desc: string;
  shotSize: string;
  movement: string;
  angle: string;
  height: string;
  direction: string;
  lens: string;
  lighting: string;
  colorTone: string;
  style: string;
  blur: string;
}

/** 对白轴视图（源：record CueView）。 */
interface CueView {
  start: number;
  end: number;
  text: string;
  people: string;
  emotion: string;
}

/**
 * 可分段替换的 prompt 草稿（源：record Draft）。
 * `stitchVisual` 把「画面块」换成任意文本后再把头尾/图/音/对白拼回，压缩器正是利用这一点只动画面块。
 */
export class Draft {
  constructor(
    readonly visual: string,
    readonly images: string,
    readonly audio: string,
    readonly dialogueBlock: string,
  ) {}

  stitch(): string {
    return this.stitchVisual(this.visual);
  }

  stitchVisual(visualText: string): string {
    let vis = visualText ?? '';
    if (vis.length > 0 && vis.charAt(vis.length - 1) !== '\n') {
      vis = vis + '\n';
    }
    return (
      NO_SUBTITLE_MARK +
      '\n' +
      vis +
      nullToEmpty(this.images) +
      nullToEmpty(this.audio) +
      nullToEmpty(this.dialogueBlock) +
      NO_SUBTITLE_MARK
    );
  }

  /** 除画面块之外的固定部分长度（源：frozenLength）。 */
  frozenLength(): number {
    return this.stitchVisual('').length;
  }
}

/** 完整 prompt（源：build）。 */
export function build(
  analysis: JsonMap,
  segment: Segment,
  segmentIndex: number,
  segmentCount: number,
  personCount: number,
  hasFirstFrame: boolean,
  hasReferenceAudio: boolean,
): string {
  return draft(analysis, segment, segmentIndex, segmentCount, personCount, hasFirstFrame, hasReferenceAudio).stitch();
}

/**
 * 组装草稿。
 * `segmentIndex` / `segmentCount` 在源实现里未被使用（保留形参以便与 Java 一对一对照，
 * 也留给 phase 2 的「第 N/M 段」措辞）。
 */
export function draft(
  analysis: JsonMap,
  segment: Segment,
  _segmentIndex: number,
  _segmentCount: number,
  personCount: number,
  hasFirstFrame: boolean,
  hasReferenceAudio: boolean,
): Draft {
  const images = imageLines(personCount, hasFirstFrame);
  const audio = hasReferenceAudio ? '参考音频只用于音色；口播以下面对白轴为准，须按标注的说话人开口。\n' : '';
  const dialogues = formatDialogues(analysis, segment.start, segment.end);
  let dialogueBlock: string;
  if (isNotBlank(dialogues)) {
    dialogueBlock = '须按下列时间由标注人物开口，禁止把几句口播连读完再换景。\n' + dialogues.trim() + '\n';
  } else {
    dialogueBlock = '本段无口播。\n';
  }
  const allShots = listShots(analysis);
  const shots = shotsOverlapping(allShots, segment.start, segment.end);
  const allCues = listCues(analysis);
  const visual = formatVisuals(allShots, shots, segment, allCues);
  return new Draft(visual, images, audio, dialogueBlock);
}

/**
 * 提交请求组装（源：buildSubmit）。
 * 与源一致的两条关键规则：
 * - 有时长钳到 [4,15]、比例缺省 9:16、`return_last_frame=true`、`generate_audio=true`、不出字幕；
 * - **参考图上限 9 张**：有尾帧占位时人像最多 8 张（超出直接截断）。
 */
export function buildSubmit(
  prompt: string,
  durationSec: number,
  aspectRatio: string,
  firstFrameUrl: string,
  personAssets: string[],
  audioUrl: string,
): SeedanceSubmitReq {
  const hasFirstFrame = isNotBlank(firstFrameUrl);
  const req: SeedanceSubmitReq = {
    prompt,
    durationSec: clampSegmentDuration(durationSec),
    ratio: blankToDefault(aspectRatio, '9:16'),
    portraits: [],
  };
  if (hasFirstFrame) {
    req.firstFrameUrl = firstFrameUrl.trim();
  }
  req.returnLastFrame = true;
  const portraits = personAssets ?? [];
  if (portraits.length > 0) {
    const cap = hasFirstFrame ? 8 : 9;
    req.portraits = portraits.length > cap ? portraits.slice(0, cap) : portraits;
  }
  if (isNotBlank(audioUrl)) {
    req.audioUrl = audioUrl;
  }
  return req;
}

/** 参考图说明行（源：imageLines）。 */
function imageLines(personCount: number, hasFirstFrame: boolean): string {
  if (hasFirstFrame) {
    let line = '第 1 张参考图是上一段结尾，只接下文相对该图的变化。';
    if (personCount > 0) {
      line += '出场人物对应第 2 张起的参考图（按顺序）。\n';
    } else {
      line += '\n';
    }
    return line;
  }
  if (personCount > 0) {
    return '出场人物对应第 1 张起的参考图（按顺序）。\n';
  }
  return '';
}

/** 对白轴：`0.0~3.2秒；张三说：“……”（语气）`（源：formatDialogues）。 */
export function formatDialogues(analysis: JsonMap, start: number, end: number): string {
  const all = listCues(analysis);
  const parts: string[] = [];
  for (const cue of all) {
    if (!cueStartsInWindow(cue.start, start, end)) {
      continue;
    }
    const localStart = Math.max(0, cue.start - start);
    const localEnd = Math.max(localStart, cue.end - start);
    if (localEnd - localStart < 0.15) {
      continue;
    }
    let line = trim1(localStart) + '~' + trim1(localEnd) + '秒';
    line += '；';
    if (isNotBlank(cue.people)) {
      line += cue.people.trim();
    }
    line += `说：\u201C${cue.text}\u201D`;
    if (isNotBlank(cue.emotion) && cue.emotion.length <= 16) {
      line += `（${cue.emotion.trim()}）`;
    }
    parts.push(line);
  }
  if (parts.length === 0) {
    return '';
  }
  return parts.map((p) => p + '\n').join('');
}

/** 画面块：多镜头时带相对秒数窗口，单镜头直接「画面：」（源：formatVisuals）。 */
function formatVisuals(
  allShots: Shot[],
  shots: Shot[],
  segment: Segment,
  allCues: CueView[],
): string {
  if (shots.length === 0) {
    return '';
  }
  const multi = shots.length > 1;
  let sb = '';
  for (const shot of shots) {
    const clipStart = Math.max(shot.start, segment.start);
    const clipEnd = Math.min(shot.end, segment.end);
    const plot = plotForWindow(shot, nextAfter(allShots, shot), segment, allCues);
    const cam = cameraText(shot, false);
    const vis = visualText(shot);
    if (isBlank(plot) && isBlank(cam) && isBlank(vis)) {
      continue;
    }
    if (multi) {
      sb += trim1(Math.max(0, clipStart - segment.start)) + '~' + trim1(Math.max(0, clipEnd - segment.start)) + '秒画面：';
    } else {
      sb += '画面：';
    }
    sb += blankToDefault(plot, '接着上一段画面演。');
    if (isNotBlank(cam)) {
      sb += '。' + cam;
    }
    if (isNotBlank(vis)) {
      sb += '。' + vis;
    }
    sb += '\n';
  }
  return sb;
}

function nextAfter(all: Shot[], current: Shot): Shot | null {
  const idx = all.indexOf(current);
  if (idx < 0 || idx + 1 >= all.length) {
    return null;
  }
  return all[idx + 1];
}

/** 段窗口内该镜头的 plot（被切开时用 cropPlot 裁，裁不出来退化成地点提示 / 续演提示）。 */
function plotForWindow(shot: Shot, next: Shot | null, segment: Segment, allCues: CueView[]): string {
  const partial = segment.start > shot.start + 0.15 || segment.end < shot.end - 0.15;
  const firstSlice = segment.start <= shot.start + 0.15;
  const raw = firstNonBlankStr(shot.plot, shot.desc);
  let plot: string;
  if (!partial) {
    plot = cleanPlot(raw);
  } else {
    const cropped = cropPlot(raw, shot, segment.start, segment.end, allCues, firstSlice);
    if (isNotBlank(cropped)) {
      plot = cropped;
    } else {
      const loc = locationHint(shot.desc);
      if (isNotBlank(loc)) {
        plot = firstSlice ? loc : loc + '。接着上一段结尾继续演，不要重来';
      } else {
        plot = firstSlice ? '' : '接着上一段结尾继续演，不要重演已经过去的画面';
      }
    }
  }
  return stripCrossShotTail(plot, next);
}

/**
 * 按对白窗口裁 plot：命中「窗口内话题/原文」的句子保留，环境句在首片时保留（源：cropPlot）。
 * 这是「一段只演该演的事」的关键——否则模型会把整镜剧情一次演完导致跨段漂移。
 */
export function cropPlot(
  text: string,
  shot: Shot,
  winStart: number,
  winEnd: number,
  allCues: CueView[],
  firstSlice: boolean,
): string {
  let sentences = splitSentences(cleanPlot(text));
  if (sentences.length === 0) {
    sentences = splitSentences(text);
  }
  const windowTopics = new Set<string>();
  const windowTexts = new Set<string>();
  const shotTopics = new Set<string>();
  for (const cue of allCues) {
    if (cue.start >= shot.start - 0.05 && cue.start < shot.end) {
      for (const topic of topicsOfCue(cue.text)) {
        shotTopics.add(topic);
      }
    }
    if (cueStartsInWindow(cue.start, winStart, winEnd)) {
      for (const topic of topicsOfCue(cue.text)) {
        windowTopics.add(topic);
      }
      if (isNotBlank(cue.text)) {
        windowTexts.add(cue.text.trim());
      }
    }
  }
  const outTopics = new Set<string>([...shotTopics]);
  // 源：outTopics = shotTopics 去掉 windowTopics（「本段之前已经演过的事」不能再写进画面块）
  for (const topic of windowTopics) {
    outTopics.delete(topic);
  }
  const kept: string[] = [];
  for (const sentence of sentences) {
    if (looksLikeJunk(sentence)) {
      continue;
    }
    if (firstSlice && isEnvironmentSentence(sentence, shotTopics)) {
      kept.push(sentence);
      continue;
    }
    if (hitsAny(sentence, windowTexts) || clauseMatches(sentence, windowTopics, outTopics)) {
      kept.push(sentence);
    }
  }
  return joinSentences(kept);
}

/** 去掉「字幕/画外音/环境音」等垃圾句（源：cleanPlot）。 */
export function cleanPlot(text: string): string {
  if (isBlank(text)) {
    return '';
  }
  const kept: string[] = [];
  for (const sentence of splitSentences(text)) {
    if (!looksLikeJunk(sentence)) {
      kept.push(sentence);
    }
  }
  return joinSentences(kept);
}

/** 跨镜泄漏清理（源：stripCrossShotTail(Shot next)）。 */
export function stripCrossShotTail(plot: string, next: Shot | null): string {
  if (isBlank(plot) || next === null) {
    return plot ?? '';
  }
  return stripCrossShotTailFrom(plot, firstNonBlankStr(next.plot, next.desc));
}

/** 只检查最后两句：像切镜且目的地属于下一镜 ⇒ 丢掉（源：stripCrossShotTail(String,String)）。 */
export function stripCrossShotTailFrom(plot: string, nextPlot: string): string {
  const sentences = splitSentences(plot);
  if (sentences.length === 0 || isBlank(nextPlot)) {
    return plot ?? '';
  }
  const from = Math.max(0, sentences.length - 2);
  const earlier = joinSentences(sentences.slice(0, from));
  const kept: string[] = [...sentences.slice(0, from)];
  for (let i = from; i < sentences.length; i++) {
    const sentence = sentences[i] as string;
    if (isCrossShotLeak(sentence, earlier, nextPlot)) {
      continue;
    }
    kept.push(sentence);
  }
  return joinSentences(kept);
}

export function isCrossShotLeak(sentence: string, earlier: string, nextPlot: string): boolean {
  if (!looksLikeSceneCut(sentence)) {
    return false;
  }
  const dest = destinationOfCut(sentence);
  if (sharesSignificant(dest, nextPlot)) {
    return true;
  }
  return looksLikePlaceShift(dest) && !sharesSignificant(dest, earlier);
}

/** 是否像「切到另一处」（排除「景别切换为…」这种同一镜内的描述）。 */
export function looksLikeSceneCut(clause: string): boolean {
  if (clause.includes('景别') || clause.includes('切换为') || clause.includes('切换成')) {
    return false;
  }
  return (
    clause.includes('切换至') ||
    clause.includes('切换到') ||
    clause.includes('切到') ||
    clause.includes('画面切换') ||
    (clause.includes('最后画面') && (clause.includes('切') || clause.includes('换')))
  );
}

/** 取「切到 X」里的 X（源：destinationOfCut）。 */
export function destinationOfCut(clause: string): string {
  let at = indexOfAny(clause, '画面切换至', '画面切换到', '切换至', '切换到', '切到');
  if (at < 0) {
    at = indexOfAny(clause, '切换');
  }
  if (at < 0) {
    return clause;
  }
  return clause.slice(at).replace(/^(画面)?(切换至|切换到|切到|切换)/, '').trim();
}

function looksLikePlaceShift(dest: string): boolean {
  return (
    dest.includes('区域') ||
    dest.includes('堆放') ||
    dest.includes('仓库') ||
    dest.includes('场地') ||
    dest.includes('厂区') ||
    dest.includes('场景')
  );
}

/** 四字滑窗重合判定（源：sharesSignificant；对中文分词缺失的最小可用替代）。 */
export function sharesSignificant(a: string, b: string): boolean {
  if (isBlank(a) || isBlank(b)) {
    return false;
  }
  for (let i = 0; i <= a.length - 4; i++) {
    const w = a.slice(i, i + 4);
    if (isStopWindow(w)) {
      continue;
    }
    if (b.includes(w)) {
      return true;
    }
  }
  return false;
}

function isStopWindow(w: string): boolean {
  return (
    w.includes('男子') ||
    w.includes('出镜') ||
    w.includes('镜头') ||
    w.includes('画面') ||
    w.includes('随后') ||
    w.includes('最后') ||
    w.includes('站在') ||
    w.includes('背景') ||
    w.includes('中央') ||
    w.includes('场景')
  );
}

/** 按句号/分号/换行切句，丢弃长度 < 2 的碎片（源：splitSentences）。 */
export function splitSentences(text: string): string[] {
  if (isBlank(text)) {
    return [];
  }
  const out: string[] = [];
  for (const part of text.split(/[。；;\n]+/)) {
    const t = part.trim();
    if (t.length >= 2) {
      out.push(t);
    }
  }
  return out;
}

function joinSentences(sentences: string[] | null): string {
  if (sentences === null || sentences.length === 0) {
    return '';
  }
  return sentences.join('。');
}

function isEnvironmentSentence(sentence: string, shotTopics: Set<string>): boolean {
  return !containsAnyTopic(sentence, shotTopics);
}

function containsAnyTopic(sentence: string, topics: Set<string>): boolean {
  for (const topic of topics) {
    if (topic !== null && topic.length >= 2 && sentence.includes(topic)) {
      return true;
    }
  }
  return false;
}

function hitsAny(sentence: string, texts: Set<string>): boolean {
  for (const text of texts) {
    if (text.length >= 2 && sentence.includes(text)) {
      return true;
    }
  }
  return false;
}

function looksLikeJunk(clause: string): boolean {
  return looksLikeSubtitle(clause) || looksLikeSpokenDump(clause) || looksLikeAmbient(clause);
}

function looksLikeSpokenDump(clause: string): boolean {
  return (
    clause.includes('画外') ||
    clause.includes('旁白') ||
    clause.includes('说：\u201C') ||
    clause.includes('说:“') ||
    clause.includes('说:"') ||
    clause.includes('说道') ||
    clause.includes('语气说')
  );
}

function looksLikeAmbient(clause: string): boolean {
  if (
    clause.includes('嗡鸣') ||
    clause.includes('背景音') ||
    clause.includes('环境音') ||
    clause.includes('喜剧笑声') ||
    clause.includes('背景音乐')
  ) {
    return true;
  }
  return clause.includes('传来') && (clause.includes('声') || clause.includes('音'));
}

/** 运镜文本：景别/运镜（coreOnly 时只出这两项），再补角度/高度/方向/焦距。 */
function cameraText(shot: Shot, coreOnly: boolean): string {
  const parts: string[] = [];
  addLabeled(parts, '景别', shot.shotSize);
  addLabeled(parts, '运镜', shot.movement);
  if (!coreOnly) {
    addLabeled(parts, '角度', shot.angle);
    addLabeled(parts, '高度', shot.height);
    addLabeled(parts, '方向', shot.direction);
    addLabeled(parts, '焦距', shot.lens);
  }
  return parts.join('，');
}

/** 画面文本：光线/色调/风格/虚化。 */
function visualText(shot: Shot): string {
  const parts: string[] = [];
  addLabeled(parts, '光线', shot.lighting);
  addLabeled(parts, '色调', shot.colorTone);
  addLabeled(parts, '风格', shot.style);
  addLabeled(parts, '虚化', shot.blur);
  return parts.join('，');
}

function addLabeled(parts: string[], label: string, value: string): void {
  if (isNotBlank(value)) {
    parts.push(label + value.trim());
  }
}

/** 对白是否落在窗口内（按**起始时间**判定，源：cueStartsInWindow）。 */
export function cueStartsInWindow(cueStart: number, winStart: number, winEnd: number): boolean {
  return cueStart >= winStart && cueStart < winEnd;
}

/**
 * 从一句台词里抽「话题词」，并补若干别名（源：topicsOfCue）。
 * ⚠️ 里面保留了源项目针对具体爆款样本写的品牌词特例（小米之家/拍个视频/扫地机器人）：
 *    这是源实现的真实形状，先按「逐字照搬」移植，泛化成可配置词表是 phase 2 的事（见 README「已知取舍」）。
 */
export function topicsOfCue(text: string): string[] {
  const out = new Set<string>();
  if (isBlank(text)) {
    return [];
  }
  const topic = topicOf(text);
  addTopicWithAlias(out, topic);
  if (text.includes('小米之家') || topic === '小米之家') {
    out.add('入口');
  }
  if (text.includes('拍个视频') || text.includes('拍视频')) {
    out.add('拍个视频');
    out.add('拍视频');
    out.add('柜台');
  }
  if (text.includes('娱乐一下')) {
    out.add('娱乐一下');
  }
  if (text.includes('哈哈哈')) {
    out.add('哈哈哈');
  }
  return [...out];
}

/** 台词主题短语：去尾部语气标点、去「吗」、剥固定前缀、取首个逗号前（源：topicOf）。 */
export function topicOf(text: string): string {
  if (isBlank(text)) {
    return '';
  }
  let t = text.trim();
  t = t.replace(/[。！？!?…]+$/, '');
  t = t.replace(/吗$/, '');
  const prefixes = [
    '不，我今天就不介绍',
    '不，我也不介绍',
    '不，我不介绍',
    '你以为我要介绍我们',
    '你以为我要介绍',
    '你以为我真的要开始',
    '我今天就不介绍',
    '我也不介绍',
    '我不介绍',
  ];
  for (const prefix of prefixes) {
    if (t.startsWith(prefix)) {
      t = t.slice(prefix.length);
      break;
    }
  }
  t = t.replace(/^[，,、\s]+/, '');
  const comma = indexOfAny(t, '，', ',');
  if (comma > 1) {
    const first = t.slice(0, comma).trim();
    if (!isGenericTopic(first)) {
      t = first;
    }
  }
  return t.trim();
}

function addTopicWithAlias(topics: Set<string>, topic: string): void {
  if (isGenericTopic(topic)) {
    return;
  }
  topics.add(topic);
  if (topic.startsWith('小米') && topic.length > 2) {
    const rest = topic.slice(2);
    if (!isGenericTopic(rest)) {
      topics.add(rest);
    }
  }
  if (topic.includes('扫地机器人') && topic !== '扫地机') {
    topics.add('扫地机');
  }
}

/** 太泛的话题（「产品」「开始介绍」）不能当匹配键（源：isGenericTopic）。 */
export function isGenericTopic(topic: string | null): boolean {
  if (topic === null || topic.length < 2) {
    return true;
  }
  const n = topic.replace(/[\s，,。！？!?]+/g, '');
  if (n.length < 2) {
    return true;
  }
  return (
    n === '产品' || n.includes('介绍产品') || n === '开始介绍' || n.startsWith('产品我就') || n.startsWith('产品，')
  );
}

/** 对白轴来源：优先 dialogues，回退 asrSubtitles（源：listCues）。 */
export function listCues(analysis: JsonMap | null): CueView[] {
  const out: CueView[] = [];
  if (analysis === null || analysis === undefined) {
    return out;
  }
  let raw: unknown = analysis['dialogues'];
  if (!Array.isArray(raw)) {
    raw = analysis['asrSubtitles'];
  }
  for (const item of listOfMaps(raw)) {
    let text = strOf(item['text']);
    if (isBlank(text)) {
      text = strOf(item['content']);
    }
    if (isBlank(text)) {
      continue;
    }
    const s = num(item, 'startTime', num(item, 'start', 0));
    const e = num(item, 'endTime', num(item, 'end', s));
    let people = firstNonBlankStr(strOf(item['people']), strOf(item['People']));
    if (isBlank(people)) {
      people = strOf(item['speaker']);
    }
    const emotion = firstNonBlankStr(strOf(item['emotion']), strOf(item['Emotion']));
    if (e > s) {
      out.push({ start: s, end: e, text, people, emotion });
    }
  }
  return out;
}

/**
 * 镜头列表：有 Scenes[].Segments 就摊平到细镜头，否则整场当一个镜头（源：listShots）。
 * 兼容大小写字段（Plot/plot、Start/start、StartInVideo…）——云端剧本包的字段风格并不统一。
 */
export function listShots(analysis: JsonMap | null): Shot[] {
  const out: Shot[] = [];
  const scenes = analysis?.['scenes'];
  if (!analysis || !Array.isArray(scenes)) {
    return out;
  }
  for (const scene of listOfMaps(scenes)) {
    const ss = num(scene, 'startTime', num(scene, 'StartTime', 0));
    const se = num(scene, 'endTime', num(scene, 'EndTime', ss));
    const desc = strOf(scene['desc']);
    const plot = strOf(scene['plot']);
    let anyInner = false;
    for (const segMap of listOfMaps(scene['segments'])) {
      const is = innerClock(segMap, true, ss);
      const ie = innerClock(segMap, false, se);
      if (ie <= is) {
        continue;
      }
      anyInner = true;
      const innerPlot = firstNonBlankStr(strOf(segMap['Plot']), strOf(segMap['plot']));
      out.push(shotFrom(is, ie, innerPlot, desc, segMap));
    }
    if (!anyInner && se > ss) {
      out.push(shotFrom(ss, se, plot, desc, scene));
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** 细镜头的起止时钟：StartInMillis > Start/start > startTime/StartInVideo（源：innerClock + msOrSec）。 */
function innerClock(segMap: JsonMap, isStart: boolean, fallback: number): number {
  const millisKey = isStart ? 'StartInMillis' : 'EndInMillis';
  const millis = segMap[millisKey];
  if (millis !== null && millis !== undefined && Number.isFinite(Number(millis))) {
    // 带 InMillis 后缀的字段语义明确是毫秒，一律 /1000（源：millisToSec）
    return Number(millis) / 1000;
  }
  const a = segMap[isStart ? 'Start' : 'End'];
  const b = segMap[isStart ? 'start' : 'end'];
  const c = segMap[isStart ? 'startTime' : 'endTime'] ?? segMap[isStart ? 'StartInVideo' : 'EndInVideo'];
  const value = firstNumOf(a, b, c);
  return value === null ? fallback : value;
}

function firstNumOf(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    const parsed = typeof value === 'number' ? value : Number(String(value).trim());
    if (Number.isFinite(parsed)) {
      // 与源 msOrSec 一致：≥1000 判毫秒
      return parsed >= 1000 ? parsed / 1000 : parsed;
    }
  }
  return null;
}

/** 由原始 map 造 Shot：优先扁平字段，再退到 Camera/Visual 嵌套对象（源：shotFrom + pick）。 */
function shotFrom(start: number, end: number, plot: string, desc: string, map: JsonMap): Shot {
  const cam = nestedMap(map['Camera'], map['camera']);
  const vis = nestedMap(map['Visual'], map['visual']);
  return {
    start,
    end,
    plot,
    desc,
    shotSize: pick(map, 'shotSize', cam, 'ShotSize', 'shotSize'),
    movement: pick(map, 'movement', cam, 'Movement', 'movement'),
    angle: pick(map, 'angle', cam, 'Angle', 'angle'),
    height: pick(map, 'height', cam, 'Height', 'height'),
    direction: pick(map, 'direction', cam, 'Direction', 'direction'),
    lens: pick(map, 'lensFocalLength', cam, 'LensFocalLength', 'lensFocalLength'),
    lighting: pick(map, 'lighting', vis, 'Lighting', 'lighting'),
    colorTone: pick(map, 'colorTone', vis, 'ColorTone', 'colorTone'),
    style: pick(map, 'style', vis, 'Style', 'style'),
    blur: pick(map, 'backgroundBlur', vis, 'BackgroundBlur', 'backgroundBlur'),
  };
}

function nestedMap(a: unknown, b: unknown): JsonMap {
  for (const candidate of [a, b]) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as JsonMap;
    }
  }
  return {};
}

/** 先取扁平字段，再按候选键取嵌套字段（源：pick）。 */
function pick(flat: JsonMap, flatKey: string, nested: JsonMap, ...keys: string[]): string {
  const direct = strOf(flat[flatKey]);
  if (isNotBlank(direct)) {
    return direct;
  }
  for (const key of keys) {
    const value = strOf(nested[key]);
    if (isNotBlank(value)) {
      return value;
    }
  }
  return '';
}

/** 与段窗口有交集的镜头（0.05s 容差；源：shotsOverlapping）。 */
function shotsOverlapping(shots: Shot[], start: number, end: number): Shot[] {
  return shots.filter((shot) => shot.start < end - 0.05 && shot.end > start + 0.05);
}

/** 从 desc 里取前 80 字当「地点提示」（源：locationHint）。 */
export function locationHint(desc: string): string {
  if (isBlank(desc)) {
    return '';
  }
  let t = desc.trim();
  const cut = indexOfAny(t, '依次', '全程搭配');
  if (cut > 8) {
    t = t.slice(0, cut).replace(/[，,\s]+$/, '');
  }
  const period = t.indexOf('。');
  if (period > 0) {
    t = t.slice(0, period);
  }
  if (t.length > 80) {
    t = t.slice(0, 80);
  }
  return t;
}

/** 逗号也切（用于压缩器逐子句裁剪；源：splitClauses）。 */
export function splitClauses(text: string): string[] {
  if (isBlank(text)) {
    return [];
  }
  const out: string[] = [];
  for (const part of text.split(/[。；;\n，,、]/)) {
    const t = part.trim();
    if (t.length >= 2) {
      out.push(t);
    }
  }
  return out;
}

/** 命中窗口话题、且不命中「已说过话题」的子句才保留（源：clauseMatches）。 */
export function clauseMatches(clause: string, inTopics: Set<string>, outTopics: Set<string>): boolean {
  let hitIn = false;
  for (const topic of inTopics) {
    if (topic.length >= 2 && clause.includes(topic)) {
      hitIn = true;
      break;
    }
  }
  if (!hitIn) {
    return false;
  }
  for (const topic of outTopics) {
    if (topic.length >= 2 && clause.includes(topic)) {
      return false;
    }
  }
  return true;
}

/**
 * 确定性（不依赖 LLM 的）画面块压缩：逐子句拼接，超过 maxChars 就在标点处收尾。
 * 源实现同样有这个方法，并在超长时用于兜底；本地版在没配 ARK_CHAT_MODEL 时走它。
 */
export function compactVisual(text: string, maxChars: number): string {
  if (isBlank(text) || maxChars <= 0) {
    return '';
  }
  let kept = '';
  for (const clause of splitClauses(text)) {
    if (looksLikeSubtitle(clause) || looksLikeSpokenDump(clause) || looksLikeAmbient(clause)) {
      continue;
    }
    if (kept.length > 0) {
      kept += '，';
    }
    kept += clause;
    if (kept.length >= maxChars) {
      break;
    }
  }
  let t = kept.length === 0 ? text.replace(/\s+/g, '') : kept;
  t = t.replace(/画面[上下左右顶底部侧]*[的]?[^，。]{0,12}字幕/g, '');
  t = t.replace(/[，,]{2,}/g, '，').replace(/^[，,\s]+|[，,\s]+$/g, '');
  if (t.length <= maxChars) {
    return t;
  }
  let cut = -1;
  for (let i = Math.min(maxChars, t.length) - 1; i >= Math.max(8, Math.floor(maxChars / 2)); i--) {
    const c = t.charAt(i);
    if (c === '，' || c === '。' || c === '、') {
      cut = i;
      break;
    }
  }
  if (cut > 8) {
    return t.slice(0, cut);
  }
  return t.slice(0, maxChars);
}

function looksLikeSubtitle(clause: string): boolean {
  return (
    clause.includes('字幕') ||
    clause.includes('花字') ||
    clause.includes('标题条') ||
    clause.includes('文字叠加') ||
    clause.includes('黄色文字') ||
    clause.includes('白色文字')
  );
}

/** 首个命中的下标（多个候选串取最小值；源：indexOfAny）。 */
function indexOfAny(text: string, ...needles: string[]): number {
  let best = -1;
  for (const needle of needles) {
    const idx = text.indexOf(needle);
    if (idx >= 0 && (best < 0 || idx < best)) {
      best = idx;
    }
  }
  return best;
}

function firstNonBlankStr(a: string, b: string): string {
  const sa = trim(a);
  return isNotBlank(sa) ? sa : trim(b);
}

/** 供压缩器复用的长度上限（避免各处硬编码 500）。 */
export const PROMPT_LIMIT = PROMPT_MAX_LENGTH;
