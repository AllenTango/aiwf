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
}

/** Captain's structured plan for the whole request. */
export interface WorkflowPlan {
  summary: string;
  tasks: PlanTask[];
  risks: string[];
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

export interface WorkflowConfig {
  engine: Engine;
  platform: PlatformClient;
  git: GitOps;
  repoDir: string;
  logger?: Logger;
  onEvent?: EventSink;
  engineConfig?: Partial<EngineConfig>;
  /** Branch prefix; defaults to "aiwf/". */
  branchPrefix?: string;
  /** Parallel member cap; defaults to 4. */
  maxParallel?: number;
  /** Skip member execution and PR delivery; pipeline reports the plan. */
  dryRun?: boolean;
}

export interface WorkflowRunner {
  /** Execute the whole Issue→PR closed loop for the given task. */
  run(task: TaskInput): Promise<RunResult>;
}

/** Implemented by @aiwf/core pipeline (M1). Shells build a WorkflowConfig
 *  and call this factory. */
export type WorkflowRunnerFactory = (config: WorkflowConfig) => WorkflowRunner;
