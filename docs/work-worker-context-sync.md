# 配置自己的 Router / Worker 上下文

三层资料分别是 `superagent-context.md` 的共同约定、`project-map.md` 的 Router 索引、`work-worker-context.md` 的 Worker 工程资料模板。兼容文件名中的 work 表示项目工作，不绑定私人产品。

先更新自己的项目地图与工程资料，再配置对应 Sources、Policy、执行目录、模型和授权。脚本只整理提示词，不安装工具或创建第二个项目执行器。

GitLab 示例仅预览：

```sh
node --experimental-strip-types scripts/sync-work-worker-context.ts --source gitlab --host gitlab.com --repository example/widgets
```

GitHub 改用 `--source github --repository owner/repo`。非默认端口使用 `--url http://127.0.0.1:端口`；仅接受本机 loopback 地址。

预览核对实际仓库/主机身份，并生成 `.artifacts/work-worker-context-candidate.json`。审阅后给同一命令增加 `--apply`，通过版本化 API 保存并读回验证；不唤醒 Worker、不发送 IM、不修改模型。新 Worker 首次请求和已有 Worker 下次请求使用当前配置。

`context-migration` 初始摘要对应本仓库的默认 team 文本。已改过共同约定时脚本会拒绝覆盖：必须先审阅并保留原授权、暂停和交付条件，再更新迁移基线，不能盲目替换哈希。后续只替换受管块，保留块外人工补充、无关覆盖和技能。

钉钉文档是可选副本。由资料所有者指定目标和可见范围后用自己的 DWS 身份维护；本仓库不含私有文档地址，也不会自动从云端下载指令。
