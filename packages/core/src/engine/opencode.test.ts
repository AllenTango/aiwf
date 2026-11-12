import { describe, expect, it } from 'vitest';

import { buildPlanPrompt, buildTaskPrompt, parseAiwfResultMark, parsePlanJson } from './opencode.js';
import type { MemberContext, PlanRequest, WorkflowPlan } from '../contracts/index.js';

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
