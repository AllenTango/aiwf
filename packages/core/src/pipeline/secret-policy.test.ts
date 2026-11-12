/**
 * pipeline/secret-policy 单元测试(纯逻辑,无 IO)。
 *
 * 覆盖:凭证文件路径识别、内容凭证扫描、批量处置(drop/redact/keep)。
 */

import { describe, expect, it } from 'vitest';

import type { ChangedFile } from '../contracts/index.js';
import {
  SECRET_FILE_PATTERNS,
  applySecretPolicy,
  isSecretFilePath,
  sanitizeChangedFile,
} from './secret-policy.js';

const API_KEY = 'sk-live-abcdefghijklmnop1234567890';

describe('isSecretFilePath', () => {
  it('识别常见凭证文件路径', () => {
    const cases = [
      '.env',
      '.env.local',
      'apps/web/.env.production',
      '.npmrc',
      'id_rsa',
      '.ssh/config',
      'config/credentials.json',
      'home/.config/opencode/opencode.json',
      'certs/server.pem',
      'certs/server.key',
      'keystore.jks',
    ];
    for (const p of cases) {
      expect(isSecretFilePath(p), p).toBe(true);
    }
  });

  it('普通源码/文档路径不被误判', () => {
    const cases = [
      'src/index.ts',
      'packages/core/src/security/redact.ts',
      'docs/action.md',
      'README.md',
      'src/environment.ts',
      'src/keyboard.ts',
      'tests/fixtures/env.test.ts',
    ];
    for (const p of cases) {
      expect(isSecretFilePath(p), p).toBe(false);
    }
  });

  it('Windows 反斜杠路径同样可识别', () => {
    expect(isSecretFilePath('apps\\web\\.env')).toBe(true);
  });

  it('路径特征表非空且全部为正则', () => {
    expect(SECRET_FILE_PATTERNS.length).toBeGreaterThan(0);
    for (const re of SECRET_FILE_PATTERNS) expect(re).toBeInstanceOf(RegExp);
  });
});

describe('sanitizeChangedFile', () => {
  it('凭证文件 → drop', () => {
    const file: ChangedFile = { path: '.env', action: 'add', content: 'x' };
    expect(sanitizeChangedFile(file).disposition).toBe('drop');
  });

  it('内容含 API Key → redact,并给出命中特征', () => {
    const file: ChangedFile = { path: 'src/c.ts', action: 'add', content: `const k = '${API_KEY}';` };
    const outcome = sanitizeChangedFile(file);
    expect(outcome.disposition).toBe('redact');
    expect(outcome.hits.length).toBeGreaterThan(0);
    expect(outcome.hits.every((h) => !h.sample.includes(API_KEY))).toBe(true);
  });

  it('内容命中已知 env 凭证明文 → redact', () => {
    const file: ChangedFile = { path: 'src/c.ts', action: 'add', content: 'token=my-secret-env-value' };
    expect(sanitizeChangedFile(file, ['my-secret-env-value']).disposition).toBe('redact');
  });

  it('正常内容 → keep;delete 动作 → keep;缺 content → keep', () => {
    expect(sanitizeChangedFile({ path: 'a.ts', action: 'add', content: 'const a = 1;' }).disposition).toBe('keep');
    expect(sanitizeChangedFile({ path: 'a.ts', action: 'delete' }).disposition).toBe('keep');
    expect(sanitizeChangedFile({ path: 'a.ts', action: 'add' }).disposition).toBe('keep');
  });
});

describe('applySecretPolicy', () => {
  it('drop 的文件从结果中移除并记入 droppedPaths;redact 的文件内容被替换', () => {
    const files: ChangedFile[] = [
      { path: '.env', action: 'add', content: `KEY=${API_KEY}` },
      { path: 'src/leak.ts', action: 'add', content: `const k = '${API_KEY}';` },
      { path: 'src/ok.ts', action: 'add', content: 'export const ok = 1;' },
    ];
    const result = applySecretPolicy(files, [], (t) => t.split(API_KEY).join('***REDACTED***'));

    expect(result.dropped).toBe(1);
    expect(result.droppedPaths).toEqual(['.env']);
    expect(result.redacted).toBe(1);
    expect(result.files.map((f) => f.path)).toEqual(['src/leak.ts', 'src/ok.ts']);
    expect(result.files[0]?.content).toContain('***REDACTED***');
    expect(result.files[0]?.content).not.toContain(API_KEY);
    expect(result.files[1]?.content).toBe('export const ok = 1;');
  });

  it('命中特征总数与文件数一致', () => {
    const files: ChangedFile[] = [
      { path: 'a.ts', action: 'add', content: `const k = '${API_KEY}';` },
      { path: 'b.ts', action: 'add', content: `const j = '${API_KEY}';` },
    ];
    const result = applySecretPolicy(files);
    expect(result.redacted).toBe(2);
    expect(result.hits.length).toBeGreaterThanOrEqual(2);
  });

  it('空输入不抛错', () => {
    const result = applySecretPolicy([]);
    expect(result.files).toEqual([]);
    expect(result.dropped).toBe(0);
    expect(result.redacted).toBe(0);
  });
});
