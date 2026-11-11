/**
 * Pipeline 队员区(M1):ingest → plan → dispatch → synthesize → deliver。
 *
 * 对 shells 的稳定导出是 createWorkflowRunner(契约 WorkflowRunnerFactory);
 * 纯函数 buildPullRequestBody 单独导出,便于复用与测试。
 */
export { createWorkflowRunner } from './runner.js';
export { buildPullRequestBody, PR_DISCLAIMER } from './pull-request-body.js';
export {
  buildDeliverSummary,
  overallStatus,
  parseConflictFiles,
  STATUS_MARK,
  type MergeConflict,
} from './summary.js';
