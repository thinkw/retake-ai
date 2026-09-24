/**
 * 字符串小工具：对齐源仓库使用的 hutool `StrUtil` 语义。
 *
 * 移植口径说明：
 * - Java `String.length()` 与 JS `String.length` 对常用中文（BMP 内）都是「每字 1 个 code unit」，
 *   因此 prompt 的 500 字上限、截断逻辑可以直接用 `.length` 对照移植，行为一致。
 * - `isBlank` 与 hutool 一致：null / 空串 / 全空白 都算 blank。
 */

/** 空白判定（含 null/undefined）。 */
export function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0;
}

/**
 * 非空白判定。
 * 写成类型谓词（`value is string`）：调用方大量存在 `if (isNotBlank(x)) { 用 x }`，
 * 这样 TS 能自动去掉 undefined，不必到处写 `x as string`。
 */
export function isNotBlank(value: string | null | undefined): value is string {
  return !isBlank(value);
}

/** null 安全的 trim（源：StrUtil.trim；不抛异常）。 */
export function trim(value: string | null | undefined): string {
  return value === null || value === undefined ? '' : value.trim();
}

/** 空白则回退默认值（源：StrUtil.blankToDefault）。 */
export function blankToDefault(value: string | null | undefined, fallback: string): string {
  return isBlank(value) ? fallback : (value as string);
}

/** null 转空串（源：StrUtil.nullToEmpty）。 */
export function nullToEmpty(value: string | null | undefined): string {
  return value === null || value === undefined ? '' : value;
}

/** 截断到 max 个字符（源：StrUtil.maxLength；超长时源实现会补省略号，本地版保留原文截断，避免把省略号写进 prompt）。 */
export function maxLength(value: string | null | undefined, max: number): string {
  const text = nullToEmpty(value);
  return text.length <= max ? text : text.slice(0, max);
}

/** 忽略大小写的前缀判断（源：StrUtil.startWithIgnoreCase）。 */
export function startWithIgnoreCase(value: string | null | undefined, prefix: string): boolean {
  if (isBlank(value)) {
    return false;
  }
  return (value as string).toLowerCase().startsWith(prefix.toLowerCase());
}

/** 忽略大小写相等（源：String.equalsIgnoreCase）。 */
export function equalsIgnoreCase(a: string | null | undefined, b: string): boolean {
  if (a === null || a === undefined) {
    return false;
  }
  return a.toLowerCase() === b.toLowerCase();
}

/** 首个非空白（源：firstNonBlank 语义，任意个入参）。 */
export function firstNonBlank(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (isNotBlank(value)) {
      return (value as string).trim();
    }
  }
  return '';
}
