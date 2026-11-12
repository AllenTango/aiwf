import type { Logger, Redactor } from '@aiwf/core';
import pc from 'picocolors';

/**
 * Console-backed Logger factory.
 * - debug → console.log (gray, tagged)
 * - info  → console.log (plain)
 * - warn  → console.warn (yellow, tagged)
 * - error → console.error (red, tagged)
 * picocolors auto-disables color when stdout is not a TTY (or NO_COLOR set),
 * so CI logs stay clean.
 *
 * `redact` 是可选的脱敏器(来自 @aiwf/core 的 contracts):所有落到终端的
 * 消息都会先过它,避免 agent 打印的密钥明文进入终端 / CI 日志。
 * 缺省为恒等函数,保持既有调用方行为不变。
 */
export function makeConsoleLogger(
  consoleLike: Partial<Console> = console,
  redact?: Redactor,
): Logger {
  const scrub = (text: string): string =>
    typeof redact === 'function' ? redact(text) : text;
  return {
    debug: (msg) => (consoleLike.log ?? consoleLike.info)?.(pc.gray(`[debug] ${scrub(msg)}`)),
    info: (msg) => (consoleLike.log ?? consoleLike.info)?.(scrub(msg)),
    warn: (msg) => (consoleLike.warn ?? consoleLike.log)?.(pc.yellow(`[warn] ${scrub(msg)}`)),
    error: (msg) => (consoleLike.error ?? consoleLike.log)?.(pc.red(`[error] ${scrub(msg)}`)),
  };
}

/** Legacy/hostile-shape loggers (e.g. objects exposing `LogWarning`-style
 *  methods, or plain console-like shapes) adapted onto the shared contract. */
type MixedLogger = Record<string, unknown>;

export function asLogger(
  candidate: unknown,
): Logger | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const mixed = candidate as MixedLogger;
  const method = (key: string): ((msg: string) => void) | undefined => {
    const value = mixed[key];
    return typeof value === 'function' ? (msg: string) => (value as (m: string) => void)(msg) : undefined;
  };
  const debug = method('debug') ?? method('LogDebug');
  const info = method('info') ?? method('LogInfo') ?? method('log');
  const warn = method('warn') ?? method('LogWarning');
  const error = method('error') ?? method('LogError');
  if (!info && !warn && !error) return undefined;
  const base = (info ?? warn ?? error) as (msg: string) => void;
  return {
    debug: debug ?? base,
    info: info ?? base,
    warn: warn ?? base,
    error: error ?? base,
  };
}
