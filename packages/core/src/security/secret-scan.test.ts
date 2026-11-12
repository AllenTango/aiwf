/** 密钥扫描基座专项测试(纯函数)。 */

import { describe, expect, it } from 'vitest';
import { REDACTED_PLACEHOLDER } from './redact.js';
import { containsSecret, detectSecrets, redactFileContent } from './secret-scan.js';

const RAW_KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123';

describe('detectSecrets', () => {
  it('表驱动:命中模式时返回对应 kind', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['openai-style-key', 'sk-abcdefghijklmnopqrstuvwxyz0123'],
      ['google-api-key', 'AIzaSyA1234567890abcdefghijklmnopqrstu'],
      ['github-token', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
      ['slack-token', 'xoxb-1234567890-abcdefghijkl'],
      ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
      ['bearer-token', 'Authorization: Bearer abcdefghijklmnopqrstuvwx'],
      ['url-credentials', 'https://user:hunter2hunter2@example.com/x'],
      [
        'private-key-block',
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxxxxxxxx\n-----END RSA PRIVATE KEY-----',
      ],
    ];
    for (const [kind, raw] of cases) {
      const hits = detectSecrets(raw);
      expect(hits.map((h) => h.kind), kind).toContain(kind);
    }
  });

  it('命中 extraValues 时 kind 为 env-secret', () => {
    const raw = 'super-secret-value-1234';
    const hits = detectSecrets(`这里有 ${raw} 这样的值`, [raw]);
    const hit = hits.find((h) => h.kind === 'env-secret');
    expect(hit).toBeDefined();
    expect(hit?.sample).toBe('env-secret(长度=23)');
  });

  it('sample 绝不回显原始密钥', () => {
    const raw = 'sk-abcdefghijklmnopqrstuvwxyz0123';
    const hits = detectSecrets(`前缀 ${raw} 后缀`);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.sample).not.toContain(raw);
    }
    const sample = hits.find((h) => h.kind === 'openai-style-key')?.sample ?? '';
    expect(sample).toContain('***');
    expect(sample).toContain('长度=');
    expect(sample).toMatch(/^sk-a\*\*\*/);
  });

  it('env-secret 的 sample 也不含原值', () => {
    const raw = 'super-secret-value-1234';
    const hits = detectSecrets(raw, [raw]);
    for (const hit of hits) {
      expect(hit.sample).not.toContain(raw);
    }
  });

  it('无命中返回空数组;空/非字符串输入健壮', () => {
    expect(detectSecrets('普通文本,没有任何密钥')).toEqual([]);
    expect(detectSecrets('')).toEqual([]);
    expect(detectSecrets(undefined as unknown as string)).toEqual([]);
  });
});

describe('containsSecret', () => {
  it('有命中返回 true,无命中返回 false', () => {
    expect(containsSecret(RAW_KEY)).toBe(true);
    expect(containsSecret('普通文本')).toBe(false);
    expect(containsSecret('', ['super-secret-value-1234'])).toBe(false);
    expect(containsSecret('含值 super-secret-value-1234', ['super-secret-value-1234'])).toBe(true);
  });
});

describe('redactFileContent', () => {
  it('命中时返回脱敏文本 + hits', () => {
    const result = redactFileContent(`key=${RAW_KEY}`);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.text).not.toContain(RAW_KEY);
    expect(result.text).toContain(REDACTED_PLACEHOLDER);
  });

  it('未命中时文本原样返回、hits 为空', () => {
    const text = '这是一段完全普通的文件内容';
    const result = redactFileContent(text);
    expect(result.text).toBe(text);
    expect(result.hits).toEqual([]);
  });

  it('extraValues 中的值也会被脱敏', () => {
    const raw = 'super-secret-value-1234';
    const result = redactFileContent(`内容里有 ${raw}`, [raw]);
    expect(result.text).not.toContain(raw);
    expect(result.text).toContain(REDACTED_PLACEHOLDER);
    expect(result.hits.map((h) => h.kind)).toContain('env-secret');
  });

  it('bearer token 保留前缀', () => {
    const result = redactFileContent('Authorization: Bearer abcdefghijklmnopqrstuvwx');
    expect(result.text).toBe(`Authorization: Bearer ${REDACTED_PLACEHOLDER}`);
  });

  it('url 凭证只抹掉密码部分', () => {
    const result = redactFileContent('clone https://user:hunter2hunter2@example.com/x.git');
    expect(result.text).toBe(`clone https://user:${REDACTED_PLACEHOLDER}@example.com/x.git`);
  });

  it('空/非字符串输入健壮', () => {
    expect(redactFileContent('')).toEqual({ text: '', hits: [] });
    const bad = redactFileContent(undefined as unknown as string);
    expect(bad.text).toBe('');
    expect(bad.hits).toEqual([]);
  });
});
