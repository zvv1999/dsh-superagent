# Superagent 项目地图模板

使用前将示例替换为自己的仓库与资料入口。一个部署绑定一个仓库；地图条目不会创建执行器或转移账号、数据、发布权限。

```router-project-map
## Project index
- work / Example application: example/widgets on gitlab.com. This is an example, not an active deployment. Dispatch only after the generated host/repository matches the reviewed project record. Load dsh-superagent-work-project-tools, then the current worktree AGENTS.md, relevant ADRs and verification guide.
- superagent / dsh-superagent: orchestration host, message-source adapters and context configuration. Material: this checkout's README, docs/004-prompts.md and docs/superagent-context.md. This is a separate project; do not route its implementation into another repository's tickets without a matching configured executor.
- Other independent projects: verify the explicit project identity, reviewed material and configured executor before dispatch. Keywords and remembered paths only help discovery; never reuse another project's credentials, work directory, task history or release authority.
```

项目登记至少包含：稳定 project_id、职责、仓库与来源绑定、执行器的已验证/未配置状态、当前 AGENTS/文档/ADR/验收入口、授权和发布边界。只保存凭证的安全引用，不放凭证本体。

Router 常驻简短索引，Worker 按需读取详细工程资料。多个项目需要各自队列、账号或工作目录时，分别部署，再用明确来源绑定分流。设计边界见 [共同约定](superagent-context.md)。
