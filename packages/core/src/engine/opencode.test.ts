import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  OpencodeEngine,
  STRIPPED_ENGINE_ENV_VARS,
  buildPlanPrompt,
  buildTaskPrompt,
  parseAiwfResultMark,
  parsePlanJson,
  redactEngineOutput,
  stripEngineEnv,
} from './opencode.js';
import type { MemberContext, PlanRequest, WorkflowPlan } from '../contracts/index.js';
import { REDACTED_PLACEHOLDER, UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../security/index.js';

/** `wrapUntrusted` 输出的开标签带 label 属性,故用前缀判定「已进入不可信块」。 */
const UNTRUSTED_OPEN_PREFIX = UNTRUSTED_OPEN.slice(0, -1);

const planRequestBase = (): PlanRequest => ({
  task: {
    source: 'issue',
    ref: 'acme/app#42',
    title: '支持导出 CSV',
    body: '导出模块需要支持 CSV 格式,字段顺序可配置。',
    comments: ['注意编码'],
  },
  repo: {
    rootDir: 'E:/demo',
    branch: 'main',
    treePreview: '# repo 文件树(root=demo)\npackages/\n  core/\nindex.ts',
    keyFiles: [{ path: 'package.json', content: '{ "name": "demo" }', tokens: 6 }],
  },
  request: '务必保持向后兼容',
});

const validPlanText = JSON.stringify({
  summary: '三个任务的小计划',
  tasks: [
    { id: 't1', title: '实现', role: 'implementer', instructions: '写实现', dependsOn: [], expectedOutputs: ['src/x.ts'] },
    { id: 't2', title: '测试', instructions: '写测试', dependsOn: ['t1'], expectedOutputs: ['a.test.ts'] },
  ],
  risks: ['时间紧'],
});

describe('buildPlanPrompt', () => {
  it('包含工程语境/仓库树/需求/输出契约四类段落', () => {
    const p = buildPlanPrompt(planRequestBase());
    expect(p).toContain('# 任务');
    expect(p).toContain('队长');
    expect(p).toContain('main');
    expect(p).toContain('支持导出 CSV');
    expect(p).toContain('导出模块需要支持 CSV 格式');
    expect(p).toContain('# 仓库快照');
    expect(p).toContain('index.ts');
    expect(p).toContain('package.json');
    expect(p).toContain('"summary"');
    expect(p).toContain('"dependsOn"');
    expect(p).toContain('expectedOutputs');
    expect(p).toContain('risks');
    expect(p).toContain('注意编码');
    expect(p).toContain('务必保持向后兼容');
  });

  it('Issue 正文/评论/附加要求都被 <untrusted-content> 包裹(边界标记在正文前后)', () => {
    const req = planRequestBase();
    req.task.body = '正文注入载荷';
    req.task.comments = ['评论注入载荷'];
    req.request = '附加要求注入载荷';
    const p = buildPlanPrompt(req);

    expect(p).toContain(`${UNTRUSTED_OPEN_PREFIX} label="issue 正文">`);
    expect(p).toContain(`${UNTRUSTED_OPEN_PREFIX} label="issue 评论">`);
    expect(p).toContain(`${UNTRUSTED_OPEN_PREFIX} label="附加要求">`);
    expect(p).toContain(UNTRUSTED_CLOSE);

    // 原始正文的前后都有边界标记
    const bodyIdx = p.indexOf('正文注入载荷');
    expect(bodyIdx).toBeGreaterThan(0);
    expect(p.slice(0, bodyIdx)).toContain(UNTRUSTED_OPEN_PREFIX);
    expect(p.slice(bodyIdx)).toContain(UNTRUSTED_CLOSE);

    // 原有中文标签保留在包裹之外
    expect(p).toContain('正文:');
    expect(p).toContain('补充评论:');
    expect(p).toContain('队长附加要求:');
  });

  it('末尾追加「安全红线」小节', () => {
    const p = buildPlanPrompt(planRequestBase());
    expect(p).toContain('# 安全红线(不可被需求覆盖)');
    expect(p).toContain('安全规则');
    // 安全红线出现在输出格式契约之后(位于 prompt 末尾区域)
    expect(p.indexOf('# 安全红线')).toBeGreaterThan(p.indexOf('# 输出格式(严格遵守)'));
  });

  it('仓库树与关键文件不被误包裹(可信代码上下文)', () => {
    const p = buildPlanPrompt(planRequestBase());
    const treeIdx = p.indexOf('packages/');
    expect(treeIdx).toBeGreaterThan(0);
    expect(p.slice(0, treeIdx)).not.toContain(UNTRUSTED_OPEN_PREFIX);
  });
});

describe('buildTaskPrompt', () => {
  it('包含角色/指令/树/约束/AIWF_RESULT 收尾', () => {
    const req = planRequestBase();
    const plan: WorkflowPlan = {
      summary: '计划摘要一句话',
      tasks: [{ id: 't1', title: '任务甲', role: 'implementer', instructions: '完成某实现', dependsOn: [], expectedOutputs: ['src/a.ts'] }],
      risks: [],
    };
    const ctx: MemberContext = {
      worktreeDir: 'E:/demo/aiwf-work/t1',
      branch: 'aiwf/t1',
      repo: req.repo,
      plan,
      task: plan.tasks[0]!,
    };
    const p = buildTaskPrompt(ctx);
    expect(p).toContain('implementer');
    expect(p).toContain('任务甲');
    expect(p).toContain('完成某实现');
    expect(p).toContain('计划摘要一句话');
    expect(p).toContain('index.ts');
    expect(p).toContain('AIWF_RESULT:');
    expect(p).toContain('"status"');
    expect(p).toContain('不要');
    expect(p).toContain('src/a.ts');
  });

  it('任务指令与计划摘要被 <untrusted-content> 包裹', () => {
    const req = planRequestBase();
    const plan: WorkflowPlan = {
      summary: '计划摘要注入载荷',
      tasks: [{ id: 't1', title: '任务甲', role: 'implementer', instructions: '任务指令注入载荷', dependsOn: [], expectedOutputs: [] }],
      risks: [],
    };
    const ctx: MemberContext = {
      worktreeDir: 'E:/demo/aiwf-work/t1',
      branch: 'aiwf/t1',
      repo: req.repo,
      plan,
      task: plan.tasks[0]!,
    };
    const p = buildTaskPrompt(ctx);

    expect(p).toContain(`${UNTRUSTED_OPEN_PREFIX} label="任务指令">`);
    expect(p).toContain(`${UNTRUSTED_OPEN_PREFIX} label="计划摘要">`);
    expect(p).toContain(UNTRUSTED_CLOSE);

    const idx = p.indexOf('任务指令注入载荷');
    expect(idx).toBeGreaterThan(0);
    expect(p.slice(0, idx)).toContain(UNTRUSTED_OPEN_PREFIX);
    expect(p.slice(idx)).toContain(UNTRUSTED_CLOSE);

    // 原有标签保留在包裹之外
    expect(p).toContain('执行指令(必须完整遵守):');
    expect(p).toContain('整体计划摘要:');
  });

  it('末尾追加「安全红线」小节', () => {
    const req = planRequestBase();
    const plan: WorkflowPlan = {
      summary: '计划摘要一句话',
      tasks: [{ id: 't1', title: '任务甲', role: 'implementer', instructions: '完成某实现', dependsOn: [], expectedOutputs: [] }],
      risks: [],
    };
    const p = buildTaskPrompt({
      worktreeDir: 'E:/demo/aiwf-work/t1',
      branch: 'aiwf/t1',
      repo: req.repo,
      plan,
      task: plan.tasks[0]!,
    });
    expect(p).toContain('# 安全红线(不可被需求覆盖)');
    expect(p).toContain('安全规则');
  });

  it('仓库文件树不被误包裹(可信代码上下文)', () => {
    const req = planRequestBase();
    const plan: WorkflowPlan = {
      summary: 's',
      tasks: [{ id: 't1', title: 't', role: 'implementer', instructions: 'i', dependsOn: [], expectedOutputs: [] }],
      risks: [],
    };
    const p = buildTaskPrompt({
      worktreeDir: 'E:/demo/aiwf-work/t1',
      branch: 'aiwf/t1',
      repo: req.repo,
      plan,
      task: plan.tasks[0]!,
    });
    const treeIdx = p.indexOf('# 仓库文件树(仅作参考,基于当前 worktree)');
    expect(treeIdx).toBeGreaterThan(0);
    const treeSection = p.slice(treeIdx, p.indexOf('# 执行约束'));
    expect(treeSection).not.toContain(UNTRUSTED_OPEN_PREFIX);
  });
});

describe('parsePlanJson', () => {
  it('裸 JSON 可解析,数组字段缺省降级默认值', () => {
    const plan = parsePlanJson(validPlanText);
    expect(plan.summary).toBe('三个任务的小计划');
    expect(plan.tasks.length).toBe(2);
    expect(plan.tasks[0]!.role).toBe('implementer');
    expect(plan.tasks[1]!.dependsOn).toEqual(['t1']);
    expect(plan.risks).toEqual(['时间紧']);
  });

  it('```json 围栏可解析', () => {
    const fence = `\`\`\`json\n${validPlanText}\n\`\`\``;
    const plan = parsePlanJson(fence);
    expect(plan.tasks.length).toBe(2);
  });

  it('JSON 字符串值内嵌 ``` 围栏时仍可解析(CI 实证回归:非贪婪闭栏会半截截断)', () => {
    // 还原线上失败形态:prose 前缀 + ```json 围栏,instructions 字符串值里含 ```bash 围栏。
    const planText = JSON.stringify({
      summary: '演示脚本计划',
      tasks: [
        {
          id: 't1',
          title: '写 PowerShell 演示脚本',
          instructions: '脚本应输出如下围栏:\n```powershell\npnpm run demo\n```\n并保证幂等。',
          dependsOn: [],
          expectedOutputs: ['scripts/demo.ps1'],
        },
      ],
      risks: [],
    });
    const noisy = `I'll explore the repo first.\n\`\`\`json\n${planText}\n\`\`\``;
    const plan = parsePlanJson(noisy);
    expect(plan.summary).toBe('演示脚本计划');
    expect(plan.tasks[0]!.instructions).toContain('pnpm run demo');
  });

  it('围栏前的闲话代码块不干扰真实计划提取', () => {
    const planText = JSON.stringify({
      summary: '计划',
      tasks: [{ id: 't1', title: '实现', instructions: '做', dependsOn: [], expectedOutputs: [] }],
      risks: [],
    });
    const noisy = '```bash\npnpm build\n```\n下面是计划:\n```json\n' + planText + '\n```';
    expect(parsePlanJson(noisy).summary).toBe('计划');
  });

  it('夹杂物(前后闲话 + 内嵌 JSON)可解析', () => {
    const noisy = `好的,以下是我的方案。\n\n\`\`\`json\n${validPlanText}\n\`\`\`\n\n祝顺利!`;
    const plan = parsePlanJson(noisy);
    expect(plan.summary).toBe('三个任务的小计划');
    const looser = `前缀说明(无围栏)${validPlanText}后缀说明(无围栏)`;
    expect(parsePlanJson(looser).tasks.length).toBe(2);
  });

  it('缺失 summary → 报错且附原文前 200 字', () => {
    const bad = JSON.stringify({ tasks: [{ id: 't1', title: 'x', instructions: 'y' }] });
    try {
      parsePlanJson(bad);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain('summary');
      expect((e as Error).message).toContain('200 字');
      expect((e as Error).message).toContain('t1');
    }
  });

  it('tasks 为空/缺 task.id → 报错', () => {
    expect(() => parsePlanJson('{"summary":"s","tasks":[]}')).toThrow(/tasks/);
    expect(() => parsePlanJson('{"summary":"s","tasks":[{"title":"x","instructions":"y"}]}')).toThrow(/id/);
    expect(() => parsePlanJson('{"tasks":[{"id":"t1","title":"x","instructions":"y"}]}')).toThrow(/summary/);
  });

  it('非 JSON 文本 → 描述性报错', () => {
    expect(() => parsePlanJson('我是一只早起的鸟,今早只输出 markdown 而无 JSON。')).toThrow(/JSON/);
  });
});

describe('parseAiwfResultMark', () => {
  it('标准单行标记', () => {
    const m = parseAiwfResultMark('干完了\nAIWF_RESULT: {"status":"completed","summary":"好","notes":["n1"]}');
    expect(m).toEqual({ status: 'completed', summary: '好', notes: ['n1'] });
  });

  it('夹在多行输出中的标记也能取到(partial)', () => {
    const text = [
      '我改了文件。',
      'AIWF_RESULT: {"status":"partial","summary":"缺测试","notes":["缺单测"]}',
      '',
    ].join('\n');
    const m = parseAiwfResultMark(text);
    expect(m?.status).toBe('partial');
    expect(m?.summary).toBe('缺测试');
  });

  it('缺失/坏 JSON/坏 status → null', () => {
    expect(parseAiwfResultMark('只有普通输出')).toBeNull();
    expect(parseAiwfResultMark('AIWF_RESULT: {broken json')).toBeNull();
    expect(parseAiwfResultMark('AIWF_RESULT: {"status":"weird"}')).toBeNull();
    expect(parseAiwfResultMark('')).toBeNull();
  });

  it('notes 缺省 [] / 非 status 字段专', () => {
    const m = parseAiwfResultMark('AIWF_RESULT:{"status":"failed","summary":"坏"}');
    expect(m?.status).toBe('failed');
    expect(m?.notes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 引擎进程环境隔离
// ---------------------------------------------------------------------------

describe('stripEngineEnv', () => {
  it('剥离平台/仓库凭证变量', () => {
    const env: NodeJS.ProcessEnv = {
      GITHUB_TOKEN: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      GH_TOKEN: 'ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      GITHUB_PAT: 'github_pat_ccccccccccccccccccccccccccccccc',
      ACTIONS_RUNTIME_TOKEN: 'runtime-token-value-1234',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'id-token-value-1234567',
      ACTIONS_CACHE_URL: 'https://cache.example.com',
      ACTIONS_RESULTS_URL: 'https://results.example.com',
      ACTIONS_OUTPUT_URL: 'https://output.example.com',
      ACTIONS_STEP_DEBUG: 'true',
      CI_JOB_JWT: 'jwt-value-1234567890',
      GITHUB_ACTIONS_ID_TOKEN_REQUEST_URL: 'https://idtoken.example.com',
      NODE_OPTIONS: '--require /evil.js',
    };
    const out = stripEngineEnv(env);
    for (const name of Object.keys(env)) {
      expect(out[name]).toBeUndefined();
    }
  });

  it('保留模型供应商凭证(引擎调模型必需)', () => {
    const env: NodeJS.ProcessEnv = {
      MINIMAX_API_KEY: 'minimax-key-value-1234',
      ZAI_API_KEY: 'zai-key-value-1234567',
      OPENCODE_API_KEY: 'opencode-key-value-1234',
      ANTHROPIC_API_KEY: 'anthropic-key-value-12',
      OPENAI_API_KEY: 'openai-key-value-12345',
    };
    const out = stripEngineEnv(env);
    expect(out.MINIMAX_API_KEY).toBe('minimax-key-value-1234');
    expect(out.ZAI_API_KEY).toBe('zai-key-value-1234567');
    expect(out.OPENCODE_API_KEY).toBe('opencode-key-value-1234');
    expect(out.ANTHROPIC_API_KEY).toBe('anthropic-key-value-12');
    expect(out.OPENAI_API_KEY).toBe('openai-key-value-12345');
  });

  it('保留基础变量(PATH 等),未命中的原样保留', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/runner',
      CI: 'true',
      GITHUB_REPOSITORY: 'acme/app',
      MY_CUSTOM_VAR: 'hello',
    };
    const out = stripEngineEnv(env);
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/runner');
    expect(out.CI).toBe('true');
    expect(out.GITHUB_REPOSITORY).toBe('acme/app');
    expect(out.MY_CUSTOM_VAR).toBe('hello');
  });

  it('不修改入参对象(返回新对象)', () => {
    const env: NodeJS.ProcessEnv = { GITHUB_TOKEN: 'ghp_x', PATH: '/usr/bin' };
    const out = stripEngineEnv(env);
    expect(out).not.toBe(env);
    expect(env.GITHUB_TOKEN).toBe('ghp_x');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('STRIPPED_ENGINE_ENV_VARS 覆盖必需名单', () => {
    for (const name of [
      'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PAT', 'ACTIONS_RUNTIME_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_CACHE_URL', 'ACTIONS_RESULTS_URL', 'ACTIONS_OUTPUT_URL',
      'ACTIONS_STEP_DEBUG', 'CI_JOB_JWT', 'GITHUB_ACTIONS_ID_TOKEN_REQUEST_URL',
      'NODE_OPTIONS',
    ]) {
      expect(STRIPPED_ENGINE_ENV_VARS).toContain(name);
    }
    // 不得误伤模型供应商凭证
    expect(STRIPPED_ENGINE_ENV_VARS).not.toContain('OPENAI_API_KEY');
    expect(STRIPPED_ENGINE_ENV_VARS).not.toContain('MINIMAX_API_KEY');
  });
});

// ---------------------------------------------------------------------------
// 错误信息脱敏
// ---------------------------------------------------------------------------

describe('redactEngineOutput', () => {
  it('默认 redactor 抹掉形如 openai key 的明文', () => {
    const out = redactEngineOutput('auth failed: sk-abcdefghijklmnop1234567890');
    expect(out).not.toContain('sk-abcdefghijklmnop1234567890');
    expect(out).toContain(REDACTED_PLACEHOLDER);
  });

  it('可注入自定义 redact', () => {
    const out = redactEngineOutput('hello world', () => 'MASKED');
    expect(out).toBe('MASKED');
  });

  it('空串 / 非字符串健壮', () => {
    expect(redactEngineOutput('')).toBe('');
    expect(redactEngineOutput(undefined as unknown as string)).toBe('');
  });
});

describe('OpencodeEngine 错误信息脱敏', () => {
  const SECRET = 'sk-abcdefghijklmnop1234567890';

  const engineWith = (result: { code: number; stdout?: string; stderr?: string; timedOut?: boolean }) =>
    new OpencodeEngine({
      runCommandImpl: async () => ({
        code: result.code,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        timedOut: result.timedOut ?? false,
      }),
    });

  it('plan 阶段非 0 退出码 → Error.message 不含明文密钥', async () => {
    const engine = engineWith({ code: 1, stderr: `boom ${SECRET}`, stdout: `out ${SECRET}` });
    await expect(engine.plan(planRequestBase(), { kind: 'opencode' })).rejects.toSatisfy(
      (e: unknown) => {
        const msg = (e as Error).message;
        expect(msg).not.toContain(SECRET);
        expect(msg).toContain(REDACTED_PLACEHOLDER);
        expect(msg).toContain('stderr 尾部');
        expect(msg).toContain('stdout 尾部');
        return true;
      },
    );
  });

  it('plan 阶段输出无法解析 → 错误信息已脱敏', async () => {
    const engine = engineWith({ code: 0, stdout: `不是 JSON ${SECRET}` });
    await expect(engine.plan(planRequestBase(), { kind: 'opencode' })).rejects.toSatisfy(
      (e: unknown) => {
        const msg = (e as Error).message;
        expect(msg).not.toContain(SECRET);
        expect(msg).toContain(REDACTED_PLACEHOLDER);
        return true;
      },
    );
  });

  it('executeTask 非 0 退出码 → TaskResult.error 不含明文密钥', async () => {
    const worktreeDir = mkdtempSync(path.join(tmpdir(), 'aiwf-oc-'));
    const req = planRequestBase();
    const plan: WorkflowPlan = {
      summary: 's',
      tasks: [{ id: 't1', title: 't', role: 'implementer', instructions: 'i', dependsOn: [], expectedOutputs: [] }],
      risks: [],
    };
    const engine = engineWith({ code: 3, stderr: `crash ${SECRET}` });
    const result = await engine.executeTask(
      { worktreeDir, branch: 'b', repo: req.repo, plan, task: plan.tasks[0]! },
      { kind: 'opencode' },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain(SECRET);
    expect(result.error).toContain(REDACTED_PLACEHOLDER);
  });

  it('子进程环境已剥离平台凭证、保留供应商凭证', async () => {
    const prevToken = process.env.GITHUB_TOKEN;
    const prevKey = process.env.MINIMAX_API_KEY;
    process.env.GITHUB_TOKEN = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    process.env.MINIMAX_API_KEY = 'minimax-key-value-1234';
    let seen: NodeJS.ProcessEnv | undefined;
    const engine = new OpencodeEngine({
      runCommandImpl: async (opts) => {
        seen = opts.env;
        return { code: 0, stdout: validPlanText, stderr: '', timedOut: false };
      },
    });
    try {
      await engine.plan(planRequestBase(), { kind: 'opencode' });
    } finally {
      if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevToken;
      if (prevKey === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = prevKey;
    }
    expect(seen).toBeDefined();
    expect(seen!.GITHUB_TOKEN).toBeUndefined();
    expect(seen!.MINIMAX_API_KEY).toBe('minimax-key-value-1234');
    expect(seen!.PATH).toBeDefined();
  });
});
