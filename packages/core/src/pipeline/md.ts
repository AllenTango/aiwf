/** 结项报告 / PR 正文共用的纯文本工具(无 IO、无副作用)。 */

/** 把多行文本压成单行(空白折叠)。 */
export function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim();
}

/** 表格单元格安全化:压单行 + 转义竖线。 */
export function mdCell(text: string): string {
  return oneLine(text).replace(/\|/g, '\\|');
}

/** 压为单行并截断到 max 字符(超长以 … 结尾)。 */
export function clampLine(text: string, max: number): string {
  const s = oneLine(text);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}
