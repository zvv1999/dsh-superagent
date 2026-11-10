# GitLab adapter in this local installation

This checkout extends the upstream research prototype with a GitLab Source. It supports one HTTPS GitLab project, including a self-hosted instance, through a configured `glab` CLI. GitHub deployments retain their existing behavior. Enable `dsh-superagent-gitlab` in the dedicated profile and configure the GitLab Source instead of GitHub.

## Account and project

The Source configuration names `hostname`, `repository` (`group/subgroup/project`) and an absolute `cli` path or command name. Setup checks the CLI's current user, resolves the project ID and requires Developer access or above. Use a separate account when team workflows need a distinct agent identity. A personal account can be used for explicit commands as described below; all API writes and commits are attributed to the configured account.

Credentials remain in the CLI's existing credential store. They are not Source configuration, execution variables, model context or diagnostic output. Worker Git credential handling is restricted to the configured HTTPS host. The runtime clears ambient GitHub/GitLab credential variables and uses its managed command shims and Git configuration.

## Requests

Post a new Issue, MR description or comment whose body begins with:

```text
/superagent <task>
```

Only accounts in the GitLab allowed list can originate work. The Source records new activity from its initial polling time, without dispatching historical comments. The default `observe` accept mode records inferred work without executing it; an explicit command by an allowed person remains actionable. The processing pause stops evaluation, dispatch and replies.

The Source ignores its delivery markers and system notes. When the configured CLI is the requesting person's account, only that account's explicit `/superagent` commands are received; ordinary self-authored comments are ignored to prevent response loops. Use another explicit command for follow-ups from that account.

Thread keys are distinct: `gitlab:issue:<iid>` and `gitlab:mr:<iid>`. MR IID and Issue IID are separate namespaces, even when their numbers are equal. A worker reports an MR using the existing `pr_number` tool parameter. Binding accepts its source MR or an agent-authored MR in the configured project whose source branch ends in the ticket's short name. Foreign projects, forks and unrelated branches cannot be claimed. Bound MRs keep their tickets waiting for review until their MR lifecycle and remaining work permit completion.

## Execution

Use a dedicated local clone for worker directories. A prepare command can fetch the default branch or `DSH_SUPERAGENT_GITLAB_MR_HEAD`, then create a Git worktree with a branch whose final path segment is `DSH_SUPERAGENT_NAME`. The configured execution directory and ticket names are supplied by the host; shell paths must be quoted.

The GitLab Source supplies non-secret variables for the host, project ID, repository, account, commit email, source IID and MR head ref. Its packaged skill describes project-scoped reads and the `glab` commands workers use. Team Delivery requirements should follow the target repository's rules. This deployment does not authorize auto-merge, review approval, force pushes or rewriting published history.

## Operations and verification

The dedicated `superagent` profile serves the local panel on port 3082. Use the authenticated page opened by DSH at startup; a bare URL without the browser's authentication cookie returns HTTP 401 by design. The service's existing `scripts/dsh-superagent status`, `start`, `stop` and `restart` commands continue to manage its own tmux session.

Verify readiness through the panel and `scripts/dsh-superagent status`: setup must have no problem and the GitLab health entry must be ready. Verify remote connectivity with reads of the configured project, issues, MRs and pipelines. Unit and integration tests exercise polling retries and cursors, command admission, reply idempotency, MR ownership and reporting, scoped API paths, account setup and credential handling. A real comment or MR creation is an external write and should only be part of an explicitly requested task.

The upstream runtime uses full access for its router and workers. That permission belongs to their own sessions; installing this Source does not change the permission mode of a separate TUI conversation.
