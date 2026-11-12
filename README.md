# ai-dev-workflow-action

把"AI 原生研发团队(队长 + 并行队员)"产品化:输入一个任务(Issue/描述文本),
流水线自动完成:

```
ingest 读取任务     →  plan 队长结构性规划
                    →  dispatch 并行队员在独立 git worktree 分头实现
                    →  synthesize 队长汇合产出、解冲突、合成提交
                    →  deliver 产出分支/PR + 结项报告
```

- 动作即验证:该仓库本身由"我(队长)+ 并行队员"的 AI 原生流程开发 —— 队员
  (subagent)在阶段 1 四路并行,各自职责与接口契约随阶段 0 提交,互不等待、
  互不通信。

## 结构

| 路径 | 说明 | 负责队员 |
| --- | --- | --- |
| `packages/core/src/contracts` | 全部共享类型/接口(队长所有) | 队长 |
| `packages/core/src/pipeline` | 流水线状态机、规划/调度/合成 | M1 |
| `packages/core/src/security` | 脱敏器 / 凭证扫描 / 不可信内容包装 | M1 |
| `packages/core/src/engine` | opencode + mock 引擎适配 | M2 |
| `packages/core/src/infra` | Git 操作、仓库快照构建 | M2 |
| `packages/cli` | 本地 CLI(`aiwf`) | M3 |
| `packages/action` | GitHub Action 壳 + 官方工作流 | M4 |

## 快速开始

```bash
pnpm install           # 同时构建 core
pnpm build && pnpm test
```

## 约定

- ESM + NodeNext:相对导入以 `.js` 结尾
- TypeScript strict;`vitest`;不抛异常表达成员级失败(TaskResult.status)
- 队员不得修改 `contracts/`、根配置与他人的责任区

## Action 用法

把 Issue 变成 PR:在任意仓库 `.github/workflows/aiwf.yml` 挂上本 action,新建 Issue
或评论中带 `@aiwf` 即自动开工 —— 队长规划(`plan.summary`)、并行队员在独立
worktree 分支实现、队长合成并创建/更新结项 PR(正文含诉求→方案→执行明细→变更
文件→风险→结论六段)。最小接入:

```yaml
name: aiwf
on:
  issues:
    types: [opened]        # 只在新建时开工;需求迭代用评论 @aiwf(编辑 Issue 也会跑一次团队,浪费额度)
  issue_comment:
    types: [created]
permissions:
  contents: write
  issues: write
  pull-requests: write
jobs:
  run-team:
    runs-on: ubuntu-latest
    if: >-
      github.event_name != 'issue_comment' ||
      (contains(github.event.comment.body, '@aiwf') && github.event.comment.user.type != 'Bot')
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - uses: pnpm/action-setup@v6
        with: { version: 10.28.2 }
      - uses: actions/setup-node@v7
        with: { node-version: '24', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: npm install -g opencode-ai
      - run: pnpm build
      - uses: AllenTango/aiwf@v1
        with:
          task_ref: ${{ github.repository }}#${{ github.event.issue.number }}
          trigger_policy: trusted          # 仅 OWNER/MEMBER/COLLABORATOR 或白名单者可触发
          allowed_actors: 'alice,bob'       # 额外的触发白名单(逗号分隔,忽略大小写)
          daily_run_limit: '20'             # 本仓库单日最多 20 次;0 = 不限制
          max_tasks: '6'                    # 编制人数上限;队长在此上限内自主编制
          budget: '24'                      # 相对成本预算(low=1/medium=3/high=8);0 = 不限
          models: |                         # 模型池:队长可为不同队员指派不同模型
            worker=opencode/glm-5.3
            reviewer=minimax/MiniMax-M3.1-Flash
          guidelines: |                     # 队员行为准则(每行一条)
            提交前必须跑 pnpm test
          approve: 'false'                  # true = 两段式:先出决策包,回 @aiwf go 才执行
        env:
          AIWF_MODEL: ${{ vars.AIWF_MODEL }}   # 可选:仓库 Variable,如 opencode/glm-5.3-free
          GITHUB_TOKEN: ${{ github.token }}
```

> 引用方式:发布到 Marketplace 后用 `uses: AllenTango/aiwf@v1`(本仓库真实 remote 为
> `github.com/AllenTango/aiwf.git`);同仓库 dogfood 时可改用 `uses: ./`。

常用 inputs:`task_ref`(必填,`owner/repo#123`)、`engine`(opencode/mock)、
`model`、`base_branch`、`branch_prefix`(默认 `aiwf/`)、`max_parallel`(默认 4)、
`dry_run`(只出规划不写码)、`trigger_policy`(默认 `trusted`)、`allowed_actors`、
`daily_run_limit`(默认 `0`,即不限制)、`max_tasks`(默认 `6`)、`timeout_ms`、
`models`(模型池)、`guidelines`(行为准则)、`budget`(成本预算)、`approve`(两段式审批)、
`idempotent`(幂等短路,默认开);
outputs:`pr-url` / `branch` / `summary`;PR 已存在时
自动复用更新。完整说明(权限、Secrets/Variables、示例 Issue 文案、定制与故障排查)
见 [docs/action.md](docs/action.md)。

## 队长的自主运营

人类只在仓库里**配置 + 引入**,之后由 AI 队长自主运营:

- **先分析,再决定开不开工** —— 队长输出 `proceed` / `reject` / `need_clarification`;
  后两者**一个队员都不派**,只在 Issue 上留下理由或待澄清问题。
- **成本核算后再编制** —— 队长看得见编制上限与成本预算,自己决定用几个队员、
  每个任务标什么权重;超预算时按**价值**裁剪(砍价值最低的,依赖闭合)。
- **不同队员用不同模型** —— 配 `models` 模型池,队长为每个任务指派模型。
- **队员施工前有行为准则** —— 内置默认 → 人类配置 → 队长按任务追加,三层叠加。
- **角色即权限** —— `reviewer` 类角色用只读 agent 且无写权限,只出结论不改代码。
- **判断有据可依** —— 快照带上需求相关文件与近期提交,不只是目录树。
- **可选两段式** —— `approve: true` 时队长只贴决策包,人回 `@aiwf go` 才执行(省一次队长调用)。
- **不重复烧额度** —— 内容没变(`idempotent`)直接跳过,不重复派员。

## 安全与额度

本 Action 会调用真实模型,因此**额度与密钥**是首要风险面。仓库内置七道防线:

1. **触发准入**:`trigger_policy: trusted`(默认)只放行 OWNER/MEMBER/COLLABORATOR
   或 `allowed_actors` 白名单 —— 外部用户开 Issue 无法消耗你的额度。
2. **每日配额**:`daily_run_limit` 限制单日运行次数(需 `actions: read` 权限)。
3. **规模上限**:`max_tasks` / `max_parallel` / `timeout_ms` + 墙钟预算,限制单次运行的
   模型调用次数与时长。
4. **环境隔离**:`GITHUB_TOKEN` 等平台凭证不会传进模型进程,成员 agent 拿不到。
5. **统一脱敏**:日志、PR 标题/正文/评论、成员总结全部过脱敏器(GitHub **不掩码** PR 正文)。
6. **产出物拦截**:`.env` / `*.pem` 等凭证文件整文件剔除;内容含密钥的文件就地脱敏后再提交。
7. **提示注入加固**:Issue 正文等不可信输入被 `<untrusted-content>` 边界包裹,并附安全红线。

完整威胁模型、接入清单与残留风险见 **[docs/security.md](docs/security.md)**。

## 运行时要求

本 Action 以 **node24** 运行:GitHub 已于 2026-06-16 起让 runner 默认以 Node24 执行
JavaScript Action,并于 2026-09-16 起彻底移除 Node20。因此消费方若自建 Action /
封装本 Action,`runs.using` 也应使用 `node24`,配套的构建 target 与 CI 的
`node-version` 同步为 24。
