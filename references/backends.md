# 后端接入

源码支持以下可选配置。未配置的后端应直接提示未配置；启用 hybridEnabled 后可用 slash 路由。模型来源应以请求参数/响应元数据或原生会话记录为证，不能靠让模型自报身份。

| 指令 | 原生执行器 | 私有配置 |
|---|---|---|
| /codex | Codex app-server | codexBin、codexModel、codexReasoningEffort |
| /deepseek | DeepSeek Harness CLI | dsh.executable、entry、profile、可选 patch |
| /openclaw | OpenClaw agent CLI | openclaw.node、entry、agentId |
| /workbuddy | WorkBuddy 国际版原生 CLI | workbuddy.node、wrapper + international host |
| /workbuddycn | WorkBuddy 国内版原生 CLI | workbuddy.node、wrapper + domestic host |

## Codex / Harness / OpenClaw

Codex 当前用户登录由本机 CLI 管理。模型/推理强度支持性需要检查实际 CLI，不改桌面默认。Harness 使用自己的隔离 profile 和 session；第三方模型路由属于可选独立配置，模板不包含任何 WorkBuddy API 令牌或模型代理。若用户选择 WorkBuddy 国际版 deepseek-v4.1-flash 为 Harness 供模型，需另行合法绑定其本机登录、限制代理为127.0.0.1并加入本机随机 bearer，再验证原生 Harness 工具执行与响应模型。

OpenClaw 执行 `agent --agent <id> --session-key <独立key> --message <text> --json --timeout 600`。桥负责微信发送，原生调用不能加 --deliver 造成重复发送。输出兼容 result.payloads 文本和 mediaUrl/mediaUrls；媒体无文字也算有效结果。本地存在且扩展名受支持的图片才可转发，不自动下载远程 URL。

## WorkBuddy 两版

这是版本敏感的本机适配，不能称为跨版本官方稳定接口。模板 `workbuddy-native.mjs` 仅为自己的加载适配代码；读取本机合法安装的原生 CLI，保留原生工具和审批。不会把原生 app 源码放进分享包，也不修改已安装文件。

每版需要桌面端登录。私有 `.local-state/workbuddy-hosts.json` 的 international/domestic 字段各包含：entry（原生 CLI 文件）、product（本版产品配置缓存文件）、protectedKey（仅本用户能解的 DPAPI 配置）。**在加载原生模块之前设置 ACC_PRODUCT_CONFIG_PATH**，否则初始化会缓存错误版本身份，产生401。

曾验证格式：国际版5.7.6 `cli/dist/codebuddy-headless.js`，国内版5.8.2 `cli/dist/codebuddy-lite-wb.mjs`。根据当前安装发现路径，不照抄别人的用户路径。每版产品缓存位于对应用户数据目录 cache/acc-product-config-v3.json。WorkBuddy 更新后需重新验证入口格式。

两版还必须设置独立的 CODEBUDDY_CONFIG_DIR。默认共享 ~/.codebuddy/local_storage 会缓存上一次另一版的 authentication.id，仅设置产品环境变量仍可能串用账号。模板分别使用私有 workbuddy-native-international/domestic 目录，不复制桌面插件或跨版缓存。

凭证 bootstrap 应通过合法原生桌面提供的本机接口取得，在内存中配置原生 credential protection；如需本机持久化，用 Windows CurrentUser DPAPI，仅写私有目录。分享模板不携带 bootstrap 捕获器或任何已绑定密钥。若当前环境没有该合法接口，则提示此版原生接入尚未绑定，不绕过加密、登录或操作权限，不伪装已经支持。

先分别验证原生短回复，再验证 --session-id 和 --resume 的两轮恢复，再经微信测试。不得默认禁用审批；需要桌面交互的审批应明确反馈，不能当空回复成功。国内版默认模型与国际版默认模型分别由其自身设置决定；用户要求指定模型时使用经验证的原生模型参数。
