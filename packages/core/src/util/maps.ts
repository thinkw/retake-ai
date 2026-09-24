/**
 * Map / 弱类型 JSON 取值小工具。
 *
 * 逐字移植源仓库 `service/btob/drama/DramaMaps.java`（并补充各 Java 类里重复出现的
 * `str(Object)` / `num(Object, fallback)` 私有小工具），目的有两个：
 * 1. 让移植后的 TS 与 Java 侧「同一套取值口径」，减少理解成本；
 * 2. 云端返回的字段类型不稳定（数字可能是字符串、布尔可能是 "true"），必须集中容错。
 */

/** 任意 JSON 对象（源仓库统一用 `Map<String, Object>` 承载 analysis / meta / segments）。 */
export type JsonMap = Record<string, unknown>;

/** 浅拷贝（源：DramaMaps.copy；null 时给空对象，保证后续可安全 put）。 */
export function copyMap(src: JsonMap | null | undefined): JsonMap {
  return src ? { ...src } : {};
}

/** 取字符串并 trim；缺失返回空串（源：DramaMaps.str）。 */
export function str(map: JsonMap | null | undefined, key: string): string {
  const value = map?.[key];
  return value === null || value === undefined ? '' : String(value).trim();
}

/** 任意值 → 字符串并 trim（源：各类私有 static String str(Object v)）。 */
export function strOf(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

/** 取布尔：true 或字符串 "true"（源：DramaMaps.bool）。 */
export function bool(map: JsonMap | null | undefined, key: string): boolean {
  const value = map?.[key];
  if (value === null || value === undefined) {
    return false;
  }
  return value === true || String(value).toLowerCase() === 'true';
}

/** 取整数（源：DramaMaps.lng / toInt；JS 里 long/int 统一为 number）。 */
export function int(map: JsonMap | null | undefined, key: string, fallback: number): number {
  return Math.round(numOf(map?.[key], fallback));
}

/** 取数字（源：DramaMaps.num）。 */
export function num(map: JsonMap | null | undefined, key: string, fallback: number): number {
  return numOf(map?.[key], fallback);
}

/** 任意值 → 数字（源：各类私有 static double num(Object v, double fallback)）。 */
export function numOf(value: unknown, fallback: number): number {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  const text = String(value).trim();
  if (text.length === 0) {
    return fallback;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 任意值 → 整数（源：DramaMaps.toInt）。 */
export function toInt(value: unknown, fallback: number): number {
  if (typeof value === 'number') {
    return Math.trunc(value);
  }
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (text.length === 0) {
    return fallback;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/**
 * 取「Map 列表」并逐项浅拷贝（源：DramaMaps.listOfMaps）。
 * 非数组或元素不是对象时跳过，保证调用方拿到可写的普通对象数组。
 */
export function listOfMaps(raw: unknown): JsonMap[] {
  const out: JsonMap[] = [];
  if (!Array.isArray(raw)) {
    return out;
  }
  for (const item of raw) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      out.push({ ...(item as JsonMap) });
    }
  }
  return out;
}

/** 工具任务是否已完成（源：DramaMaps.isToolCompleted）。 */
export function isToolCompleted(status: string): boolean {
  const s = status.toLowerCase();
  return s === 'completed' || s === 'succeeded' || s === 'success';
}

/** 工具任务是否已失败（源：DramaMaps.isToolFailed）。 */
export function isToolFailed(status: string): boolean {
  const s = status.toLowerCase();
  return s === 'failed' || s === 'cancelled' || s === 'canceled';
}

/** 工具任务是否仍在途（ queued / running / processing 等非终态）。 */
export function isToolRunning(status: string): boolean {
  return !isToolCompleted(status) && !isToolFailed(status);
}

/** 保留一位小数的字符串（源：trim1(double)：Math.round(v*10)/10 后 String.valueOf）。 */
export function trim1(value: number): string {
  return String(Math.round(value * 10.0) / 10.0);
}
