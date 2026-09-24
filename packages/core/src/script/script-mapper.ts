/**
 * 剧本还原结果 → analysis blob（源：`service/btob/drama/DramaScriptMapper.java`）。
 *
 * 产出正是 `seedance-prompt.ts` / `segment-planner.ts` 消费的 `analysis`：
 * {pipeline, people, scenes, dialogues, asrSubtitles, cast, plot, faces, sceneFrames, keyframes, source}
 * 字段名保持与源仓库一致（大小写兼容在读取侧做，见 msOrSec / firstStr）。
 */

import { SANITY_MAX_PORTRAITS } from '../planner/limits.js';
import { firstMillisOrSec, millisToSec, msOrSec } from '../planner/segment-planner.js';
import type { JsonMap } from '../util/maps.js';
import { listOfMaps } from '../util/maps.js';
import { isBlank, isNotBlank } from '../util/text.js';
import { PIPELINE } from '../pipeline/stages.js';

/** 闪现配角标签：这些人不该占人像槽（源：FLASH_LABELS）。 */
const FLASH_LABELS = new Set(['路人', '群演', '服务员', '配角闪现']);

/** 剧本 → analysis（源：toAnalysis）。 */
export function toAnalysis(
  script: JsonMap,
  faceUrls: string[],
  sceneFrameUrls: string[],
): JsonMap {
  const out: JsonMap = {};
  out['pipeline'] = PIPELINE;
  let people = listOfMaps(script['People']);
  if (people.length === 0) {
    people = listOfMaps(script['people']);
  }
  let scenes = listOfMaps(script['Scenes']);
  if (scenes.length === 0) {
    scenes = listOfMaps(script['scenes']);
  }
  let dialogues = listOfMaps(script['Dialogues']);
  if (dialogues.length === 0) {
    dialogues = listOfMaps(script['dialogues']);
  }
  out['people'] = people;
  out['scenes'] = mapScenes(scenes);
  out['dialogues'] = mapDialogues(dialogues);
  out['asrSubtitles'] = toAsrCues(dialogues);
  out['cast'] = mapCast(people, dialogues, scenes);
  out['plot'] = firstStr(script['Plot'], script['plot']);
  if (faceUrls && faceUrls.length > 0) {
    out['faces'] = faceUrls;
  }
  if (sceneFrameUrls && sceneFrameUrls.length > 0) {
    out['sceneFrames'] = sceneFrameUrls;
    out['keyframes'] = sceneFrameUrls;
  }
  out['source'] = 'drama-script';
  return out;
}

/** 粗场：摊平起止（兼容毫秒）、补 range/desc/plot，并把细镜头数组原样带下去。 */
function mapScenes(scenes: JsonMap[]): JsonMap[] {
  const out: JsonMap[] = [];
  scenes.forEach((s, i) => {
    const row: JsonMap = {};
    row['id'] = firstStr(s['Id'], firstStr(s['id'], 'S' + i));
    row['name'] = firstStr(s['Title'], firstStr(s['title'], '分镜' + (i + 1)));
    let start = msOrSec(s['StartTime'], s['startTime'], s['Start']);
    let end = msOrSec(s['EndTime'], s['endTime'], s['End']);
    // 剧本包偶尔混着毫秒回来：end 明显超 120 且远大于 start 时，按毫秒重算两边（源：millisToSec）
    if (end > 120 && end > start * 10) {
      start = millisToSec(s['StartTime'] !== undefined ? s['StartTime'] : s['startTime']);
      end = millisToSec(s['EndTime'] !== undefined ? s['EndTime'] : s['endTime']);
    }
    row['startTime'] = start;
    row['endTime'] = end;
    row['range'] = trim1(start) + '-' + trim1(end) + 's';
    row['desc'] = firstStr(s['Desc'], s['desc']);
    row['plot'] = firstStr(s['Plot'], s['plot']);
    row['segments'] = s['Segments'] !== undefined ? s['Segments'] : s['segments'];
    out.push(row);
  });
  return out;
}

/** 对白：Content/People/PeopleId/StartInMillis… 统一摊平成小写字段（源：mapDialogues）。 */
function mapDialogues(dialogues: JsonMap[]): JsonMap[] {
  const out: JsonMap[] = [];
  for (const d of dialogues) {
    const row: JsonMap = {};
    row['id'] = d['Id'] !== undefined ? d['Id'] : d['id'];
    row['text'] = firstStr(d['Content'], d['content']);
    row['people'] = firstStr(d['People'], d['people']);
    row['peopleId'] = firstStr(d['PeopleId'], d['peopleId']);
    row['startTime'] = firstMillisOrSec(d['StartInMillis'], d['startTime'], d['Start']);
    row['endTime'] = firstMillisOrSec(d['EndInMillis'], d['endTime'], d['End']);
    row['emotion'] = firstStr(d['Emotion'], d['emotion']);
    row['voiceDesc'] = firstStr(d['VoiceDesc'], d['voiceDesc']);
    out.push(row);
  }
  return out;
}

/** 对白 → ASR 风格字幕（供无硬字幕判定与 prompt 兜底使用；源：toAsrCues）。 */
function toAsrCues(dialogues: JsonMap[]): JsonMap[] {
  const cues: JsonMap[] = [];
  for (const d of mapDialogues(dialogues)) {
    cues.push({ text: d['text'], start: d['startTime'], end: d['endTime'] });
  }
  return cues;
}

/**
 * 主角表（源：mapCast）：
 * - 有人像槽位上限（≤10）；
 * - 闪现配角（路人/群演/服务员…）直接排除；
 * - 没台词但整片有长时间出镜也保留（对手戏里的沉默主角）。
 */
function mapCast(people: JsonMap[], dialogues: JsonMap[], scenes: JsonMap[]): JsonMap[] {
  const mappedDialogues = mapDialogues(dialogues);
  const out: JsonMap[] = [];
  let added = 0;
  for (const p of people) {
    if (added >= SANITY_MAX_PORTRAITS) {
      break;
    }
    const id = firstStr(p['Id'], p['id']);
    const name = firstStr(p['Name'], p['name']);
    if (isBlank(id) && isBlank(name)) {
      continue;
    }
    if (isFlash(name)) {
      continue;
    }
    let start = Number.MAX_VALUE;
    let end = 0;
    let talk = 0;
    for (const d of mappedDialogues) {
      const pid = String(d['peopleId'] ?? '');
      const pname = String(d['people'] ?? '');
      if ((isNotBlank(id) && id === pid) || (isNotBlank(name) && name === pname)) {
        talk++;
        start = Math.min(start, toNumber(d['startTime']));
        end = Math.max(end, toNumber(d['endTime']));
      }
    }
    if (talk === 0 && !hasLongPresence(scenes)) {
      continue;
    }
    if (start === Number.MAX_VALUE) {
      start = 0;
      end = Math.max(end, sceneSpan(scenes));
    }
    const row: JsonMap = {
      id: id.length > 0 ? id : 'p' + (added + 1),
      label: name.length > 0 ? name : '主角' + (added + 1),
      startTime: start,
      endTime: end,
      looks: firstStr(p['Looks'], p['looks']),
    };
    out.push(row);
    added++;
  }
  return out;
}

/** 整片跨度是否 ≥3 秒（源：hasLongPresence——只要场景铺得开就算长时间出镜）。 */
function hasLongPresence(scenes: JsonMap[]): boolean {
  return sceneSpan(scenes) >= 3;
}

function sceneSpan(scenes: JsonMap[]): number {
  let max = 0;
  for (const s of scenes) {
    max = Math.max(max, msOrSec(s['EndTime'], s['endTime'], s['End']));
  }
  return max;
}

function isFlash(name: string): boolean {
  if (isBlank(name)) {
    return false;
  }
  const n = name.toLowerCase();
  return FLASH_LABELS.has(name) || n.includes('路人') || n.includes('群演');
}

function firstStr(a: unknown, b: unknown): string {
  if (a !== null && a !== undefined && isNotBlank(String(a))) {
    return String(a).trim();
  }
  if (b !== null && b !== undefined && isNotBlank(String(b))) {
    return String(b).trim();
  }
  return '';
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function trim1(value: number): string {
  return String(Math.round(value * 10.0) / 10.0);
}
