/**
 * engine/guidelines — 队员「施工前的行为准则」(三层叠加)。
 *
 * 三层来源(后者覆盖/细化前者):
 *   1. **内置默认准则**:工程通用底线,任何仓库零配置即生效;
 *   2. **人类配置准则**:仓库在 workflow 里通过 `guidelines` 传入(如「提交前必须跑 pnpm test」);
 *   3. **队长按任务追加**:队长为某个具体任务补的专项要求。
 *
 * 与 `security/prompt-guard.ts` 的 **安全红线** 是两回事:
 *   - 安全红线 = 不可协商的硬约束(防凭证泄露、防提示注入、防越权);
 *   - 行为准则 = 干活方式与产出要求(可由人类/队长按仓库与任务定制)。
 * 两者都注入队员 prompt,安全红线优先级更高。
 */

/** 内置默认准则(工程通用底线)。 */
export const DEFAULT_MEMBER_GUIDELINES: readonly string[] = [
  '开工前先通读任务指令与相关文件,确认验收标准与边界,再动手改代码;不要边猜边写。',
  '只改动与本任务直接相关的文件:不重构无关代码、不顺手清理、不新增未经要求的依赖。',
  '不修改 `.git/**` 的任何内容;不执行 git 提交/合并/推送/创建 worktree(版本控制由上游统一处理)。',
  '你的工作目录就是分配给你的独立 worktree,直接在其中创建/修改文件,不要切换到别的目录。',
  '完成后自检:能跑的相关测试或构建要实际跑一遍,并在总结里写明自检结果(跑了什么、是否全绿)。',
  '若任务范围不明确、或与现有实现冲突,不要自行扩大范围:在总结里说明冲突点并标记 partial/failed。',
  '汇报要具体:写清楚改了哪些文件、为什么这么改、留下什么已知问题,不要写「已完成」这类空话。',
];

export interface GuidelineSources {
  /** 人类配置的准则。 */
  human?: readonly string[];
  /** 队长为当前任务追加的准则。 */
  task?: readonly string[];
}

/**
 * 把三层准则渲染成一段可直接拼进 prompt 的中文文本。
 *
 * 返回空串表示没有任何准则(调用方可跳过该段落)。
 */
export function buildGuidelinesBlock(sources: GuidelineSources = {}): string {
  const sections: string[] = [];

  const defaults = DEFAULT_MEMBER_GUIDELINES;
  if (defaults.length > 0) {
    sections.push(['## 行为准则(内置默认)', ...defaults.map((g, i) => `${i + 1}. ${g}`)].join('\n'));
  }

  const human = (sources.human ?? []).map((g) => g.trim()).filter((g) => g !== '');
  if (human.length > 0) {
    sections.push(
      ['## 行为准则(仓库配置,必须遵守)', ...human.map((g, i) => `${i + 1}. ${g}`)].join('\n'),
    );
  }

  const task = (sources.task ?? []).map((g) => g.trim()).filter((g) => g !== '');
  if (task.length > 0) {
    sections.push(
      ['## 行为准则(本任务专项要求)', ...task.map((g, i) => `${i + 1}. ${g}`)].join('\n'),
    );
  }

  return sections.join('\n\n');
}
