# IM sources in this local installation

This checkout uses the existing Source → Trigger → Policy → Ticket → DSH worker → Outbox pipeline. It does not create a second task system or require changes to the runtime dependency directory. The running profile is not changed by editing these sources; deploy the reviewed build and explicitly enable the desired plugin when ready.

| Platform | Source | Supported transport |
| --- | --- | --- |
| Personal Feishu history | Independent read-only connection | Direct user OAuth + application APIs; existing private/group chats, on demand |
| Personal DingTalk history | Independent read-only connection | Pinned official DWS CLI and personal OAuth; existing private/group chats, on demand |
| Feishu / Lark | `feishu`, existing `dsh-superagent/feishu-watch` | Existing bot-only `lark-cli`, direct messages and configured groups/topics |
| DingTalk | `dingtalk`, optional `dsh-superagent/im-watch` | Stream robot callbacks; text direct messages and selected groups; proactive robot text replies |
| Personal WeChat | `wechat`, optional `dsh-superagent/im-watch` | WeChat iLink bot text direct messages from a personal WeChat user |

Personal WeChat here means an iLink bot conversation in personal WeChat. It is not WeCom or a public account, and does not read the user's full inbox, contacts, existing friend conversations or groups. This first adapter does not download images, voice or files; unsupported messages are not dispatched. The DingTalk robot Source receives only what the platform delivers to the app; selecting “all” there does not grant group-history access. Personal DingTalk history uses the separate owner connection below.

## Enable and configure

Keep the existing GitLab or GitHub Source configured: it supplies the repository, execution environment and worker directory preparation. Keep the existing Policy and processing pause rules. The IM plugin has no worker or repository configuration of its own.

Enable `dsh-superagent-im` in the dedicated profile's Cordis patch when deploying, using the same patch syntax as the existing optional Feishu/GitLab entries. Both new Source cards then appear in Superagent settings. Each has its own enable switch, `accountId`, `credentialsFile`, direct-message switch and allowed-user Policy. Disable the Source you are not using. The plugin is disabled in the shipped bundle, and empty credentials never initiate a connection.

Source configuration contains only a path and non-secret identifiers. The panel's dedicated **Connect** credential form sends a newly entered Secret only to the local authorization service; it is cleared after submission, failure or cancellation and never uses settings drafts or browser storage. Do not paste secrets into ordinary source settings, conversation, environment, command-line arguments, repository or logs. Managed credentials use an owner-only directory and exclusive 0600 files on macOS/Linux; manual Windows installations must restrict files to the service user with filesystem ACLs. The host rejects readable-by-others files on POSIX and does not follow a credential-file symlink.

Example Source settings (through the panel or existing settings API, not by editing the live database):

```json
{
  "enabled": true,
  "config": {
    "accountId": "the-bot-account-id",
    "credentialsFile": "/absolute/private-directory/bot.json",
    "directMessages": true,
    "chats": []
  }
}
```

Feishu and DingTalk each have one compact platform card. Personal accounts, renewal status, subscribed people and named bot groups are visible in the summary. **Manage** opens personal authorization and read checks; **Intake and connection** expands the bot's connection flow, receive fields and advanced setup. Entered secrets clear when their editor closes as well as on submission. Opening or folding these controls does not save settings or change authorization. A settings link for a particular bot expands that bot automatically; unsaved edits survive folding, with their save bar still visible.

For bot setup, expand **Intake and connection**. The host prepares pinned native CLIs privately under `stateDir/managed-im`, then the panel shows the official authorization link and a locally rendered QR code. Complete platform consent, choose the intended app where offered, review the checks and select **Save and verify message reception**. Existing applications can also be connected through the private credential form. Automatic CLI preparation currently supports macOS/Linux arm64 and x64 and requires Node/npm; it does not install global commands or skills. Keep the advanced manual setup on other hosts.

After saving an enabled source with direct messages enabled, choose **Verify and allow me to start tasks**, copy the one-time command and send it in a private message to that robot. The panel grants the actual sender and confirms reception; no user ID lookup is needed. Pairing expires after five minutes and requires the original Source and Policy revisions. Pairing commands, including expired or invalid codes, are consumed before Engine intake and do not become tasks, stored conversation context or automatic replies. A successful receive check does not prove outbound-send permission; a real task/reply still needs its own account smoke test.

Changing only a bot's enable switch does not block connection setup: the connection review carries that intended enable state and saves it together with the verified connection. Unsaved receive fields, including changes inside a group row, still block connection actions until saved or discarded. Private pairing always uses the saved enable state and remains unavailable while that state has an unsaved change.

Switching to another bot resets only that source's allowed users and configured groups; reconnecting the same verified account preserves them. The final review commits the active Source and Policy together; an unfinished attempt keeps its CLI files in its own private directory. A Source or Policy change during authorization causes a conflict instead of an overwrite. Cancelling a local authorization does not delete an application that the operator already created on the platform.

Allowed users can still be managed under **Policy → the Source → allowed users**; the default list is empty. DingTalk uses the actual callback `senderStaffId`, or the platform sender ID when no staff ID is present. WeChat adds the confirmed scanning user's `from_user_id` during its own pairing. A display name or a CLI OAuth user ID alone grants no task authority. Existing inferred-admission settings still apply.

### Personal Feishu history without CLI

**Sources** shows each platform's personal connection, renewal/subscriptions, and bot intake separately. A disabled bot does not mean personal history is disconnected. Personal **Manage** opens the same connection dialog as Settings; **Intake and connection** opens that platform's bot settings. Arrival and filter counts continue to cover task Sources, independently of personal reads and subscriptions.

Open **Settings → Sources → Feishu → Personal messages (read only) → Manage**. Each IM platform has one card with separate personal-read and bot-intake sections. Credentials, identities, switches and task authority remain independent; personal controls are available even without a bot Source. Use an internal application owned by the intended Feishu account, publish the four **user identity** scopes `im:chat:read`, `im:message:readonly`, `im:message.p2p_msg:get_as_user` and `im:message.group_msg:get_as_user`, enable `offline_access` for renewal, and register the callback URL shown in the credential editor. **Connection details** contains the granted scopes and technical expiry timestamps; connected summaries show automatic renewal without presenting the two-hour access expiry as the login lifetime. Feishu currently requires the application's robot capability to be enabled and published even for these user reads (`232025` otherwise). Reads still use the owner's `user_access_token`, independently of bot Source enablement, pairing or CLI configuration. Applications shared externally or across associated organizations may be rejected by Feishu (`231204`).

Enter App ID and App Secret in this dedicated form, start authorization and open the official consent link. The callback uses a five-minute, single-use state and PKCE S256. The host exchanges the code directly at `https://open.feishu.cn/open-apis/authen/v2/oauth/token`, checks the exact five granted scopes, verifies user identity and probes one chat-list entry before saving. Feishu's current [authorization-code documentation](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code) explicitly pairs this authorization endpoint's PKCE flow with the v2 token endpoint; a live v3 exchange returned `20049` on November 9, 2026. There is no automatic fallback that removes PKCE. The card reports the actual user, access expiry and renewal status. **Verify chat reads** performs another bounded direct read; **Verify renewal now** exercises the same rotation path as the background scheduler. No send permissions are requested. The saved App Secret can be reused for the same application. Failed or cancelled replacement leaves the previous connection intact.

The access expiry comes from Feishu's actual `expires_in`; it is not the application's lifetime. The host schedules renewal before expiry even with the panel closed and refreshes on reads, including one retry after an early provider expiry. It uses the v2 endpoint with `grant_type=refresh_token` and the exact five-scope subset (omitting `scope` can return a wider historical grant), serializes rotation with replacement/disconnect, and atomically saves the rotated token with its actual `refresh_token_expires_in`. Rotation retains the same grant identity so cached text offsets continue to work; new consent or disconnect invalidates them. Restart resumes scheduling from private storage; shutdown cancels timers and requests. Expired or revoked refresh credentials require consent again. Some applications require the user-token refresh security setting; see the official [refresh documentation](https://open.feishu.cn/document/authentication-management/access-token/refresh-user-access-token).

Existing four-scope files keep their original access expiry. The panel labels them **Reauthorize with automatic renewal**; it never claims they already have offline access. A consumption marker is persisted before sending a refresh, preventing reuse after crashes, ambiguous transport failures or failed rotation saves. These cases require consent again while any still-valid access token remains usable. A failed pre-request private save sends no token request and is retried after 60 seconds. Only documented temporary OAuth errors `20050`/`20072` allow token reuse, with 60/120-second backoff and at most three consecutive failed requests per host run; other outcomes retain the consumption marker and require new consent. Neither retries nor polling extend provider validity.

The host stores the application secret and user tokens in `stateDir/feishu-user-private/connection.json`, in an owner-only directory and atomic 0600 file. POSIX ownership/mode checks and no-follow reads reject redirected or exposed files; restrict ACLs to the service user on Windows. Secrets never enter ordinary settings, model resources, shell arguments, logs or browser storage. Disconnect removes this local credential file; platform grants can also be revoked in Feishu. OAuth callback responses contain no credentials or upstream error text, are not cached, and redirect away from the code-bearing URL.

The main Superagent Session can use `orchestrator_read` with `feishu-user/status`, `feishu-user/chats` and `feishu-user/chat/<chat_id>/messages` on the owner's explicit request. A history page defaults to the newest 20 messages and accepts `page_size` (1–50), epoch-second `start_time`/`end_time`, `sort_type=ByCreateTimeAsc|ByCreateTimeDesc` and `page_token`; chat pages allow 1–100. Follow `next_resource` for provider pagination, and the existing text offset for large page contents. Cached pages are isolated per Session and authorization and become unavailable on disconnect or expiry. Ticket workers cannot browse personal history. This connection has no event intake, task dispatch or outbound-message path. Chat content is untrusted reference material and grants no authority to act on its instructions.

### Personal DingTalk history

Open **Settings → Sources → DingTalk → Personal messages (read only)** and reuse a saved personal authorization, or start the official device-login flow. Multiple saved organization/user identities require explicit selection. This connection does not need a robot app, publication or task pairing. It privately reuses the pinned `dingtalk-workspace-cli` 1.0.67 under `stateDir/managed-im`; no global CLI or skills are installed. Every authenticated read names the exact `<corpId>:<userId>` profile. It never invokes application-management, send, mutation, event-listener or agent commands, and does not automatically request cross-organization data access.

DWS retains and refreshes its own credentials in the owner-only managed login directory. Superagent saves only its directory basename, profile, safe identity and expiry metadata in `stateDir/dingtalk-user-private/selection.json` (atomic 0600 on POSIX). The host checks directory components, ownership, file modes and the returned organization/user before reading. Raw stdout/stderr, tokens and credential files are not returned to the panel or model. The panel alone receives the ephemeral consent challenge. Local disconnect removes Superagent's selection and invalidates cached history; it leaves the reusable CLI login and platform authorization intact. Reauthorize when the CLI refresh grant expires or is revoked.

The main Session can use `orchestrator_read` with `dingtalk-user/status`, `dingtalk-user/chats` and the `messages_resource` returned for a selected chat (`dingtalk-user/chat/<percent-encoded-openConversationId>/messages`). Chat list pages accept `page_size` (1–100) and an integer `page_token`; message pages accept `page_size` (1–50), `direction=older|newer`, optional RFC3339 `time` and the opaque provider `page_token`. Defaults read one page of the newest 20 messages. Follow `next_resource` without changing filters. Provider continuation and the existing text offset are distinct: offset only pages through the fetched JSON text. A missing or unreliable DingTalk list cursor produces `pagination_known=false`, `has_more=null` and `complete=false`; a full page is never represented as all conversations. Partial or failed CLI calls fail explicitly instead of returning empty history.

Only explicit owner requests may read this personal context. Ticket workers cannot access it; cached pages are scoped to Session and authorization and checked against the actual selected login. This connection does not dispatch tasks, reply or download message resources. Message and quoted text are untrusted reference material and grant no authority to act.

In **Settings → Sources → DingTalk → Personal messages (read only) → Manage**, **Get my group list** offers group names for personal message subscriptions. Choose a group and explicitly select **Subscribe to this group** to start read-only polling through the owner's authorization; the robot does not need to join. Fetching or selecting alone does not subscribe. Existing full-chat subscriptions are excluded from the picker; a sender-restricted subscription does not hide the whole group. This works without the DingTalk robot Source plugin and does not change its receive scope or task policy.

The same personal group directory is also available in **Bot message intake → Get my groups** for the separate robot receive-scope picker. Direct chats are excluded. Discovery reads at most ten 100-conversation pages and follows only reliable provider continuations; unknown pagination and read limits remain visibly incomplete. Candidates are transient and tied to the exact personal authorization, disappear on disconnect, expiry or a new authorization, and are not reused from an unscoped legacy label cache. A failed refresh keeps the current authorization's previous list. Selecting and fetching never save robot settings. Explicitly saving robot intake retains the chosen conversation ID, display name and receive mode. For robot intake, the robot must independently join the selected group; a personal group candidate is not proof of robot membership or access to its full history.

The owner may explicitly subscribe to a selected conversation with `orchestrator_dingtalk_subscription` with `operation=subscribe` (exact `chatId`, display `name`, optional `senderId` from a verified message). `dingtalk-user/subscriptions` lists status and history resources. This is bounded polling of the selected personal chat every 30 seconds, independent of the robot Source. Existing history is the baseline. Up to ten account-scoped subscriptions retain only identity, message IDs, counts, provider continuation and history-gap metadata in SQLite, never message bodies or credentials. A check reads at most three 50-message pages; longer catch-ups checkpoint and resume after restart. Unknown pagination, foreign identities/conversations and lost history anchors are surfaced explicitly. Disconnect or unavailable authorization suspends reads.

An unresolved history gap is retained as `historyGapAt`, separately from temporary read errors and the current subscription status. Successful checks, new messages and restarts preserve the warning: receiving new messages does not prove that older history was recovered. Legacy `error=history_gap` records retain their last-check time as this metadata. The first observed gap remains for the lifetime of that subscription; cancelling and explicitly subscribing again creates a new baseline, without claiming to recover the old gap.

Each checkpoint and its coalescing context notice commit in one database transaction. The existing durable notice queue injects the update into the main Session without waking it. The notice contains IDs, cumulative count and a history resource; fetching text still uses the personal read gate. It does not create Tickets or authorize outgoing messages. **Settings → Sources** displays the subscriptions, latest check and counts, with **Check subscription now** and **Cancel message subscription**. The main Session can also use `orchestrator_dingtalk_subscription` with `operation=unsubscribe`. Cancellation invalidates pending reads. Management uses the existing same-origin, custom-header-gated `/connections/dingtalk-user/subscriptions` routes.

### Feishu bot task Source

Use the existing Feishu Source and the bot-only `lark-cli` setup in [006 Deployment](006-deployment.md). Enable `dsh-superagent-feishu`, configure its CLI, allowed users and received groups/direct messages. The new plugin does not replace this transport or alter its history/topic handling.

The panel uses the official [`@larksuite/cli` 1.0.99](https://github.com/larksuite/cli/tree/v1.0.99) native binary and `config init --new --brand feishu --lang zh_cn`. It captures only the trusted `open.feishu.cn/page/cli` verification URL, waits for the same process to finish, then configures `strict-mode bot` and `default-as bot`. The operator creates the app through Feishu's own page. This flow needs no personal `auth login` or user token.

The official command saves the app before its final token probe, so a nonzero exit can mean registration succeeded but bot access was denied. The host recovers a private single-app configuration whose credential reference is either the matching app's keychain entry or the attempt's own private `app-secret` file, then independently verifies the bot. File references must point exactly inside that attempt; missing, empty, oversized, linked or publicly readable files are rejected without reading their contents. After a failed attempt or a service restart, **Continue previous authorization** lists safely saved applications for explicit selection; it never registers another app, reads a secret into the panel or enables the source automatically. Feishu error **21001** is reported as a platform data-security-policy denial. Check the platform's data security settings and, when needed, contact the enterprise administrator or Feishu support, then use **Check again**. Saving remains disabled while verification is blocked; changing login methods does not resolve a policy denial.

Existing-app Secrets are first verified directly against the official token endpoint, then stored as an exclusive private file referenced by the CLI configuration. This avoids overwriting the macOS keychain entry that another CLI configuration may share for the same app ID. Every attempt has a separate `LARKSUITE_CLI_CONFIG_DIR`; the worker wrapper passes only an environment whitelist and the selected bot configuration. The panel verifies bot identity and reads published tenant scopes and the receive event when the platform permits it. Unknown, missing and verified permissions are displayed separately; a known missing check blocks saving until rechecking succeeds. Unavailable metadata is not evidence of working receive/send permissions. App creation alone does not guarantee publication or all message permissions. The existing transport still consumes `event consume im.message.receive_v1 --as bot` and sends replies through the bot wrapper.

Feishu connection directories use the short private layout `stateDir/f/<16 hex characters>` because the CLI creates `events/<appId>/bus.sock` inside its configuration directory. The complete socket path must fit in 103 UTF-8 bytes for macOS/Linux compatibility. An oversized data root fails explicitly before authorization. Recovery discovers both this layout and legacy `managed-im/connections/feishu-<UUID>` directories. On confirmation, an oversized legacy connection is copied into a short directory: only the verified single bot app and its exact private credential reference are retained. File credentials are copied as 0600 after owner, link and size checks; keychain references remain unchanged. Personal logins and token caches are not copied, and the original directory remains intact. Reconnect existing legacy sources through **Continue previous authorization** to apply this migration; save/identity checks still require a real private-message receive and reply test.

Choose received groups in **Settings → Sources → Feishu → Intake and connection → Chats**: refresh the bot's joined groups, add a row, select the group by name, choose mentions/all and save. The list belongs to the current bot, rather than the personal OAuth connection. When it is empty, the panel explains how to add superagent to a target group and keeps the group selector instead of falling back to a raw ID field. The CLI's successful `chats: null` response represents an empty joined list; malformed or incomplete reads preserve the previous list. Refreshing or selecting a draft group does not enable group reception until saved.

### DingTalk

The panel privately installs [`dingtalk-workspace-cli` 1.0.67](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/tree/v1.0.67) with skills disabled. It runs `auth login --device --no-browser --format json --yes` in a separate `DWS_CONFIG_DIR`, presents the trusted device link/code and waits for confirmation. The final authenticated organization/user fixes the `--profile <corpId:userId>` on every app operation. The operator chooses the robot application; the host checks its ID and any returned credential aliases before verifying its robot secret with the official token API.

If the platform does not return a secret, the panel asks only for the missing bot credentials. If the account lacks CLI application-management access altogether, choose **Connect an existing app** and enter the robot Client ID and Secret; this route verifies only the explicit bot credentials and does not claim a personal OAuth identity or an app-management lookup. Native credential-command JSON is captured privately and never displayed or logged. Optional terminal-only installation remains available:

```sh
DWS_NO_SKILLS=1 npm install -g dingtalk-workspace-cli@1.0.67
dws auth login --device
```

For multiple organizations, use an explicit `--profile <corpId:userId>` for every account operation. `dws` can select/create robot apps and manage their permissions and release; an app creation result alone is not publication. This Source continues to use the robot's Stream/REST transport. Do not run `dws dev connect` for the same bot alongside it: that command starts its own agent and replies, and competing Stream consumers divide callbacks. Personal OAuth credentials and the global `~/.dws/app.json` are not robot credentials. Automatic export through `dev app credentials get` is not assumed: the CLI's v1.0.67 source marks its returned secret fields as unverified, and secrets may only be returned at creation. Keep the explicit private robot credential file below; do not display credential-command JSON in model logs.

Create an internal DingTalk application with a robot and enable Stream mode for robot messages. Give the app permission to send robot messages to the intended users/groups; publish/install the app and add the robot to the selected groups. No public callback listener is opened by this plugin.

Set `accountId` to the application Client ID. Its private credential file is:

```json
{
  "clientId": "the-application-client-id",
  "clientSecret": "the-application-secret",
  "robotCode": "the-robot-code"
}
```

`robotCode` can be omitted when it equals the Client ID. Add group `conversationId` values to `chats`, with `listen: "mentions"` or `"all"`. Unknown groups are filtered. Group messages addressed with `@` or `/superagent` can make an explicit request from an allowed user; direct messages do not need a prefix.

The **Sources** status page separates the bot connection from its current receiving scope: it lists configured groups, receive modes and direct-message settings, with a link to manage that scope. Joining a group alone does not add it to the configured scope. “All delivered messages” still means only messages DingTalk actually delivers to the robot. The last-24-hour filter history retains the original arrival-time reason and shows whether the conversation is in scope now. Adding a group does not replay old filtered messages or remove them from the historical count. Group names come from the matching account's configuration; sender names and message previews are displayed separately. The settings form also displays each configured group's name, with the original ID available on hover; saving receive-mode changes preserves that ID.

The adapter opens an authenticated Stream connection, responds to platform heartbeats and reconnects after failure. Its `ws` transport sends a WebSocket control-frame ping every 20 seconds and waits up to 10 seconds for a pong; missing application messages alone never count as a dead connection. A failed probe terminates the old socket before reconnecting. Handshakes are bounded to 15 seconds, redirects and compression are disabled, and incoming payloads are capped at 2 MiB. It acknowledges a callback only after the host has durably received it. Replies use the original user/conversation IDs with robot APIs, avoiding expiring `sessionWebhook` URLs. The callback URL and app secret are never saved in Trigger metadata. Platform permission or recipient failures remain visible as delivery failures.

### Personal WeChat

Open **Settings → Sources → Personal WeChat** and choose **Connect WeChat**. Scan the QR code with WeChat and confirm on your phone. The panel handles verification codes, expiry, cancellation and page refresh. It renders the QR locally; it does not send the login URL to an image service. After confirmation, the host writes a new private credential file, saves the bot account and adds the scanning user to the allowed list in one settings transaction. No account ID or credential path needs to be copied. The **Receive tasks after connecting** switch controls whether binding also enables the Source.

An existing account stays unchanged until confirmation succeeds. Reconnecting the same account preserves its allowed users; switching to a different account requires the replacement confirmation and resets that Source's allowed users to the scanning person. Changes to Source or Policy settings during a scan cause a conflict instead of overwriting them. Missing scanner identity, cancellation or expiry never enable the Source. Manual account fields remain under **Advanced**.

The CLI helper remains available for terminal-only operation after deploying a build containing `lib/wechat-login.js`:

```sh
node scripts/wechat-login.mjs /absolute/private-directory/wechat.json
```

Scan/confirm the one-time link in WeChat. If the optional `qrcode-terminal` package is available, the helper also renders a QR code locally; otherwise it prints the same login link. For terminal QR rendering it can be installed separately with `corepack pnpm add --save-dev qrcode-terminal@0.12.0`. The helper handles a verification code when requested, writes the token privately, and prints only the bot `accountId` and the requesting user's Policy ID. It never prints the saved token. Existing files require `--replace` to reauthenticate. Do not run this helper through a model-facing shell or save its transient login link in a shared log.

Set the WeChat Source's `accountId` to the returned bot ID and `credentialsFile` to that file. A dedicated credential file produced by another iLink client can also be used with this shape:

```json
{
  "botId": "the-ilink-bot-id",
  "token": "the-bot-token",
  "baseUrl": "https://ilinkai.weixin.qq.com"
}
```

`botId` is checked when present. Use only one receiving process per bot account: do not simultaneously poll the same account with another client. The host keeps the long-poll cursor and bounded per-user reply context tokens in `stateDir/im-private`, in owner-only files; they are not in Tickets, prompts, source settings or logs. A cursor advances only after every supported message in the batch is durable. Keep this private directory with the deployment's private backups.

If the session expires (for example provider error `-14`), reauthenticate that bot explicitly. If its reply context is missing, send the bot a fresh message before retrying delivery. Changing `accountId` isolates all old threads, cursors and replies; old-account queued messages cannot go to the new account.

## Requests, Issue association and replies

An allowed sender can write:

```text
/superagent 请处理 #123 的登录问题，完成修改和测试，先在本地交付。
```

`/superagent` starts a new request thread. Subsequent text from the same sender in the same conversation follows their most recent request. A supported quoted reply follows the referenced request instead. Another person's message or another conversation does not implicitly join that thread. `#123` denotes the configured repository's Issue; `!123` denotes a GitLab MR. Full Issue/MR URLs must match the configured project, so another project's IID or a URL fragment cannot select local work accidentally.

The existing router receives referenced Tickets and chooses to attach to one or accept a new internal Ticket. Mentioning an Issue does not automatically create an external Issue. Existing repository/worker rules still decide any external write, commit, push or MR creation. A worker's acknowledgement and an answer to an attached IM question return to that question's conversation; after reporting `reply_to_trigger_id`, the router sends `purpose: answer` with the original `trigger_id`. A new IM Ticket's result returns to the conversation where it started. Internal progress is not spammed into IM.

Processing pause still prevents evaluation, dispatch and replies while preserving incoming messages. Turning a Source/chat off stops receiving from that scope and prevents queued replies there. The first activation records its start time and does not dispatch older backlog. Duplicate callbacks and WeChat page replays share stable account-scoped Trigger IDs. The latest 100 received messages per request are retained as assessment context; native full-history reads and attachments are not implemented for the two new Sources.

IM replies retain the existing 100-word limit and an additional 18,000-byte transport bound. Successful outgoing IDs are retained locally. A definite provider rejection can retry; a timeout, lost confirmation or crash after starting delivery leaves an **unknown delivery outcome** that is not automatically sent again. This avoids duplicate external messages but requires operator investigation of that pending receipt; there is currently no “force retry unknown receipt” UI. Restoring an older database can also lose receipt history, so check pending deliveries before resuming a restored installation.

## Validation and rollout

Use `pnpm typecheck`, `pnpm test` and `pnpm build` for a stopped/development checkout. If the current checkout supplies a live profile, build with `pnpm exec tsdown --out-dir /absolute/temporary/build-directory` so its active `lib` is not overwritten. Package, profile activation and service restart are a separate deployment step.

Automated tests cover sender admission, pause, Ticket/worker flow, duplicate delivery, original and attached conversation replies, project-scoped Issue links, Stream acknowledgments, credential redaction and WeChat cursor recovery. They use fake provider transports and isolated temporary stores, plus a real loopback WebSocket test for idle ping/pong survival. Subscription tests retain gap warnings across later successful checks, temporary failures, restarts and legacy records; panel tests show the warning alongside a healthy current subscription. An actual account still needs a real receive → accepted Ticket → worker → reply smoke test after the operator enables it. No real IM messages are sent by these tests.

Protocol references used for this adapter are the DingTalk-maintained `open-dingtalk/dingtalk-stream-sdk-nodejs` Stream callback protocol, DingTalk robot `groupMessages/send` and `oToMessages/batchSend` APIs, and the published `@tencent-weixin/openclaw-weixin` 2.4.10 iLink JSON protocol. The adapter uses Node's fetch API and `ws` for the DingTalk control-frame heartbeat; it does not load another agent's runtime or copy its task system.
