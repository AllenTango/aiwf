/**
 * engine/mock — 离线确定性 Engine(测试与本地演练用,零 AI 调用)。
 *
 * 约定(关键词即语义,仅做文本匹配、不做任何"智能"):
 * - plan(): 把需求拆成 t1、t2(dependsOn:['t1'])的小计划;需求中含 `t3`(或 T3)时追加
 *   平行任务 t3(dependsOn:['t1'],与 t2 并行,便于演练并行合成)。
 * - 关键词:见到 `FAIL` → 该任务执行按 failed;`PARTIAL` → partial;
 *   `CONFLICT` → 该任务同时写共享文件 shared/decision.txt(多成员写同一路径 → 合并冲突)。
 * - 关键词可逐任务绑定:某行同时出现任务 id 与关键词时,只影响该任务;
 *   否则(仅全局出现)按默认分配:FAIL→全部任务;PARTIAL→t3(无 t3 则 t2);CONFLICT→全部任务。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  Engine, EngineConfig, MemberContext, PlanRequest, PlanTask,
  TaskResult, WorkflowPlan, ChangedFile,
} from '../contracts/index.js';

const KEYWORD_RE = /\b(FAIL|PARTIAL|CONFLICT)\b/g;

interface KeywordBinding {
  fail: Set<string>;
  partial: Set<string>;
  conflict: Set<string>;
}

/** 从需求文本解析关键词→任务绑定。返回 null 表示该关键词没有在任何行出现。 */
function parseKeywordBindings(text: string): { bound: KeywordBinding; global: KeywordBinding } {
  const bound: KeywordBinding = { fail: new Set(), partial: new Set(), conflict: new Set() };
  const global: KeywordBinding = { fail: new Set(), partial: new Set(), conflict: new Set() };

  for (const line of text.split(/\r?\n/)) {
    const ids = new Set<string>();
    for (const m of line.matchAll(/\bt([123])\b/g)) {
      const id = `t${m[1]}`;
      if (id) ids.add(id);
    }
    const seen = new Set<string>();
    for (const m of line.matchAll(KEYWORD_RE)) {
      const kw = m[1];
      if (!kw || seen.has(kw)) continue;
      seen.add(kw);
      if (ids.size > 0) {
        for (const id of ids) assign(bound, kw, id);
      } else {
        assign(global, kw, '*');
      }
    }
  }
  return { bound, global };
}

function assign(kb: KeywordBinding, kw: string, id: string): void {
  if (kw === 'FAIL') kb.fail.add(id);
  if (kw === 'PARTIAL') kb.partial.add(id);
  if (kw === 'CONFLICT') kb.conflict.add(id);
}

/** 把绑定展开成任务 id → 关键词集合(全局裸关键词按默认位置落位)。 */
function resolveKeywords(bound: KeywordBinding, global: KeywordBinding, ids: string[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const id of ids) out.set(id, new Set<string>());

  // 全局裸关键词默认落位:
  if (global.fail.has('*')) {
    for (const id of ids) out.get(id)?.add('FAIL');
  }
  if (global.partial.has('*')) {
    const slot = ids.includes('t3') ? 't3' : 't2';
    out.get(slot)?.add('PARTIAL');
  }
  if (global.conflict.has('*')) {
    for (const id of ids) out.get(id)?.add('CONFLICT');
  }

  // 逐任务绑定覆盖/追加:
  for (const id of bound.fail) out.get(id)?.add('FAIL');
  for (const id of bound.partial) out.get(id)?.add('PARTIAL');
  for (const id of bound.conflict) out.get(id)?.add('CONFLICT');

  const result = new Map<string, string[]>();
  for (const [id, set] of out) result.set(id, [...set].sort());
  return result;
}

/** 关键词判定用(非全局,避免 lastIndex 状态污染)。 */
const KEYWORD_HAS_RE = /\b(FAIL|PARTIAL|CONFLICT)\b/;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export class MockEngine implements Engine {
  readonly kind = 'mock' as const;

  plan(req: PlanRequest, _config: EngineConfig): Promise<WorkflowPlan> {
    const t = req.task;
    const text = [t.title, t.body, ...(t.comments ?? []), req.request ?? ''].join('\n');

    const wantThree = /\bt3\b|\bT3\b|三个任务|third task/i.test(text);
    const ids = wantThree ? ['t1', 't2', 't3'] : ['t1', 't2'];
    const { bound, global } = parseKeywordBindings(text);
    const kw = resolveKeywords(bound, global, ids);

    const taskOf = (id: string, role: string, title: string, focus: string): PlanTask => {
      const keywords = kw.get(id) ?? [];
      // 逐任务摘录:优先取显式提到本任务 id 的行,避免把其它任务的关键词泄漏进本任务指令。
      const reqLines = [t.title, ...t.body.split(/\r?\n/), ...(t.comments ?? []), ...(req.request ? req.request.split(/\r?\n/) : [])]
        .filter((s) => s.trim());
      const idLines = reqLines.filter((l) => new RegExp(`\\b${id}\\b`, 'i').test(l));
      const excerptSource = idLines.length > 0 ? idLines : reqLines.filter((l) => !KEYWORD_HAS_RE.test(l));
      const contextDigest = truncate(excerptSource.join(' / '), 500);
      const lines = [
        `【拟派任务】${title}`,
        `【角色】${role}`,
        `【需求摘录】${contextDigest}`,
        `【任务焦点】${focus}`,
        `【产出预期】${id}.md 中包含执行说明(相对路径 mock/${id}.md)`,
      ];
      if (keywords.includes('FAIL')) lines.push('【约定关键域】FAIL — 本任务应按失败收尾(Mock 语义)。');
      if (keywords.includes('PARTIAL')) lines.push('【约定关键域】PARTIAL — 本任务应按部分完成收尾(Mock 语义)。');
      if (keywords.includes('CONFLICT')) lines.push('【约定关键域】CONFLICT — 本任务须额外写共享文件 shared/decision.txt(制造合并冲突)。');
      return {
        id,
        title,
        role,
        instructions: lines.join('\n'),
        dependsOn: id === 't1' ? [] : ['t1'],
        expectedOutputs: keywords.includes('CONFLICT') ? [`mock/${id}.md`, 'shared/decision.txt'] : [`mock/${id}.md`],
        weight: 'medium',
        // 若配置了模型池,mock 也按池指派模型(便于演练「不同队员不同模型」)。
        ...(req.budget?.modelPool?.['worker'] !== undefined
          ? { model: 'worker' }
          : req.budget?.modelPool?.['default'] !== undefined
            ? { model: 'default' }
            : {}),
      };
    };

    const tasks: PlanTask[] = [
      taskOf('t1', 'implementer', 't1 基础实现', '完成需求的最小主路实现'),
      taskOf('t2', 'implementer', 't2 补充实现', '在前置任务之上补齐增强细节(独立分支)'),
    ];
    if (wantThree) {
      tasks.push(taskOf('t3', 'implementer', 't3 并行分支', '与 t2 平行,验证多分支合成路径'));
    }

    const risks: string[] = ['mock 引擎为确定性占位实现,仅用于测试与演练'];
    if ([...kw.values()].some((k) => k.includes('CONFLICT'))) {
      risks.push('检测到 CONFLICT:多任务会写 shared/decision.txt,合成阶段预计出现合并冲突');
    }
    if ([...kw.values()].some((k) => k.includes('FAIL') || k.includes('PARTIAL'))) {
      risks.push('检测到 FAIL/PARTIAL:部分成员任务不会以 completed 收尾');
    }

    const plan: WorkflowPlan = {
      verdict: 'proceed',
      rationale: 'mock 引擎:固定演练计划,不做真实价值判断',
      summary: `mock 计划:${tasks.length} 个任务(${tasks.map((x) => x.id).join(' → / ')})`,
      tasks,
      risks,
      analysis: {
        understanding: 'mock 引擎的确定性占位分析,不反映真实仓库情况',
        affectedAreas: tasks.map((t) => `mock/${t.id}.md`),
        risks,
      },
      cost: {
        weight: tasks.length >= 3 ? 'medium' : 'low',
        expectedCalls: tasks.length + 1,
        units: tasks.reduce((sum, t) => sum + (t.weight === 'low' ? 1 : t.weight === 'high' ? 8 : 3), 0),
        reason: 'mock 引擎按任务数线性估算',
        breakdown: tasks.map((t) => ({
          taskId: t.id,
          weight: t.weight ?? 'medium',
          units: t.weight === 'low' ? 1 : t.weight === 'high' ? 8 : 3,
        })),
      },
    };
    return Promise.resolve(plan);
  }

  async executeTask(ctx: MemberContext, _config: EngineConfig): Promise<TaskResult> {
    const task = ctx.task;
    const outputDir = path.join(ctx.worktreeDir, 'mock');
    const mdPath = path.join(outputDir, `${task.id}.md`);

    try {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(mdPath, mockMdContent(ctx), 'utf8');
    } catch (e) {
      return {
        taskId: task.id,
        status: 'failed',
        summary: `mock 写入任务档案失败(tid: ${task.id})`,
        changedFiles: [],
        notes: [`目标文件: mock/${task.id}.md`],
        error: `写入 mock/${task.id}.md 失败: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const searchText = `${task.title}\n${task.instructions}`;
    const hasFail = /\bFAIL\b/.test(searchText);
    const hasPartial = /\bPARTIAL\b/.test(searchText);
    const hasConflict = /\bCONFLICT\b/.test(searchText);

    const changedFiles: ChangedFile[] = [
      { path: `mock/${task.id}.md`, action: 'add', content: mockMdContent(ctx) },
    ];
    const notes: string[] = ['MockEngine:点击执行即写文件,不计算真实 diff'];

    if (hasConflict) {
      try {
        const sharedPath = path.join(ctx.worktreeDir, 'shared', 'decision.txt');
        await fs.mkdir(path.dirname(sharedPath), { recursive: true });
        const decision = mockDecisionContent(ctx);
        await fs.writeFile(sharedPath, decision, 'utf8');
        changedFiles.push({ path: 'shared/decision.txt', action: 'add', content: decision });
        notes.push('已按 CONFLICT 写共享裁决文件 shared/decision.txt');
      } catch (e) {
        return {
          taskId: task.id,
          status: 'failed',
          summary: `mock 写共享裁决文件失败(tid: ${task.id})`,
          changedFiles,
          notes: [...notes],
          error: `写入 shared/decision.txt 失败: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    let status: 'completed' | 'partial' | 'failed' = 'completed';
    let error: string | undefined;
    if (hasFail) {
      status = 'failed';
      error = 'mock 语义失败:任务指令含 FAIL 关键词';
    } else if (hasPartial) {
      status = 'partial';
    }

    const facebits = hasFail ? 'FAIL' : hasPartial ? 'PARTIAL' : hasConflict ? 'CONFLICT' : '常规';
    const summary = `mock 完成 ${task.id}(方式 ${facebits});写入 mock/${task.id}.md${hasConflict ? ' 与 shared/decision.txt' : ''}`;

    const noteCopy = hasFail
      ? [...notes, '任务以 failed 收尾;变更目录仍保留现场(mock/<id>.md),changedFiles 不上交']
      : [...notes];

    return {
      taskId: task.id,
      status,
      summary,
      changedFiles: hasFail ? [] : changedFiles,
      notes: noteCopy,
      error,
    };
  }
}

function mockMdContent(ctx: MemberContext): string {
  const lines = [
    `# ${ctx.task.title}(${ctx.task.id})`,
    '',
    `> 由 MockEngine 生成的任务档案;分支 ${ctx.branch};角色 ${ctx.task.role}。`,
    '',
    `## 计划摘要`,
    ctx.plan.summary,
    '',
    `## 指令`,
    ctx.task.instructions,
    '',
    `## 预期产出`,
    ...(ctx.task.expectedOutputs.length ? ctx.task.expectedOutputs.map((p) => `- ${p}`) : ['- (未指定)']),
    '',
  ];
  return `${lines.join('\n')}`;
}

function mockDecisionContent(ctx: MemberContext): string {
  return [
    `# 共享裁决(mock/${ctx.task.id})`,
    `任务 ${ctx.task.id} 的诉求摘录:`,
    truncate(ctx.task.instructions.replace(/\s+/g, ' '), 200),
  ].join('\n');
}
