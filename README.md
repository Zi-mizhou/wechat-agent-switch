# 微信多 Agent 切换（Alpha）

用微信控制自己电脑上的 Codex、DeepSeek Harness、OpenClaw、WorkBuddy 国际版和国内版，并保留各 Agent 的会话。手机正常使用微信，电脑负责运行任务。

本项目由后台桥接程序和帮助 Codex 部署、排障的 skill 组成。它不是微信原生插件；目前提供的是微信文字编号菜单，尚未打包成 OpenClaw 管理页面插件。

## 安装 skill

需要 Windows、Node.js 22+、npm 和已登录的 Codex CLI。下载仓库 ZIP 并解压，将解压目录改名为 `wechat-agent-switch`，放进 `%USERPROFILE%/.codex/skills/`，确认里面直接包含 SKILL.md。也可下载 Release 中已按该名称打包的 skill ZIP。重新打开 Codex，发送：

```text
使用 $wechat-agent-switch，帮我部署微信连接本机 Agent。
先接 Codex，工作目录使用 D:\AI工作，保留我的模型设置。
完成扫码、本人授权、登录自启和实际微信收发验证。
```

按 Codex 提示扫码。安装 skill 本身不会自动连接微信。首次建议先接 Codex，验证后再接其他 Agent。安装脚本只初始化基础桥接；微信登录、本人白名单、自启和可选后端还需部署。WorkBuddy 本机认证绑定依赖版本，当前不是跨电脑的一键安装。

不需要安装所有 Agent。可以一次对 Codex 说“检查我已安装的 Agent，让我选择要接哪些；没安装的跳过，逐个配置并验证”。当前由 Codex 按指引完成，并非脚本已实现完整自动检测向导。菜单按已启用的桥接配置显示：未配置的 WorkBuddy 不显示；卸载后残留的旧配置需要清理。skill 不会替使用者下载其他 Agent 或提供其账号。

## 微信怎么用

部署完成后，在**微信机器人聊天框**输入下面这一条英文命令并发送：

```text
/menu
```

当前只支持 `/menu`，不支持 `/菜单`。“菜单”是功能名称，不是需要输入的中文命令。上面的 `$wechat-agent-switch` 安装提示词发给电脑上的 Codex；这里的 `/menu` 发给微信机器人。

发送 `/menu` → 回复 Agent 编号 → 回复模型编号 → 发送任务。

仅显示已经配置的 Agent；模型列表来自对应原生接口或本机产品配置，并受账号权限和额度限制。超过一页时发 n/p 翻页，0 关闭菜单。只在打开菜单时编号有选择含义。菜单5分钟有效，进程重启后需重新打开。

| 指令 | 功能 |
|---|---|
| /menu | 编号选择 Agent，再选择模型 |
| /models | 当前 Agent 的模型菜单 |
| /model 模型ID | 指定当前目录中的模型 |
| /model default | 恢复默认模型设置 |
| /effort | Codex 所选模型支持的推理强度 |
| /status | 当前 Agent、声明模型和任务状态 |
| /new | 为当前 Agent 新建会话，保留模型选择 |
| /interrupt | 中止当前任务 |

也支持原有 `/codex`、`/deepseek`、`/openclaw`、`/workbuddy`、`/workbuddycn`。选择按微信用户及 Agent 保存，切回可继续原会话。模型设置从下一条任务生效，不自动清空上下文。

## 当前限制

- Harness 的模型仍由专用 profile/patch 管理；此版不支持菜单修改。固定 WorkBuddy 代理保持其原模型限制。
- OpenClaw 模型覆盖需要 Gateway 设备权限。读取列表成功不代表可以 sessions.patch；需要原生权限审核时不保存新选择，也不会自动批准权限。本机尚未验证获授权后的覆盖调用。
- WorkBuddy 适配依赖原生 CLI 版本和本机登录绑定；不保证继承桌面全部插件、模型下拉框或历史聊天。
- 模型目录不保证账号可用，Auto 等别名不代表已确认底层模型。部分原生审批仍需在电脑处理。
- 当前按单机本人使用定位，不是可供陌生人共用的多租户平台。菜单设置隔离不隔离电脑上的账号、文件和工具权限。
- 电脑需开机、登录 Windows、联网并可访问模型服务。关闭 Codex 桌面窗口后可由后台任务继续运行，关机、休眠或注销会影响服务。
- 仅做过本机 Windows 验证，尚未完成第二台干净电脑的全流程验收。

## 开发与来源

桥接源码在 assets/bridge，`npm ci` 后运行 `npm run verify` 和 `npm test`。部署、菜单和后端细节在 references 中。

桥接基于 [zktww/weixin-codex-bridge](https://github.com/zktww/weixin-codex-bridge)，保留其 MIT LICENSE 和来源说明。本包不包含账号、二维码、私有配置、DPAPI 密钥或 WorkBuddy 应用文件。使用者需自行安装、登录和授权各产品。
