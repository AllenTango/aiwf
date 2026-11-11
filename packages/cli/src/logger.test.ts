import { describe, expect, it } from 'vitest';
import { asLogger, makeConsoleLogger } from './logger.js';

describe('console logger mapping', () => {
  it('routes levels to console.log/warn/error with level tags', () => {
    const seen: { via: string; text: string }[] = [];
    const consoleLike = {
      log: (msg?: unknown): void => void seen.push({ via: 'log', text: String(msg) }),
      warn: (msg?: unknown): void => void seen.push({ via: 'warn', text: String(msg) }),
      error: (msg?: unknown): void => void seen.push({ via: 'error', text: String(msg) }),
    };
    const logger = makeConsoleLogger(consoleLike);
    logger.debug('d1');
    logger.info('i1');
    logger.warn('w1');
    logger.error('e1');

    expect(seen.filter((s) => s.via === 'log')).toHaveLength(2);
    expect(seen.some((s) => s.via === 'log' && s.text.includes('d1'))).toBe(true);
    expect(seen.some((s) => s.via === 'log' && s.text === 'i1')).toBe(true);
    expect(seen.some((s) => s.via === 'warn' && s.text.includes('[warn]') && s.text.includes('w1'))).toBe(true);
    expect(seen.some((s) => s.via === 'error' && s.text.includes('[error]') && s.text.includes('e1'))).toBe(true);
  });

  it('warn/error fall back to console.log when dedicated channels missing', () => {
    const seen: string[] = [];
    const logger = makeConsoleLogger({ log: (msg?: unknown) => void seen.push(String(msg)) });
    logger.warn('w2');
    logger.error('e2');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('w2');
    expect(seen[1]).toContain('e2');
  });
});

describe('asLogger compatibility adapters', () => {
  it('adapts hosts exposing Log*-style methods (LogWarning etc.)', () => {
    const messages: string[] = [];
    const host = {
      LogWarning: (msg: string) => {
        messages.push(`warn:${msg}`);
      },
      LogError: (msg: string) => {
        messages.push(`error:${msg}`);
      },
    };
    const logger = asLogger(host);
    logger?.warn('w1');
    logger?.error('e1');
    logger?.info('i1'); // info falls back to warn (first available channel)
    expect(messages).toEqual(['warn:w1', 'error:e1', 'warn:i1']);
  });

  it('adapts plain console-like hosts (console.* compat)', () => {
    const messages: string[] = [];
    const logger = asLogger({ log: (m: string) => messages.push(m) });
    logger?.info('msg');
    logger?.debug('dbg'); // debug→info availability falls back to log()
    expect(messages).toEqual(['msg', 'dbg']);
  });

  it('fully specified hosts keep every channel', () => {
    const messages: string[] = [];
    const logger = asLogger({
      debug: (m: string) => messages.push(`d:${m}`),
      info: (m: string) => messages.push(`i:${m}`),
      warn: (m: string) => messages.push(`w:${m}`),
      error: (m: string) => messages.push(`e:${m}`),
    });
    logger?.debug('a');
    logger?.info('b');
    logger?.warn('c');
    logger?.error('d');
    expect(messages).toEqual(['d:a', 'i:b', 'w:c', 'e:d']);
  });

  it('garbage hosts yield undefined instead of crashing', () => {
    expect(asLogger(undefined)).toBeUndefined();
    expect(asLogger('nope')).toBeUndefined();
    expect(asLogger(42)).toBeUndefined();
    expect(asLogger({})).toBeUndefined();
  });
});
