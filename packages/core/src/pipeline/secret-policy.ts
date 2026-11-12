/**
 * pipeline/secret-policy — 成员产出物的凭证防护策略(纯逻辑,无 IO)。
 *
 * 背景:GitHub 只对**日志**做 secret 掩码,PR 正文与 git 提交内容**不会**被掩码。
 * 成员 agent 以 `--auto` 权限在 worktree 内执行命令,若被诱导执行 `env` /
 * `cat ~/.local/share/opencode/auth.json`,凭证会经由两条路径外泄:
 *   1) 产出文件 → git 提交 → PR diff;
 *   2) 成员 notes/summary → PR 正文。
 * 本模块负责第 1 条(第 2 条由 runner 的统一脱敏兜底)。
 *
 * 策略:
 * - 路径命中「凭证文件特征」(.env / *.pem / auth.json …)→ 整文件剔除,不落盘、不提交;
 * - 内容命中「凭证特征」(API Key / token / 私钥块 …)→ 内容就地脱敏后落盘;
 * - 其余文件原样通过。
 *
 * 纯函数,便于表驱动单测;不依赖 fs / git / 引擎。
 */

import type { ChangedFile } from '../contracts/index.js';
import { detectSecrets } from '../security/index.js';
import type { SecretHit } from '../security/index.js';

/** 凭证文件的路径特征(相对仓库根,统一用 `/` 分隔)。 */
export const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)\.ssh\/.+$/i,
  /(^|\/)\.aws\/.+$/i,
  /(^|\/)\.config\/opencode\/.+$/i,
  /(^|\/)\.local\/share\/opencode\/.+$/i,
  /(^|\/)credentials(\.[a-z0-9]+)?$/i,
  /(^|\/)auth\.json$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
];

/** 该路径是否应被视为「凭证文件」(整文件剔除)。 */
export function isSecretFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** 单个文件的处置结论。 */
export type FileDisposition = 'keep' | 'redact' | 'drop';

export interface FileSanitizeOutcome {
  disposition: FileDisposition;
  /** disposition === 'redact' 时为脱敏后的新内容。 */
  content?: string;
  /** 命中的凭证特征(样本已脱敏,不含明文)。 */
  hits: SecretHit[];
}

/**
 * 对单个文件做凭证检查(纯逻辑,不做 IO)。
 *
 * @param file 待检查的变更文件
 * @param secretValues 本次运行已知的凭证明文
 */
export function sanitizeChangedFile(
  file: ChangedFile,
  secretValues: readonly string[] = [],
): FileSanitizeOutcome {
  if (isSecretFilePath(file.path)) {
    return { disposition: 'drop', hits: [] };
  }
  if (file.action === 'delete' || typeof file.content !== 'string' || file.content === '') {
    return { disposition: 'keep', hits: [] };
  }
  const hits = detectSecrets(file.content, secretValues);
  if (hits.length === 0) {
    return { disposition: 'keep', hits: [] };
  }
  return { disposition: 'redact', hits };
}

/** 一次批量处置的结果。 */
export interface SecretPolicyResult {
  /** 净化后的文件列表(drop 的已剔除)。 */
  files: ChangedFile[];
  /** 被整文件剔除的路径(供上层在工作树中物理删除)。 */
  droppedPaths: string[];
  /** 被整文件剔除的数量。 */
  dropped: number;
  /** 内容被脱敏的文件数量。 */
  redacted: number;
  /** 全部命中的特征汇总。 */
  hits: SecretHit[];
}

/**
 * 批量处置成员产出物。
 *
 * @param files 成员声明的变更文件
 * @param secretValues 本次运行已知的凭证明文
 * @param redact 内容脱敏函数(缺省为恒等;生产环境应传入带凭证模式匹配的 redactor)
 */
export function applySecretPolicy(
  files: readonly ChangedFile[],
  secretValues: readonly string[] = [],
  redact: (text: string) => string = (text) => text,
): SecretPolicyResult {
  const out: ChangedFile[] = [];
  const droppedPaths: string[] = [];
  const hits: SecretHit[] = [];
  let dropped = 0;
  let redacted = 0;

  for (const file of files) {
    const outcome = sanitizeChangedFile(file, secretValues);
    hits.push(...outcome.hits);

    if (outcome.disposition === 'drop') {
      dropped += 1;
      droppedPaths.push(file.path);
      continue;
    }

    if (outcome.disposition === 'redact' && typeof file.content === 'string') {
      redacted += 1;
      out.push({ ...file, content: redact(file.content) });
      continue;
    }

    out.push(file);
  }

  return { files: out, droppedPaths, dropped, redacted, hits };
}

