/**
 * @aiwf/core — shared contracts
 *
 * ⚠️ CAPTAIN-OWNED FILE: members must NOT edit this file.
 *    If you need a change, include the request in your completion report,
 *    and the captain will apply it centrally.
 *
 * Conventions for all members:
 * - ESM only; relative imports in TS sources must end with `.js` (NodeNext).
 * - No logging side effects inside pure logic; use the injected `Logger`.
 * - Never throw for member-level failures: return a `TaskResult` with
 *   `status: 'failed'` + `error` so the pipeline can degrade gracefully.
 */

// ---------------------------------------------------------------------------
// Task ingestion
// ---------------------------------------------------------------------------

export type TaskSource = 'issue' | 'file' | 'inline';

/** A unit of work requested by a human (the thing the team will deliver). */
export interface TaskInput {
  source: TaskSource;
  /** Reference, e.g. "owner/repo#123" for issues, or path for `file`. */
  ref?: string;
  title: string;
  body: string;
  /** Additional comments/descriptions supplied alongside the request. */
  comments?: string[];
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Repository context
// ---------------------------------------------------------------------------

export interface FileSnippet {
  path: string;
  content: string;
  /** Approximate token budget already consumed by this snippet. */
  tokens?: number;
}

/** Immutable snapshot of the target repo handed to planner and members. */
export interface RepoContext {
  rootDir: string;
  branch: string;
  /** Rendered file tree (capped depth/count by the builder). */
  treePreview: string;
  /** Small set of high-signal files (README, package.json, …). */
  keyFiles: FileSnippet[];
  /**
   * 最近提交摘要(`git log --oneline -N`)。
   *
   * 用途:让队长判断「这块代码最近是否正在被改」「是否已有同类工作」——
   * 没有它,队长判断「该调整还是该新做」时几乎是盲的。
   */
  recentCommits?: string[];
}

// ---------------------------------------------------------------------------
// Plan (captain output)
// ---------------------------------------------------------------------------

/** One unit of a plan, dispatched to a member with independent context. */
export interface PlanTask {
  id: string;
  title: string;
  /** Member archetype, e.g. 'implementer' | 'reviewer' | 'packager'. */
  role: string;
  /** Full prompt handed to the member. Must be self-contained. */
  instructions: string;
  /** IDs of tasks that must complete first (DAG edges). */
  dependsOn: string[];
  /** Paths/artifacts the member is expected to touch. */
  expectedOutputs: string[];
  /**
   * 成本权重:low=改文档/小改动,medium=常规实现,high=重构/跨模块改造。
   *
   * 用途:预算超限时按「价值」而不是拓扑序裁剪任务(见 pipeline/plan-economics)。
   */
  weight?: TaskWeight;
  /**
   * 该任务指派的模型(`provider/model`,或模型池里的角色名)。
   * 缺省 → 用引擎默认模型。队长据此为不同队员配备不同模型。
   */
  model?: string;
  /**
   * 队长为**这个任务**追加的行为准则(叠加在内置默认与人类配置之后)。
   */
  guidelines?: string[];
}

/** 队长的裁决:这一轮到底该不该开工。 */
export type PlanVerdict = 'proceed' | 'reject' | 'need_clarification';

/** 任务/整体的成本权重。 */
export type TaskWeight = 'low' | 'medium' | 'high';

/** 队长的成本估计(供人审计与预算裁剪参考)。 */
export interface PlanCost {
  /** 整体成本量级。 */
  weight: TaskWeight;
  /** 预计的模型调用次数(含队长本次)。 */
  expectedCalls: number;
  /** 依据(为什么是这个量级)。 */
  reason: string;
  /** 相对成本单位合计(权重档位口径;1 次调用 = 1 单位 + 队长本次)。 */
  units?: number;
  /** 若人类提供了价格表,这里给绝对金额估算。 */
  estimatedCost?: number;
  /** 绝对金额的币种。 */
  currency?: string;
  /** 逐任务明细。 */
  breakdown?: PlanCostItem[];
}

/** 单个任务的成本明细。 */
export interface PlanCostItem {
  taskId: string;
  /** 该任务指派的模型。 */
  model?: string;
  /** 成本权重。 */
  weight: TaskWeight;
  /** 相对成本单位。 */
  units: number;
}

/** 队长对需求的分析产物(裁决的依据)。 */
export interface PlanAnalysis {
  /** 队长对需求的理解(一段话)。 */
  understanding: string;
  /** 预计受影响的区域/模块。 */
  affectedAreas: string[];
  /** 识别到的风险。 */
  risks: string[];
}

/** 本次运行的预算约束——必须让队长看到,否则它无从做成本权衡。 */
export interface PlanBudget {
  /** 单次运行允许的最大成员任务数(= 编制人数上限)。 */
  maxTasks: number;
  /** 并行队员上限。 */
  maxParallel: number;
  /** 单次运行的墙钟预算(ms)。 */
  wallClockBudgetMs?: number;
  /** 今日剩余可运行次数(未知则省略)。 */
  remainingRuns?: number;
  /** 相对成本预算上限(权重档位单位);队长规划时不得超出。 */
  budgetUnits?: number;
  /** 可指派的模型池(role → model);为空表示只能用默认模型。 */
  modelPool?: Record<string, string>;
}

/** Captain's structured plan for the whole request. */
export interface WorkflowPlan {
  summary: string;
  tasks: PlanTask[];
  risks: string[];
  /** 裁决:缺省 'proceed'(兼容旧计划)。reject/need_clarification 时不派发任何成员。 */
  verdict?: PlanVerdict;
  /** 裁决依据:为什么值得做 / 为什么不值得做 / 缺什么信息。 */
  rationale?: string;
  /** verdict=need_clarification 时需要人回答的问题。 */
  clarifications?: string[];
  /** 成本估计。 */
  cost?: PlanCost;
  /** 队长的分析产物(裁决依据)。 */
  analysis?: PlanAnalysis;
}

// ---------------------------------------------------------------------------
// Member execution
// ---------------------------------------------------------------------------

export type TaskStatus = 'completed' | 'partial' | 'failed';

export type ChangedFileAction = 'add' | 'modify' | 'delete';

export interface ChangedFile {
  path: string;
  action: ChangedFileAction;
  /** New content; required for add/modify. Undefined for delete. */
  content?: string;
}

export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  summary: string;
  changedFiles: ChangedFile[];
  notes: string[];
  /** Populated when status === 'failed'. */
  error?: string;
}

/** Everything a member receives to do its job in isolation. */
export interface MemberContext {
  /** Isolated working directory (a git worktree) for this member. */
  worktreeDir: string;
  /** Branch checked out in the worktree. */
  branch: string;
  repo: RepoContext;
  plan: WorkflowPlan;
  task: PlanTask;
  /**
   * 人类配置的行为准则(与内置默认准则、队长按任务追加的准则叠加)。
   * 队员**施工前**必须先读它 —— 这是「开工前的行为准则」的执行载体。
   */
  guidelines?: string[];
}

// ---------------------------------------------------------------------------
// Engine interface (pluggable AI backends)
// ---------------------------------------------------------------------------

export type EngineKind = 'opencode' | 'mock';

export interface EngineConfig {
  kind: EngineKind;
  /** e.g. "opencode/glm-5.3-free". Engine-specific. */
  model?: string;
  /** Executable override (defaults to engine's discovered bin). */
  binPath?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  extraArgs?: string[];
}

export interface PlanRequest {
  task: TaskInput;
  repo: RepoContext;
  /** Extra captain hints (e.g. from CLI flags). */
  request?: string;
  /** 预算约束:队长必须据此做成本权衡(不喂预算,它就无从判断"够不够/省不省")。 */
  budget?: PlanBudget;
}

/**
 * An engine turns prompts into outcomes. Implementations must be
 * side-effect free except for reading `MemberContext.worktreeDir`.
 */
export interface Engine {
  readonly kind: EngineKind;
  /** Captain step: analyze the request and return a structured plan. */
  plan(req: PlanRequest, config: EngineConfig): Promise<WorkflowPlan>;
  /** Member step: execute exactly one task inside the member's worktree. */
  executeTask(ctx: MemberContext, config: EngineConfig): Promise<TaskResult>;
}

export interface EngineFactory {
  (config: EngineConfig): Engine;
}

// ---------------------------------------------------------------------------
// Platform interface (CLI local vs GitHub Action)
// ---------------------------------------------------------------------------

export interface PullRequestPayload {
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
  /** Non-blocking report attached to the PR as a comment. */
  reportComment?: string;
}

export interface PullRequestHandle {
  number: number;
  url: string;
}

/** Platform adapter: the Action implements GitHub; CLI implements local. */
export interface PlatformClient {
  /** Resolve a task reference like "owner/repo#123" into a TaskInput. */
  fetchTask(ref: string): Promise<TaskInput>;
  createPullRequest(payload: PullRequestPayload): Promise<PullRequestHandle>;
  /**
   * 在任务源上留一条评论(可选能力)。
   *
   * 用途:队长裁决为 reject / need_clarification 时,把「为什么不开工 / 要澄清什么」
   * 回到人类眼前 —— 否则裁决只在日志里,人类看不到。CLI 本地平台不实现。
   */
  postComment?(ref: string, body: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Git plumbing (implemented once, reused by pipeline + shells)
// ---------------------------------------------------------------------------

export interface GitOps {
  currentBranch(dir: string): Promise<string>;
  /** Create a detached worktree on a new branch; returns the worktree path. */
  ensureWorktree(rootDir: string, branch: string): Promise<string>;
  commitAll(dir: string, message: string): Promise<void>;
  diffStat(dir: string, did: string, must: string): Promise<string>;
  /** Merge `branch` into the root repo's checked-out branch. */
  mergeBranch(rootDir: string, branch: string): Promise<void>;
  removeWorktree(rootDir: string, worktreeDir: string): Promise<void>;
  pushBranch(rootDir: string, branch: string, remote?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pipeline events & run results
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export type PipelineStage = 'ingest' | 'plan' | 'dispatch' | 'synthesize' | 'deliver';

export type PipelineEvent =
  | { type: 'stage'; stage: PipelineStage; at: number }
  | { type: 'plan'; plan: WorkflowPlan; at: number }
  | { type: 'task-dispatch'; taskId: string; branch: string; at: number }
  | { type: 'log'; level: LogLevel; message: string; at: number }
  | { type: 'task-result'; result: TaskResult; at: number }
  | { type: 'deliver'; deliverable: Deliverable; at: number };

export type EventSink = (event: PipelineEvent) => void;

/** Final product of one full pipeline run. */
export interface Deliverable {
  /** Branch holding the synthesized result. */
  branch: string;
  /** Captain's closing summary (goes into the PR body / final report). */
  summary: string;
  plan: WorkflowPlan;
  taskResults: TaskResult[];
  pullRequest?: PullRequestHandle;
}

export interface RunResult {
  deliverable: Deliverable;
  stageHistory: { stage: PipelineStage; at: number }[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Workflow configuration & entry
// ---------------------------------------------------------------------------

/**
 * 文本脱敏器:把疑似凭证片段替换为占位符。
 *
 * 约定(安全边界):
 * - 所有「会离开本次运行」的文本(日志、PR 正文、成员总结、提交内容)都必须过脱敏器;
 * - GitHub 只对日志做 secret 掩码,PR 正文与 git 提交**不会**被掩码,故脱敏不能省;
 * - 缺省实现为恒等函数,等价于「不脱敏」(仅本地 CLI/测试场景可接受)。
 */
export type Redactor = (text: string) => string;

export interface WorkflowConfig {
  engine: Engine;
  platform: PlatformClient;
  git: GitOps;
  repoDir: string;
  logger?: Logger;
  onEvent?: EventSink;
  engineConfig?: Partial<EngineConfig>;
  /** 交付基线分支(省缺时取调度前的当前分支)。 */
  baseBranch?: string;
  /** Branch prefix; defaults to "aiwf/". */
  branchPrefix?: string;
  /** Parallel member cap; defaults to 4. */
  maxParallel?: number;
  /** Skip member execution and PR delivery; pipeline reports the plan. */
  dryRun?: boolean;
  /** 文本脱敏器:日志/PR 正文/成员产物统一经此过滤(缺省为恒等)。 */
  redact?: Redactor;
  /**
   * 本次运行中「已知为凭证」的明文值(如环境变量里的 API Key)。
   *
   * 用途:在成员产出物落盘前扫描这些明文,命中即脱敏或剔除,避免密钥进入
   * git 提交与 PR 正文(GitHub 不会对二者做 secret 掩码)。
   */
  secretValues?: readonly string[];
  /** 单次运行允许的最大成员任务数(超出部分按价值裁剪);缺省不限。 */
  maxTasks?: number;
  /** 单次运行的最长墙钟预算(ms);超预算后不再派发新成员。缺省不限。 */
  maxDurationMs?: number;
  /**
   * 相对成本预算上限(权重档位单位)。
   * 队长被告知该预算并自行编制;超预算时运行时按价值裁剪兜底。
   */
  budgetUnits?: number;
  /**
   * 可指派的模型池(role → model)。
   * 队长为不同队员指派不同模型;任务里的 `model` 写池中的角色名或完整 model id。
   */
  modelPool?: Record<string, string>;
  /** 人类配置的行为准则(叠加在内置默认准则之后)。 */
  guidelines?: string[];
  /**
   * 预置计划:存在时**跳过队长规划**,直接采用该计划。
   *
   * 用途:两段式审批(approve=true)—— 第一轮队长的决策包存到 Issue 评论,
   * 人批准后第二轮把决策包读回来注入这里,省掉一次队长调用。
   */
  presetPlan?: WorkflowPlan;
  /**
   * 只出决策包、不派发队员(两段式审批的第一轮)。
   *
   * 与 presetPlan 配合:第一轮 decisionOnly=true(只规划并回帖决策包),
   * 人批准后第二轮 presetPlan=<已批准计划>(执行成员)。
   */
  decisionOnly?: boolean;
}

export interface WorkflowRunner {
  /** Execute the whole Issue→PR closed loop for the given task. */
  run(task: TaskInput): Promise<RunResult>;
}

/** Implemented by @aiwf/core pipeline (M1). Shells build a WorkflowConfig
 *  and call this factory. */
export type WorkflowRunnerFactory = (config: WorkflowConfig) => WorkflowRunner;
