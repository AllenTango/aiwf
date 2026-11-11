import type { Logger } from '@aiwf/core';
import pc from 'picocolors';

/**
 * Console-backed Logger factory.
 * - debug → console.log (gray, tagged)
 * - info  → console.log (plain)
 * - warn  → console.warn (yellow, tagged)
 * - error → console.error (red, tagged)
 * picocolors auto-disables color when stdout is not a TTY (or NO_COLOR set),
 * so CI logs stay clean.
 */
export function makeConsoleLogger(consoleLike: Partial<Console> = console): Logger {
  return {
    debug: (msg) => (consoleLike.log ?? consoleLike.info)?.(pc.gray(`[debug] ${msg}`)),
    info: (msg) => (consoleLike.log ?? consoleLike.info)?.(msg),
    warn: (msg) => (consoleLike.warn ?? consoleLike.log)?.(pc.yellow(`[warn] ${msg}`)),
    error: (msg) => (consoleLike.error ?? consoleLike.log)?.(pc.red(`[error] ${msg}`)),
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
