/**
 * pipeline/decision-package — 队长决策包的序列化与「两段式审批」载体。
 *
 * 场景(approve=true 时):
 *   第一轮:队长只出决策包,**不派发任何队员** → 把决策包发到 Issue 评论 → 等人批准;
 *   第二轮:人评论 `@aiwf go` → action 读回决策包 → 按它派发队员。
 *
 * 载体选择:Issue 评论(而不是 Actions artifact / cache)—— 因为
 *   - 人类天然会在 Issue 上互动,决策包与讨论在同一处;
 *   - 跨 run 无状态可依,Issue 是唯一稳定的交接面;
 *   - 决策包 JSON 体积远小于评论长度上限。
 *
 * 协议:
 *   - 决策包评论以 `AIWF_DECISION:` 开头,后面紧跟 JSON;
 *   - 批准信号:决策包评论**之后**出现含 `@aiwf go` 的评论(任意评论者)。
 */

import type { WorkflowPlan } from '../contracts/index.js';
import { clampLine } from './md.js';
import { validatePlan } from './plan-utils.js';

/** 决策包评论的协议前缀。 */
export const DECISION_MARKER = 'AIWF_DECISION:';

/** 批准信号(人评论里出现即视为批准执行)。 */
export const APPROVE_SIGNAL = /@aiwf\s+go\b/i;

/** 一条 issue 评论的最小形状。 */
export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

/**
 * 判断某条评论是否携带决策包;是则返回其 JSON 文本。
 */
export function extractDecisionJson(body: string): string | null {
  const index = (body ?? '').indexOf(DECISION_MARKER);
  if (index < 0) return null;
  const json = (body ?? '').slice(index + DECISION_MARKER.length).trim();
  // 决策包后面可能跟人类补充说明:只取到第一个平衡的 JSON 对象为止。
  const start = json.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return json.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 解析并**校验**一份决策包 JSON(来自 Issue 评论)。
 *
 * 为什么必须校验:决策包 JSON 存放在 Issue 评论里,评论是可编辑的。
 * 裸 `JSON.parse` 会让一条被篡改的评论直接变成「要执行的计划」。
 * 这里复用 core 的结构校验(任务 id 唯一 / 依赖存在 / 无环),不合法 → null(视为无决策包)。
 */
export function parseApprovedDecision(json: string): WorkflowPlan | null {
  let plan: unknown;
  try {
    plan = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof plan !== 'object' || plan === null) return null;
  const candidate = plan as WorkflowPlan;
  if (typeof candidate.summary !== 'string' || candidate.summary.trim() === '') return null;
  if (!Array.isArray(candidate.tasks)) return null;
  try {
    validatePlan(candidate);
  } catch {
    return null;
  }
  return candidate;
}

/**
 * 在评论流里找出「待批准的决策包」。
 *
 * 规则:取**最后一个**带决策包的评论,再看它之后有没有 `@aiwf go` 批准信号。
 *   - 有 → 该决策包已获批准,返回它(经校验);
 *   - 没有 → 返回 null(表示需要人先批准)。
 *
 * 决策包之后的普通评论(不含 go)不影响判定。
 */
export function findApprovedDecision(comments: readonly IssueComment[]): WorkflowPlan | null {
  const ordered = [...comments].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  let lastDecisionIndex = -1;
  for (let i = 0; i < ordered.length; i++) {
    if (extractDecisionJson(ordered[i]!.body) !== null) lastDecisionIndex = i;
  }
  if (lastDecisionIndex < 0) return null;
  for (let i = lastDecisionIndex + 1; i < ordered.length; i++) {
    if (APPROVE_SIGNAL.test(ordered[i]!.body)) {
      const json = extractDecisionJson(ordered[lastDecisionIndex]!.body);
      if (json === null) return null;
      return parseApprovedDecision(json);
    }
  }
  return null;
}

/**
 * 决策包的结项摘要(第一轮只出决策包时的 deliverable.summary)。
 */
export function buildDecisionSummary(plan: WorkflowPlan): string {
  const parts: string[] = ['## 队长决策包(待批准,本轮未派发任何队员)', ''];
  parts.push(`整体结论:**${clampLine(plan.summary, 300)}**`);
  if (plan.rationale !== undefined && plan.rationale !== '') {
    parts.push('', '### 判断依据', clampLine(plan.rationale, 800));
  }
  parts.push('', '### 编制与成本');
  const cost = plan.cost;
  parts.push(
    `- 队员数:${plan.tasks.length}` +
      (cost !== undefined
        ? ` · 量级 ${cost.weight} · 预计调用 ${cost.expectedCalls} 次` +
          (cost.units !== undefined ? ` · 相对成本 ${cost.units} 单位` : '')
        : ''),
  );
  for (const t of plan.tasks) {
    parts.push(
      `- \`${t.id}\` [${t.role}${t.weight !== undefined ? `/${t.weight}` : ''}] ${clampLine(t.title, 80)}` +
        (t.model !== undefined ? ` · 模型 ${t.model}` : ''),
    );
  }
  parts.push('', '> 已在任务源留下决策包;回复 `@aiwf go` 即可按本决策包执行(本次未消耗成员模型调用)。');
  return parts.join('\n');
}

/**
 * 队长决策包的评论正文(贴到 Issue 上,等人批准)。
 */
export function buildDecisionPackageComment(plan: WorkflowPlan): string {
  const parts: string[] = [];
  parts.push('🤖 **AI 队长决策包 — 待批准**');
  parts.push('');
  parts.push(`> ${clampLine(plan.summary, 300)}`);
  if (plan.rationale !== undefined && plan.rationale !== '') {
    parts.push('', '**判断依据**', clampLine(plan.rationale, 800));
  }
  if (plan.analysis !== undefined && plan.analysis.affectedAreas.length > 0) {
    parts.push('', '**预计影响范围**', plan.analysis.affectedAreas.map((x) => `- ${clampLine(x, 120)}`).join('\n'));
  }

  parts.push('', '**编制与成本**');
  const cost = plan.cost;
  parts.push(
    `- 队员数:${plan.tasks.length}` +
      (cost !== undefined
        ? ` · 量级 ${cost.weight} · 预计调用 ${cost.expectedCalls} 次` +
          (cost.units !== undefined ? ` · 相对成本 ${cost.units} 单位` : '')
        : ''),
  );
  for (const t of plan.tasks) {
    parts.push(
      `- \`${t.id}\` [${t.role}${t.weight !== undefined ? `/${t.weight}` : ''}] ${clampLine(t.title, 80)}` +
        (t.model !== undefined ? ` · 模型 ${t.model}` : '') +
        (t.dependsOn.length > 0 ? ` · 依赖 ${t.dependsOn.join('、')}` : ''),
    );
  }

  parts.push('', '**批准方式**:回复 `@aiwf go` 即按本决策包执行;不回复则本轮不派发任何队员。');
  parts.push('', '---');
  parts.push(`${DECISION_MARKER}${JSON.stringify(plan)}`);
  parts.push('', '_Generated by ai-dev-workflow-action_');
  return parts.join('\n');
}
