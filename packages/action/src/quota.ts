/**
 * @aiwf/action — 每日运行配额(纯逻辑 + 可注入的计数器)。
 * OWNER: M3.
 *
 * 背景:即便做了触发准入,被信任的人也可能无意中把额度烧穿;再者 workflow 被
 * 误配置成监听宽泛事件时,一次外部触发可能带来成串运行。此模块为「本仓库单日
 * 最大运行次数」提供判定,并把「统计失败」与「统计到 N 次」严格区分。
 *
 * 设计要点(取舍):
 *   - **失败开放(fail-open)**:统计运行次数需要 `actions: read` 权限,workflow 的
 *     `permissions` 块可能没给。一旦统计失败就硬失败,会误伤所有正常运行;
 *     因此统计失败时放行本次运行,但在 reason 中明确写明「配额统计失败」。
 *   - `used >= limit` 即拒绝:limit=20 时第 21 次运行被拒。
 */
export interface QuotaDecision {
  allowed: boolean;
  /** 可直接进日志/注释的中文说明。 */
  reason: string;
  /** 已用次数(统计成功时给出)。 */
  used?: number;
  /** 生效的上限(limit > 0 时给出)。 */
  limit?: number;
}

/**
 * 纯判定:是否放行本次运行。
 *   - limit ≤ 0 → 放行(不限);
 *   - used >= limit → 拒绝;
 *   - 否则放行。
 */
export function evaluateDailyQuota(opts: { limit: number; used: number }): QuotaDecision {
  const limit = opts.limit;
  const used = opts.used;
  if (!Number.isFinite(limit) || limit <= 0) {
    return {
      allowed: true,
      used,
      reason: '未设置每日运行次数上限(daily_run_limit ≤ 0),本次运行不受配额限制。',
    };
  }
  if (used >= limit) {
    return {
      allowed: false,
      used,
      limit,
      reason: `本仓库当日运行次数已达上限(已用 ${used}/${limit}),本次运行被拒绝以避免超额消耗模型额度。`,
    };
  }
  return {
    allowed: true,
    used,
    limit,
    reason: `本仓库当日运行次数 ${used}/${limit},本次运行在配额内。`,
  };
}

/**
 * 从 `GITHUB_WORKFLOW_REF` 中解析出工作流文件名(作为 GitHub API 的 workflow_id)。
 *
 *   'owner/repo/.github/workflows/aiwf.yml@main' → 'aiwf.yml'
 *
 * 解析不到时返回 undefined(调用方退化为 `github.context.workflow` 的文件名)。
 */
export function parseWorkflowFileName(workflowRef?: string): string | undefined {
  const raw = (workflowRef ?? '').trim();
  if (raw === '') {
    return undefined;
  }
  // 去掉 `@ref` 后缀
  const withoutRef = raw.split('@')[0] ?? '';
  const segments = withoutRef.split('/').filter((segment) => segment !== '');
  const fileName = segments[segments.length - 1];
  if (fileName === undefined || fileName === '') {
    return undefined;
  }
  return fileName;
}

/** 当前 UTC 日的起点 ISO 字符串(形如 '2026-11-12T00:00:00Z')。 */
export function startOfUtcDayIso(now: Date = new Date()): string {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  return formatIsoSeconds(start);
}

/** 计数器的注入接口:统计「某工作流自 since 起的运行次数」。 */
export interface RunCounter {
  (opts: { owner: string; repo: string; workflowId: string; since: string }): Promise<number>;
}

/**
 * 统计「当日运行次数」的组合子:注入计数器 + 计算 since。
 *
 * 与「统计失败」严格区分:计数器抛错时本函数**向上抛**,
 * 由 {@link enforceDailyQuota} 决定 fail-open 策略。
 */
export async function countRunsTodaySince(opts: {
  counter: RunCounter;
  owner: string;
  repo: string;
  workflowId: string;
  since?: string;
}): Promise<number> {
  const since = opts.since ?? startOfUtcDayIso();
  return await opts.counter({
    owner: opts.owner,
    repo: opts.repo,
    workflowId: opts.workflowId,
    since,
  });
}

/**
 * 每日配额闸门:
 *   - limit ≤ 0 → 直接放行(不调用计数器);
 *   - 统计成功 → 依 {@link evaluateDailyQuota} 判定;
 *   - 统计失败 → **失败开放**:放行本次运行,reason 明确写明「配额统计失败」。
 */
export async function enforceDailyQuota(opts: {
  limit: number;
  counter: RunCounter;
  owner: string;
  repo: string;
  workflowId: string;
  since?: string;
}): Promise<QuotaDecision> {
  if (!Number.isFinite(opts.limit) || opts.limit <= 0) {
    return {
      allowed: true,
      limit: opts.limit,
      reason: '未设置每日运行次数上限(daily_run_limit ≤ 0),本次运行不受配额限制。',
    };
  }

  let used: number;
  try {
    used = await countRunsTodaySince({
      counter: opts.counter,
      owner: opts.owner,
      repo: opts.repo,
      workflowId: opts.workflowId,
      ...(opts.since === undefined ? {} : { since: opts.since }),
    });
  } catch (error) {
    // fail-open:统计失败不应误伤正常运行(permissions 可能缺 actions: read)。
    return {
      allowed: true,
      limit: opts.limit,
      reason:
        `配额统计失败,本次未受配额限制:${error instanceof Error ? error.message : String(error)}` +
        '(失败开放:统计当日运行次数需要 actions: read 权限,缺失时不做拒绝,以免误伤正常运行)。',
    };
  }

  if (!Number.isFinite(used) || used < 0) {
    used = 0;
  }
  return evaluateDailyQuota({ limit: opts.limit, used });
}

/** 格式化为 `YYYY-MM-DDTHH:mm:ssZ`(GitHub API 的 created 过滤可用)。 */
function formatIsoSeconds(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`
  );
}
