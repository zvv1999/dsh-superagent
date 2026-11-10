# dsh-superagent

这是基于上游研究原型维护的个人定制版，不是 DeepSeek 官方发行版。**新用户先看 [中文上手指南](docs/quickstart.zh-CN.md)**。功能、代码来源与公开范围见 [UPSTREAM.md](UPSTREAM.md)。每位使用者配置自己的模型、项目和消息平台授权。

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Local GitLab support

This installation adds a GitLab Source for one project, including projects on self-hosted GitLab. It uses `glab`, explicit `/superagent` requests, project-scoped API reads and MR lifecycle tracking. Setup and operating details are in [GitLab adapter](docs/gitlab.md).

## Local IM sources

Feishu keeps its existing Source. The optional IM plugin adds DingTalk Stream robot messages and personal WeChat iLink text DMs, using the same Policy, Ticket, worker and original-conversation reply flow. Account setup, supported message types and operational limits are in [IM sources](docs/im.md).

An independent **Personal Feishu messages (read only)** connection uses direct application APIs and the owner's OAuth grant to read existing private and group history on request, without CLI, automatic task intake or replies. Connect it in **Settings → Sources**; its four scopes, expiry and resource paths are described in [Personal Feishu history](docs/im.md#personal-feishu-history-without-cli).

**Personal DingTalk messages (read only)** reuses a private personal DWS login, fixed to the selected organization and owner. The main Superagent Session can read existing private/group history on request. Connect it in **Settings → Sources**; [Personal DingTalk history](docs/im.md#personal-dingtalk-history) covers account selection, refresh, pagination and local disconnect. It is independent of robot Sources and task permissions.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Personal DingTalk reads also support owner-selected conversation subscriptions: every 30 seconds, with restart recovery, sender filtering and cancellable read-only context notices. See [IM connections](docs/im.md#personal-dingtalk-history).

An explicit local-owner task can be submitted to `POST /orchestrator/api/requests` through the same-origin management API. It creates an idempotent local request for the existing Router → Ticket → Worker flow. Personal-message subscriptions remain context only; local requests have no external reply channel. See [Authorization](docs/002-authorization.md#explicit-local-owner-requests).

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

Reviewed deployment context is maintained in [shared agreements and Router/Worker roles](docs/superagent-context.md), the [project map](docs/project-map.md), and the [Work execution guide](docs/work-worker-context.md). The [synchronization record](docs/work-worker-context-sync.md) tracks the saved configuration and DingTalk copies; documents do not grant execution permissions.

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
