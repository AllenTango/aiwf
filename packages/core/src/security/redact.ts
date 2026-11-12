/**
 * 密钥脱敏基座(纯函数,无 I/O、无日志):
 * - `isSecretEnvName` 判断环境变量名是否「疑似凭证」;
 * - `collectSecretValues` 收集环境变量/额外传入的凭证取值;
 * - `SECRET_PATTERNS` 用通用规则识别文本中「长得像密钥」的片段;
 * - `redactText` / `createRedactor` 把凭证替换为占位符。
 *
 * 约定:长度阈值只在「收集阶段」施加(见 MIN_SECRET_LENGTH);
 * `redactText` 对调用方显式传入的取值一律替换(调用方应传 collectSecretValues 的结果)。
 */

/** 脱敏占位符:所有被抹除的密钥都会变成它。 */
export const REDACTED_PLACEHOLDER = '***REDACTED***';

/** 脱敏函数签名。 */
export type Redactor = (text: string) => string;

/** 单条凭证识别规则。`regex` 不带 `g` 标志(单次匹配语义),内部需要全局匹配时会自行派生。 */
export interface SecretPattern {
  readonly name: string;
  readonly regex: RegExp;
}

/** 视为密钥的最短长度:更短的值不参与收集(避免把 `true`、`1` 之类误当密钥)。 */
const MIN_SECRET_LENGTH = 8;

/** 无害环境变量名单(即使名字里有 KEY 之类的字样,也不当作凭证)。 */
const HARMLESS_ENV_NAMES: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'PWD',
  'OLDPWD',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TZ',
  'USER',
  'LOGNAME',
  'HOSTNAME',
  'TERM',
  'CI',
  'NODE_ENV',
  'NODE_OPTIONS',
  'INIT_CWD',
  'GITHUB_ACTOR',
  'GITHUB_REPOSITORY',
  'GITHUB_WORKFLOW',
  'GITHUB_EVENT_NAME',
  'GITHUB_WORKSPACE',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_NUMBER',
  'GITHUB_JOB',
  'GITHUB_SHA',
  'GITHUB_REF',
  'GITHUB_SERVER_URL',
  'GITHUB_API_URL',
  'GITHUB_GRAPHQL_URL',
  'GITHUB_ENV',
  'GITHUB_OUTPUT',
  'GITHUB_PATH',
  'GITHUB_STEP_SUMMARY',
  'GITHUB_STATE',
  'NPM_CONFIG_PREFIX',
]);

/** 无害环境变量前缀(比较时统一小写化,故此处用小写)。 */
const HARMLESS_ENV_PREFIXES: readonly string[] = ['npm_', 'pnpm_', 'lc_', 'xdg_'];

/** 触发「疑似凭证」判定的名字片段。 */
const SECRET_NAME_MARKERS: readonly string[] = [
  'API_KEY',
  'APIKEY',
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'PRIVATE_KEY',
  'ACCESS_KEY',
];

/**
 * 通用凭证识别规则。
 * 顺序即检测优先级(私钥块优先,避免块内其它片段被单独命中)。
 *
 * 长度下限按「整个凭证的总长度」折算(例如 `sk-` 至少 16 位 → 前缀后至少 13 位),
 * 并用前视断言避免把 `task-abcdef...` 这类普通单词误判成 key。
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: 'private-key-block',
    regex:
      /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z0-9 ]*PRIVATE KEY-----/,
  },
  { name: 'openai-style-key', regex: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{13,}/ },
  { name: 'google-api-key', regex: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{16,}/ },
  {
    name: 'github-token',
    regex: /(?<![A-Za-z0-9_])(?:gh[posru]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{9,})/,
  },
  { name: 'slack-token', regex: /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{4,}/ },
  { name: 'aws-access-key', regex: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}/ },
  { name: 'bearer-token', regex: /(?<![A-Za-z0-9])(bearer)([ \t]+)([A-Za-z0-9._~+/=-]{20,})/i },
  { name: 'url-credentials', regex: /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/]+):([^\s@/]+)@/ },
];

/**
 * 判断环境变量名是否「疑似凭证」。
 *
 * 规则:名字大写化后命中 `API_KEY`/`APIKEY`/`SECRET`/`TOKEN`/`PASSWORD`/`PASSWD`/
 * `CREDENTIAL`/`PRIVATE_KEY`/`ACCESS_KEY` 任一片段,或以 `_KEY` 结尾即视为凭证;
 * 但先排除无害名单(精确名 + `npm_`/`pnpm_`/`LC_`/`XDG_` 前缀)。
 */
export function isSecretEnvName(name: string): boolean {
  if (typeof name !== 'string' || name === '') return false;
  if (isHarmlessEnvName(name)) return false;
  const upper = name.toUpperCase();
  if (SECRET_NAME_MARKERS.some((marker) => upper.includes(marker))) return true;
  if (upper.endsWith('_KEY')) return true;
  return false;
}

/**
 * 判断某个环境变量名是否「明确无害」(命中无害名单或无害前缀)。
 * 无害名单优先于一切凭证判定。
 */
function isHarmlessEnvName(name: string): boolean {
  if (typeof name !== 'string' || name === '') return true;
  const upper = name.toUpperCase();
  const lower = name.toLowerCase();
  if (HARMLESS_ENV_NAMES.has(upper)) return true;
  return HARMLESS_ENV_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * 兜底启发式:名字既不像凭证、也不在无害名单里,但取值「长得像随机串」时,
 * 仍按凭证处理(宁可多脱敏,不可漏脱敏)。
 *
 * 判定:长度 ≥ MIN_SECRET_LENGTH、同时含字母与数字、不含空白、不像路径/URL(含 `:` `/` `\`)、
 * 也不像版本号(如 `22.11.0`、`node-v20.11.0`)。
 */
function looksLikeSecretValue(value: string): boolean {
  if (value.length < MIN_SECRET_LENGTH) return false;
  if (!/[A-Za-z]/.test(value)) return false;
  if (!/[0-9]/.test(value)) return false;
  if (/\s/.test(value)) return false;
  if (/[:/\\]/.test(value)) return false;
  if (/\d+\.\d+/.test(value)) return false;
  return true;
}

/**
 * 收集需要脱敏的凭证取值。
 *
 * - 环境变量:名字像凭证(或取值命中兜底启发式)+ 值非空 + 长度 ≥ MIN_SECRET_LENGTH;
 * - `extraValues`:同样要求长度 ≥ MIN_SECRET_LENGTH;
 * - 去重后**按长度降序**返回(长值先替换,避免短值先命中导致长值残留)。
 */
export function collectSecretValues(
  env: Record<string, string | undefined>,
  extraValues?: readonly string[],
): string[] {
  const collected: string[] = [];

  if (env !== null && typeof env === 'object') {
    for (const [name, value] of Object.entries(env)) {
      if (typeof value !== 'string') continue;
      if (value.length < MIN_SECRET_LENGTH) continue;
      if (isHarmlessEnvName(name)) continue;
      if (isSecretEnvName(name) || looksLikeSecretValue(value)) {
        collected.push(value);
      }
    }
  }

  if (Array.isArray(extraValues)) {
    for (const value of extraValues) {
      if (typeof value !== 'string') continue;
      if (value.length < MIN_SECRET_LENGTH) continue;
      collected.push(value);
    }
  }

  const unique = [...new Set(collected)];
  unique.sort((a, b) => b.length - a.length);
  return unique;
}

/** 派生一个带 `g` 标志的正则副本(避免污染导出的模式对象)。 */
function toGlobalRegex(regex: RegExp): RegExp {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  return new RegExp(regex.source, flags);
}

/**
 * 某些规则需要保留前缀/上下文(如 `Bearer `、`scheme://user:`),不能整段替换。
 * 这里按模式名给出定制替换;未列出的模式整段替换为占位符。
 */
const PATTERN_REPLACERS: Readonly<Record<string, (match: RegExpExecArray) => string>> = {
  'bearer-token': (m) => `${m[1] ?? ''}${m[2] ?? ''}${REDACTED_PLACEHOLDER}`,
  'url-credentials': (m) => `${m[1] ?? ''}:${REDACTED_PLACEHOLDER}@`,
};

/**
 * 脱敏文本:
 * 1. 先把 `values` 中的每个取值替换为占位符(用 split/join,避免值里的正则元字符);
 * 2. 再套用 `SECRET_PATTERNS` 替换通用规则。
 *
 * 空字符串/非字符串输入均健壮返回(不抛异常)。
 */
export function redactText(text: string, values: readonly string[]): string {
  if (typeof text !== 'string') return '';
  if (text === '') return '';

  const knownValues = (Array.isArray(values) ? values : [])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort((a, b) => b.length - a.length);

  let output = text;
  for (const value of knownValues) {
    if (!output.includes(value)) continue;
    output = output.split(value).join(REDACTED_PLACEHOLDER);
  }

  for (const pattern of SECRET_PATTERNS) {
    const replacer = PATTERN_REPLACERS[pattern.name];
    output = output.replace(toGlobalRegex(pattern.regex), (full: string, ...rest: unknown[]) => {
      // replace 回调参数:全匹配、若干捕获组、offset、整串;末尾两项不是捕获组。
      const groups = rest.slice(0, rest.length - 2);
      if (replacer === undefined) return REDACTED_PLACEHOLDER;
      return replacer([full, ...groups] as unknown as RegExpExecArray);
    });
  }

  return output;
}

/**
 * 创建一个脱敏器:内部一次性收集凭证取值并缓存,重复调用不会重复计算。
 */
export function createRedactor(
  env?: Record<string, string | undefined>,
  extraValues?: readonly string[],
): Redactor {
  const values = collectSecretValues(env ?? {}, extraValues);
  return (text: string): string => redactText(text, values);
}
