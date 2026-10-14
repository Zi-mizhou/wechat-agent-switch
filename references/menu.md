# 微信编号菜单

用户发 `/menu`，桥接返回已配置的 Agent 列表。回复当前页编号切换，然后显示该 Agent 的模型列表。选择只影响当前微信用户，各 Agent 会话和模型设置分别保留。

`/models` 或无参数 `/model` 直接打开当前 Agent 的模型菜单。`/model 模型ID` 选择列表中的精确 ID，`/model default` 恢复默认。Codex 的 `/effort` 显示所选模型在原生模型目录中声明支持的推理强度，也可以 `/effort xhigh`。参数不在目录中时不修改设置。

菜单每页8项，`n` 下一页、`p` 上一页，编号是整份列表的序号，只接受当前页编号。`0` 或菜单内的 `/cancel` 关闭，5分钟失效。无效编号只提示重选。普通任务文字会关闭菜单并作为任务执行；菜单关闭后，数字也是普通任务。菜单过期后的第一次编号回复只提示过期，不执行任务。进程重启会清除未完成菜单，因此不要在重启后继续回复旧编号；应重新发送 /menu。

图片和其他斜杠命令会关闭菜单。菜单内 `/cancel` 只关菜单；中止任务应明确发送 `/interrupt`。任务运行期间可以查看 /status，编号选择和设置修改会被拒绝，需任务结束后重新打开菜单。

## 支持范围

| Agent | 模型目录 | 应用方式 |
|---|---|---|
| Codex app-server | 原生 model/list | 下一次 thread/start、turn/start 显式携带模型及支持的 effort |
| WorkBuddy 国际/国内 | 对应安装的产品配置 models | 下一条原生 CLI 调用携带 --model；不会修改桌面模型下拉框 |
| OpenClaw | Gateway models.list | 通过 sessions.patch 修改桥接独立会话，需原生设备具备会话设置权限 |
| DeepSeek Harness | 此版不开放菜单改模型 | 沿用专用 profile/patch；固定代理不允许菜单绕过模型限制 |

OpenClaw 列出模型的读取权限不等于修改会话的权限。如果原生 Gateway 要求设备 scope upgrade/pairing，桥接提示去原生管理端审核，**不保存此次新选择、不自动批准设备权限**。没有权限时继续使用原有默认模型/已有选择，也可在原生管理端改模型。模板包含接口适配，但本机当前尚未验证获授权后的 OpenClaw 模型覆盖成功。

列表中的产品模型并不保证当前账号拥有额度或使用权。保存设置不等于完成模型调用。/status 的 configuredModel 显示声明选择，不能当成已核验的实际服务端模型，Auto/default 等别名也不是具体底层模型证明。任务失败不自动换其他计费模型。

模型选择在当前 Agent 会话内生效，不自动清空上下文；想要独立新上下文可 /new。WorkBuddy 返回默认时恢复此前记录的原生模型；首次直接指定模型而尚无基线记录时使用该版产品声明的默认模型作为恢复基线。

## 持久化与维护

私有 config.json 的 peerEngines 按 peer 保存 Agent；peerModels 按 peer→engine 保存 model/effort。旧 selectedEngine 只作为兼容初始默认，不再因单个用户切换而覆盖全局默认。routedSessions 保留各后端会话。不要把这些私有数据打包发布。

菜单测试位于桥接源码的 tests/menu.mjs，执行 `npm run test:menu`。验证本机原生模型目录与调用时仅打印脱敏结果，不打印认证文件。多人设置隔离不等于多租户安全：各后端仍可能共享本机账号、工作目录与工具权限，公开版本按单机本人使用定位。
