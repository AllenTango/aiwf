/**
 * @aiwf/core 公共 barrel。
 *
 * - contracts:契约唯一事实源(队长所有);
 * - pipeline:五阶段流水线(M1);
 * - engine / infra:M2 交付,导出名以契约为准(createEngine / NodeGitOps / buildRepoContext)。
 * - security:安全基座(脱敏 / 凭证扫描 / 不可信内容包装)。
 *
 * 注意:`Redactor` 类型以 contracts 为准,此处**不**从 security 重复导出同名符号,
 * 避免 `export *` 的重名歧义(TS2308)。两者结构一致,可互相赋值。
 */
export * from './contracts/index.js';
export { createWorkflowRunner } from './pipeline/index.js';
export { createEngine } from './engine/index.js';
export { NodeGitOps, buildRepoContext } from './infra/index.js';
export {
  REDACTED_PLACEHOLDER,
  SECRET_PATTERNS,
  isSecretEnvName,
  collectSecretValues,
  redactText,
  createRedactor,
} from './security/index.js';
export type { SecretPattern } from './security/index.js';
export {
  detectSecrets,
  containsSecret,
  redactFileContent,
} from './security/index.js';
export type { SecretHit } from './security/index.js';
export {
  UNTRUSTED_OPEN,
  UNTRUSTED_CLOSE,
  SECURITY_RULES,
  sanitizeUntrustedContent,
  wrapUntrusted,
  buildSecurityRulesBlock,
} from './security/index.js';
export { applySecretPolicy, isSecretFilePath } from './pipeline/secret-policy.js';
export {
  resolveTaskModel,
  trimToBudget,
  estimateCost,
  unitsOf,
  DEFAULT_WEIGHT_UNITS,
  WEIGHT_RANK,
} from './pipeline/plan-economics.js';
export {
  APPROVE_SIGNAL,
  DECISION_MARKER,
  buildDecisionPackageComment,
  buildDecisionSummary,
  extractDecisionJson,
  findApprovedDecision,
  parseApprovedDecision,
} from './pipeline/decision-package.js';
export type { IssueComment } from './pipeline/decision-package.js';
export {
  RUN_MARKER,
  buildRunRecordComment,
  computeTaskFingerprint,
  findLastRunRecord,
  parseRunRecord,
} from './pipeline/idempotency.js';
export type { RunRecord } from './pipeline/idempotency.js';
export { buildGuidelinesBlock, DEFAULT_MEMBER_GUIDELINES } from './engine/guidelines.js';
