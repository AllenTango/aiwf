/**
 * @aiwf/action — 事件身份解析(纯函数,可单测)。
 * OWNER: 队长(集成期补齐)。
 *
 * 触发准入需要两个事实:
 *   1. **触发者是谁**(用于 `allowed_actors` 白名单匹配);
 *   2. **触发者的仓库权限等级**(用于 `trusted` 策略的 OWNER/MEMBER/COLLABORATOR 判定)。
 *
 * 两者都来自 GitHub 事件上下文,但**来源不同**且都可能缺失,必须分别兜底:
 *   - actor:优先 `github.context.actor`(Actions 一定会注入 `GITHUB_ACTOR`),
 *     缺失时回退事件 payload 的 `sender.login`;
 *   - association:评论事件取 `comment.author_association`,否则取 `issue.author_association`
 *     (GitHub 的 `author_association` 描述的是**作者**与仓库的关系,而不是评论者,
 *      因此 issue_comment 场景必须优先看 comment)。
 */

/** 事件 payload 中我们关心的最小形状(其余字段忽略)。 */
export interface EventIdentityPayload {
  sender?: { login?: unknown };
  issue?: { author_association?: unknown };
  comment?: { author_association?: unknown };
}

/**
 * 取触发者 login:优先 context.actor,缺失时回退 `sender.login`。
 *
 * 回退的意义:`allowed_actors` 白名单依赖 actor;若某些调用方式(如本地复现、
 * 自建 runner)没有注入 `GITHUB_ACTOR`,白名单就会永远匹配不上而形同虚设。
 */
export function resolveActor(contextActor: string | undefined, payload: unknown): string {
  if (typeof contextActor === 'string' && contextActor.trim() !== '') {
    return contextActor.trim();
  }
  const sender = (payload as EventIdentityPayload | undefined)?.sender?.login;
  return typeof sender === 'string' ? sender.trim() : '';
}

/**
 * 取触发者的仓库权限等级:评论优先(评论者),其次 Issue(Issue 作者)。
 *
 * 取不到时返回空串 —— 调用方(准入判定)会把它当作「不可信」处理,宁可误拒不可误放。
 */
export function resolveAuthorAssociation(payload: unknown): string {
  const shaped = payload as EventIdentityPayload | undefined;
  const fromComment = shaped?.comment?.author_association;
  if (typeof fromComment === 'string' && fromComment !== '') {
    return fromComment;
  }
  const fromIssue = shaped?.issue?.author_association;
  if (typeof fromIssue === 'string' && fromIssue !== '') {
    return fromIssue;
  }
  return '';
}
