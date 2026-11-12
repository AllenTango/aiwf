/** 密钥脱敏基座专项测试(纯函数)。 */

import { describe, expect, it } from 'vitest';
import {
  REDACTED_PLACEHOLDER,
  SECRET_PATTERNS,
  collectSecretValues,
  createRedactor,
  isSecretEnvName,
  redactText,
} from './redact.js';

describe('REDACTED_PLACEHOLDER', () => {
  it('占位符字面量固定', () => {
    expect(REDACTED_PLACEHOLDER).toBe('***REDACTED***');
  });
});

describe('isSecretEnvName', () => {
  it('表驱动:名字像凭证 → true', () => {
    const cases = [
      'MINIMAX_API_KEY',
      'OPENAI_API_KEY',
      'MY_APIKEY',
      'CLIENT_SECRET',
      'GITHUB_TOKEN',
      'ACTIONS_RUNTIME_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'DB_PASSWORD',
      'DB_PASSWD',
      'AWS_CREDENTIALS',
      'PRIVATE_KEY',
      'AWS_ACCESS_KEY_ID',
      'SSH_KEY',
      'ANTHROPIC_API_KEY',
    ];
    for (const name of cases) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
  });

  it('表驱动:无害环境变量 → false', () => {
    const cases = [
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
      'npm_config_registry',
      'pnpm_home',
      'XDG_CACHE_HOME',
    ];
    for (const name of cases) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });

  it('大小写不敏感;空/非法输入健壮', () => {
    expect(isSecretEnvName('minimax_api_key')).toBe(true);
    expect(isSecretEnvName('github_token')).toBe(true);
    expect(isSecretEnvName('')).toBe(false);
    expect(isSecretEnvName(undefined as unknown as string)).toBe(false);
  });

  it('无害前缀大小写不敏感(小写 npm_/pnpm_/LC_/XDG_ 前缀一律无害)', () => {
    expect(isSecretEnvName('npm_config_registry')).toBe(false);
    expect(isSecretEnvName('NPM_CONFIG_REGISTRY')).toBe(false);
    expect(isSecretEnvName('pnpm_home')).toBe(false);
    expect(isSecretEnvName('PNPM_HOME')).toBe(false);
    expect(isSecretEnvName('lc_all')).toBe(false);
    expect(isSecretEnvName('LC_ALL')).toBe(false);
    expect(isSecretEnvName('xdg_cache_home')).toBe(false);
    expect(isSecretEnvName('XDG_CACHE_HOME')).toBe(false);
    // 前缀无害优先于 TOKEN 片段
    expect(isSecretEnvName('npm_token')).toBe(false);
  });

  it('GITHUB_TOKEN 系列确实是凭证名', () => {
    expect(isSecretEnvName('GITHUB_TOKEN')).toBe(true);
    expect(isSecretEnvName('ACTIONS_RUNTIME_TOKEN')).toBe(true);
    expect(isSecretEnvName('ACTIONS_ID_TOKEN_REQUEST_TOKEN')).toBe(true);
  });
});

describe('collectSecretValues', () => {
  it('只收集名字像凭证、值非空且长度 ≥ 8 的变量', () => {
    const env = {
      MINIMAX_API_KEY: 'abc123secretvalue',
      GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrst',
      PATH: 'C:\\Windows',
      EMPTY_TOKEN: '',
      SHORT_KEY: 'short12',
      UNDEFINED_TOKEN: undefined,
    };
    const values = collectSecretValues(env);
    expect(values).toContain('abc123secretvalue');
    expect(values).toContain('ghp_abcdefghijklmnopqrst');
    expect(values).not.toContain('C:\\Windows');
    expect(values).not.toContain('short12');
    expect(values).not.toContain('');
  });

  it('合并 extraValues(长度 ≥ 8)并去重', () => {
    const values = collectSecretValues({ A_TOKEN: 'aaaaaaaaaaaa' }, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'short']);
    expect(values.filter((v) => v === 'aaaaaaaaaaaa')).toHaveLength(1);
    expect(values).toContain('bbbbbbbbbbbb');
    expect(values).not.toContain('short');
  });

  it('按长度降序返回(长的在前)', () => {
    const values = collectSecretValues({ A: 'abcd1234', B: 'abcd12345678' });
    expect(values[0]).toBe('abcd12345678');
    expect(values[1]).toBe('abcd1234');
  });

  it('空 env / 非法输入健壮不抛', () => {
    expect(collectSecretValues({})).toEqual([]);
    expect(collectSecretValues(undefined as unknown as Record<string, string | undefined>)).toEqual([]);
  });
});

describe('redactText — 通用模式', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['openai 风格 key', 'sk-abcdefghijklmnopqrstuvwx'],
    ['google api key', 'AIzaSyA1234567890abcdefghijklmnopqrstu'],
    ['github token(ghp)', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ['github token(gho)', 'gho_abcdefghijklmnopqrstuvwxyz0123'],
    ['github token(ghs)', 'ghs_abcdefghijklmnopqrstuvwxyz0123'],
    ['github token(ghr)', 'ghr_abcdefghijklmnopqrstuvwxyz0123'],
    ['github token(ghu)', 'ghu_abcdefghijklmnopqrstuvwxyz0123'],
    ['github fine-grained pat', 'github_pat_abcdefghijklmnopqrstuvwxyz0123'],
    ['slack token', 'xoxb-1234567890-abcdefghijkl'],
    ['aws access key', 'AKIAIOSFODNN7EXAMPLE'],
  ];

  it('表驱动:命中即整段替换为占位符', () => {
    for (const [label, raw] of cases) {
      const out = redactText(`前缀 ${raw} 后缀`, []);
      expect(out, label).toContain(REDACTED_PLACEHOLDER);
      expect(out, label).not.toContain(raw);
    }
  });

  it('bearer token:保留 Bearer 前缀,只替换 token', () => {
    const raw = 'abcdefghijklmnopqrstuvwx';
    const out = redactText(`Authorization: Bearer ${raw}`, []);
    expect(out).toBe(`Authorization: Bearer ${REDACTED_PLACEHOLDER}`);
    expect(out).not.toContain(raw);
  });

  it('url 凭证:保留 scheme://user: 与 @host,只替换密码', () => {
    const out = redactText('clone https://user:hunter2hunter2@github.com/org/repo.git', []);
    expect(out).toBe(`clone https://user:${REDACTED_PLACEHOLDER}@github.com/org/repo.git`);
    expect(out).not.toContain('hunter2hunter2');
  });

  it('私钥块整块替换', () => {
    const block = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxx',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactText(`前\n${block}\n后`, []);
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(out).not.toContain('MIIEowIBAAKCAQEA');
    expect(out).toContain(REDACTED_PLACEHOLDER);
  });

  it('SECRET_PATTERNS 覆盖了要求的所有规则名', () => {
    const names = SECRET_PATTERNS.map((p) => p.name);
    for (const required of [
      'openai-style-key',
      'google-api-key',
      'github-token',
      'slack-token',
      'aws-access-key',
      'private-key-block',
      'bearer-token',
      'url-credentials',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('无命中时原样返回', () => {
    const text = '这里没有任何密钥,只是一段普通文本';
    expect(redactText(text, [])).toBe(text);
  });
});

describe('redactText — 取值替换', () => {
  it('替换环境变量取值的所有出现', () => {
    const out = redactText('key=abc123secretvalue and again abc123secretvalue', ['abc123secretvalue']);
    expect(out).toBe(`key=${REDACTED_PLACEHOLDER} and again ${REDACTED_PLACEHOLDER}`);
  });

  it('取值含正则元字符也不会出问题', () => {
    const raw = 'a+b*c(d)';
    const out = redactText(`x=${raw} y`, [raw]);
    expect(out).toBe(`x=${REDACTED_PLACEHOLDER} y`);
  });

  it('空输入 / 空取值 / 非字符串输入健壮不抛', () => {
    expect(redactText('', ['abcdefgh'])).toBe('');
    expect(redactText('abc', [])).toBe('abc');
    expect(redactText('abc', [''])).toBe('abc');
    expect(redactText(undefined as unknown as string, ['abcdefgh'])).toBe('');
  });
});

describe('createRedactor', () => {
  it('环境变量取值被替换成占位符', () => {
    const redact = createRedactor({ MINIMAX_API_KEY: 'abc123secretvalue' });
    const out = redact('我的 key 是 abc123secretvalue,别泄露');
    expect(out).toContain(REDACTED_PLACEHOLDER);
    expect(out).not.toContain('abc123secretvalue');
  });

  it('无害环境变量不会被当凭证', () => {
    const redact = createRedactor({ PATH: 'C:\\Windows\\System32', HOME: 'C:\\Users\\runner' });
    const text = 'PATH=C:\\Windows\\System32 HOME=C:\\Users\\runner';
    expect(redact(text)).toBe(text);
  });

  it('长度降序:长值不被短值截断(两个值都被完整替换)', () => {
    const redact = createRedactor({ A: 'abcd1234', B: 'abcd12345678' });
    const out = redact('值一 abcd12345678 值二 abcd1234');
    expect(out).not.toContain('abcd12345678');
    expect(out).not.toContain('abcd1234');
    expect(out).toBe(`值一 ${REDACTED_PLACEHOLDER} 值二 ${REDACTED_PLACEHOLDER}`);
  });

  it('重复调用结果一致(内部缓存取值)', () => {
    const redact = createRedactor({ MINIMAX_API_KEY: 'abc123secretvalue' }, ['extra-secret-value']);
    const first = redact('abc123secretvalue / extra-secret-value');
    const second = redact('abc123secretvalue / extra-secret-value');
    expect(first).toBe(second);
    expect(first).not.toContain('abc123secretvalue');
    expect(first).not.toContain('extra-secret-value');
  });

  it('无 env 时只做模式脱敏', () => {
    const redact = createRedactor();
    const out = redact('sk-abcdefghijklmnopqrstuvwx');
    expect(out).toBe(REDACTED_PLACEHOLDER);
  });
});
