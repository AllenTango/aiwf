/**
 * 密钥扫描基座(纯函数,无 I/O、无日志):
 * - `detectSecrets` 报告文本中命中的「疑似凭证」;
 * - `containsSecret` 只要判断有没有;
 * - `redactFileContent` 返回脱敏后的文本 + 命中列表。
 *
 * 安全底线:`SecretHit.sample` 绝不回显原始密钥,只给脱敏样本(前缀 + 长度)。
 */

import { SECRET_PATTERNS, redactText } from './redact.js';

/** 一条疑似凭证命中记录。 */
export interface SecretHit {
  /** 命中类别:模式名(如 `openai-style-key`)或 `env-secret`。 */
  readonly kind: string;
  /** 脱敏样本(绝不包含原始密钥)。 */
  readonly sample: string;
}

/** 样本里最多保留的前缀字符数。 */
const SAMPLE_PREFIX_LENGTH = 4;

/**
 * 生成脱敏样本:
 * - `env-secret` 只给长度;
 * - 其余给「前 4 个字符 + `***` + 长度」;取值过短时干脆不给前缀,避免几乎原样泄露。
 */
function maskSample(kind: string, value: string): string {
  const length = value.length;
  if (kind === 'env-secret') return `env-secret(长度=${length})`;
  const keep = length > SAMPLE_PREFIX_LENGTH * 2 ? SAMPLE_PREFIX_LENGTH : 0;
  const prefix = keep > 0 ? value.slice(0, keep) : '';
  return `${prefix}***(长度=${length})`;
}

/**
 * 检测文本中的疑似凭证。
 *
 * 命中 `SECRET_PATTERNS` 中任一规则即记一条(kind = 规则名);
 * 命中 `extraValues` 中的取值记一条(kind = `env-secret`)。
 */
export function detectSecrets(text: string, extraValues?: readonly string[]): SecretHit[] {
  if (typeof text !== 'string' || text === '') return [];

  const hits: SecretHit[] = [];

  for (const pattern of SECRET_PATTERNS) {
    const match = new RegExp(pattern.regex.source, pattern.regex.flags).exec(text);
    if (match === null) continue;
    const value = match[0];
    if (typeof value !== 'string' || value === '') continue;
    hits.push({ kind: pattern.name, sample: maskSample(pattern.name, value) });
  }

  if (Array.isArray(extraValues)) {
    for (const value of extraValues) {
      if (typeof value !== 'string' || value === '') continue;
      if (!text.includes(value)) continue;
      hits.push({ kind: 'env-secret', sample: maskSample('env-secret', value) });
    }
  }

  return hits;
}

/** 文本中是否含有疑似凭证。 */
export function containsSecret(text: string, extraValues?: readonly string[]): boolean {
  return detectSecrets(text, extraValues).length > 0;
}

/**
 * 对文件/片段内容做脱敏。
 *
 * - 没有命中时原样返回(不做任何改写);
 * - 有命中时返回脱敏后的文本 + 命中列表。
 */
export function redactFileContent(
  text: string,
  extraValues?: readonly string[],
): { text: string; hits: SecretHit[] } {
  if (typeof text !== 'string' || text === '') return { text: typeof text === 'string' ? text : '', hits: [] };

  const hits = detectSecrets(text, extraValues);
  if (hits.length === 0) return { text, hits };

  const redacted = redactText(text, extraValues ?? []);
  return { text: redacted, hits };
}
