# 中文上手指南

本版有本机管理面板、GitHub/GitLab 工单，以及飞书、钉钉、微信接入。本人钉钉订阅默认每 30 秒补充只读上下文；也可对指定订阅开启任务处理，按规则进入 Router → Ticket → Worker，不向订阅群自动回复。

## 安装

推荐 macOS/Linux，Node.js **24.9.0+**、Git、Python 3、tmux。GitHub 项目准备 gh，GitLab 项目准备 glab。Windows 未实机验收，可先在 WSL 按 Linux 流程安装；控制脚本依赖 tmux。

```sh
npm install -g @deepseek-ai/dsh@0.2.2-rc.1 pnpm@11.7.0
git clone https://github.com/zvv1999/dsh-superagent.git
cd dsh-superagent
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 执行类型检查、测试和构建。源码不依赖原部署的电脑或内部服务。

以下 profile 创建命令**仅用于 `~/.dsh/profiles/superagent` 尚不存在的新安装**。已有同名 profile 时保留原配置并按 [升级指南](006-deployment.md#upgrade) 操作，或另选 profile 名。重新创建会覆盖旧配置。

```sh
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

将 [profile 示例](../examples/profile.cordis.patch.yml) 复制到 `~/.dsh/profiles/superagent/cordis.patch.yml`，把 `stateDir` 占位符改成自己的绝对路径，例如 `/home/me/.dsh/state/superagent`。按需取消注释 Feishu、GitLab、IM 插件；IM 提供钉钉机器人和个人微信。插件可用和账号授权是两件事。GitLab 部署需要关闭 GitHub 来源，并配置自己的 GitLab 项目和 CLI。

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

打开 `http://127.0.0.1:3082/`，点击左侧 **Superagent**。首次显示待配置提示属于正常状态，完成下面的项目和模型配置后再验收。

## 模型和项目

在 DeepSeek Harness 中配置自己的模型供应商和凭证，然后在 Superagent 的评估、执行设置中选择实际可用的模型。原部署使用 Sol，但本仓库不附带 Sol 服务、额度或私人模型网关；选自己的供应商支持的模型即可。密钥只填入供应商配置，不放入提示词或 Git。

在 **设置 → 来源** 选择一个 GitHub/GitLab 项目和登录正确账号的 CLI，建议专用 Agent 账号。在 Policy 里添加可发起任务的人；执行设置里填写自己的项目 clone、工单目录和 prepare 命令。初期保留 observe 模式，最多 3 个 Worker。详见 [部署](006-deployment.md)、[GitLab](gitlab.md)。

## 消息连接

| 能力 | 设置入口 | 需要自己配置 |
| --- | --- | --- |
| 本人飞书已有私聊/群聊只读 | 飞书 → 本人消息 → 管理 | 自己应用和本人 OAuth 只读授权；无需机器人 |
| 飞书机器人接单/回复 | 飞书 → 机器人接收与连接 | 机器人能力、权限和发布；选择机器人可访问的群 |
| 本人钉钉会话读取/订阅 | 钉钉 → 本人消息 → 管理 | 自己的钉钉授权；获取群列表后明确点击订阅，无需添加机器人 |
| 钉钉机器人接单/回复 | 钉钉 → 机器人接收与连接 | 自己的机器人、Stream 配置；机器人进群与接收范围都需配置 |
| 微信机器人私聊 | 个人微信 → 扫码连接 | 在手机确认本人的绑定 |

面板按需准备固定版本的官方 CLI。本人消息读取与机器人任务来源独立，机器人列表里的群不会自动变成本人订阅。权限、续期、分页及平台限制见 [消息连接](im.md)。

订阅钉钉群消息的完整路径：

1. 打开 **设置 → 来源 → 钉钉 → 本人消息（只读）→ 管理**，完成本人授权。
2. 在 **订阅我的群消息** 中点击 **获取我的群列表**，选择目标群，再点击 **订阅这个群**。
3. 回到 **本人消息订阅** 查看状态、最近检查时间和新增消息数；需要马上验证时点击 **立即检查订阅**。

本人订阅可以读取钉钉向本人授权返回的人工消息和机器人消息，适合读取告警机器人发布的群消息，无需把 Superagent 机器人加入群。机器人接收通道会忽略自身及其他机器人发出的消息；要接收人发给 Superagent 的任务，使用机器人接单与回复。

订阅每 30 秒检查一次，默认“仅上下文”，不会启动 Worker。若通过工具设置了发送者限制，只有该发送者的新消息计入订阅。

需要处理告警时，在同一个“管理”窗口中，对指定订阅点击 **开启任务处理**，再在 **设置 → 评估 → 评估设置 → 接单模式** 中选择模式并保存：

- **关闭**：不研判这些观察消息。
- **仅观察**：记录研判结果，不派 Worker。
- **自动接单**：只有符合已启用规则的消息才会创建工单和 Worker；请先配置范围明确的告警诊断规则。

开启任务处理时会建立新的历史基线，不会批量重放旧告警。需要验证时点击 **研判最近一条**，再点 **查看处理链路** 查看 Trigger、研判结果、工单及 Worker。卡片同时显示“已送研判”数量和全局接单模式；收到消息不等于已接单。重复提交同一条不会重复派工。此通道没有群回复能力；取消订阅、断开授权或改回“仅上下文”会撤销对应任务范围。

## 验证

先检查 status、来源和配置无缺项，自己的模型可用。本人消息点“验证会话读取”；钉钉订阅核对名称、状态和检查时间。订阅开始前的历史作为基线，不计入新增数量；新增为 0 不代表没有历史消息。

由你本人先在私聊测试机器人，再提交一个范围很小的任务，确认工单出现、Worker 使用正确仓库和模型、结果回到原会话。自动测试使用隔离传输，不会替你给真人发测试消息。

上下文分层见 [共同约定](superagent-context.md)、[项目地图](project-map.md) 和 [上下文配置](work-worker-context-sync.md)。Router 常驻精简索引，Worker 按需加载项目资料。地图增加条目不会自动支持跨项目执行。

升级前停服并备份自己的状态目录；不要公开数据库、账号授权、聊天记录、.env 或 .artifacts。
