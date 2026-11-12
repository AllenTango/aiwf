/**
 * @aiwf/action — 触发准入判定(纯函数,便于表驱动测试)。
 * OWNER: M3.
 *
 * 背景:workflow 监听 `issues: [opened, edited]`,任何外部用户开个 issue 就能
 * 触发一次真模型调用(直接烧额度)。本模块负责在「读取 Issue 之前」判定
 * 触发者是否有资格消耗本仓库的模型额度。
 *
 * 判定输入(全部来自 GitHub 事件上下文,无 IO):
 *   - actor:github.context.actor(事件发起者);
 *   - authorAssociation:事件对象的 author_association(OWNER/MEMBER/COLLABORATOR/
 *     CONTRIBUTOR/NONE/...);
 *   - allowed_actors:仓库级白名单(逗号分隔,忽略大小写)。
 */
/** 触发准入策略。 */
export type TriggerPolicy = 'trusted' | 'anyone';

/** 视为「可信任」的仓库权限等级(GitHub author_association 取值)。 */
export const TRUSTED_ASSOCIATIONS: readonly string[] = ['OWNER', 'MEMBER', 'COLLABORATOR'];

export interface TriggerDecision {
  allowed: boolean;
  /** 可直接进日志/注释的中文说明。 */
  reason: string;
}

export interface TriggerContext {
  policy: TriggerPolicy;
  /** 逗号分隔白名单解析后的用户名列表(保留原大小写,比较时忽略大小写)。 */
  allowedActors: readonly string[];
  /** github.context.actor */
  actor?: string;
  /** OWNER/MEMBER/COLLABORATOR/CONTRIBUTOR/NONE/... */
  authorAssociation?: string;
}

/** 白名单命中(忽略大小写)。 */
function isAllowedActor(actor: string, allowedActors: readonly string[]): boolean {
  const normalized = actor.trim().toLowerCase();
  if (normalized === '') {
    return false;
  }
  return allowedActors.some((candidate) => candidate.trim().toLowerCase() === normalized);
}

/**
 * 触发准入判定:
 *   - policy=anyone → 一律放行(带风险提醒文案);
 *   - policy=trusted → 仅当 actor 命中白名单 **或** authorAssociation 属于
 *     TRUSTED_ASSOCIATIONS 时放行,否则拒绝。
 */
export function evaluateTrigger(ctx: TriggerContext): TriggerDecision {
  if (ctx.policy === 'anyone') {
    return {
      allowed: true,
      reason:
        '触发策略为 anyone:未限制触发者,任何人都可触发本次运行。' +
        '提醒:外部用户可借此消耗本仓库的模型额度,建议改用 trusted 并配置 allowed_actors。',
    };
  }

  const actor = (ctx.actor ?? '').trim();
  const actorLabel = actor === '' ? '未知触发者' : actor;
  const association = (ctx.authorAssociation ?? '').trim().toUpperCase();
  const associationLabel = association === '' ? 'NONE(未知)' : association;

  if (isAllowedActor(actor, ctx.allowedActors)) {
    return {
      allowed: true,
      reason: `触发者 ${actorLabel} 命中 allowed_actors 白名单,准入通过。`,
    };
  }

  if (TRUSTED_ASSOCIATIONS.includes(association)) {
    return {
      allowed: true,
      reason: `触发者 ${actorLabel} 的权限等级为 ${associationLabel},属于信任名单(OWNER/MEMBER/COLLABORATOR),准入通过。`,
    };
  }

  return {
    allowed: false,
    reason:
      `触发者 ${actorLabel} 的权限等级为 ${associationLabel},不在信任名单内` +
      '(仅仓库 OWNER/MEMBER/COLLABORATOR 或 allowed_actors 白名单命中者可触发)。' +
      '本次运行已跳过,未读取 Issue、未调用模型、不消耗额度。',
  };
}
