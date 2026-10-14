# 部署与运行（Windows）

## 新电脑

需要 Node.js 22+、npm、已登录可用的 Codex CLI。先选实际任务目录，再运行：

```powershell
& ./scripts/install.ps1 -InstallDir 'D:/wechat-agent-bridge' -WorkspaceRoot 'D:/agent-work' -CodexBin 'D:/tools/codex.exe'
$env:CODEX_WEIXIN_STATE_DIR = 'D:/wechat-agent-bridge/.local-state'
Set-Location 'D:/wechat-agent-bridge'
node dist/cli.js login-weixin
```

扫码后只授权本人发送者：`node dist/cli.js allow <peerId>`；需要手机审批时再 `admin <peerId>`。先用前台 `node dist/cli.js run-daemon` 做真实微信测试。首次收到未授权消息时从本机日志定位 peerId，只提取该字段，不显示整份日志。不要把所有微信发送者加入白名单。

安装脚本不会覆盖已有 config.json，不会安装模型凭证，也不会修改全局 Codex 模型。指定 Codex 的稳定可执行文件；不要指向会随桌面更新消失的版本目录。可单独在安装目录下 npm install @openai/codex 后解析其实际 Windows 可执行文件路径。

## 后台和自启

确认前台进程已退出，再以当前用户注册计划任务，动作是 Node 的绝对路径，参数为安装目录 `service-watchdog.mjs` 的引号包裹绝对路径，工作目录也是安装目录。触发器为当前用户登录，使用 Interactive/Limited，允许电池供电，执行时间限制0，重复实例 IgnoreNew，失败可重启。不要存 Windows 密码。

`service-watchdog.mjs` 自动以私有 `.local-state` 启动 daemon 并退避重启。管理时先停止任务，再 `node dist/cli.js stop`，需要重启最后启动任务，避免 watchdog 立即把旧进程拉起。任务必须独立于 Codex 桌面进程。检查进程父链和一次无在途任务的子进程恢复即可。

## 维护

先运行 doctor。`configured` 只表示已声明；`daemonAlive` 是 PID 存活证据，不代表 API 或微信收发成功。出现401时先区分配置选错版本和登录过期，不能一律要求重新登录。遇到原生 CLI 输出格式或凭证 API 变化时明确失败，勿悄悄回退到不同模型。

每次改动先 npm run verify，再做对应后端测试；确认当前没有在途任务后重启服务。备份私有配置到同一私有目录，勿复制进 skill。

会话按 peer 和 engine 保存到 routedSessions；后端 id 前缀：Codex 原生 id、dsh-、claw-、wb-、wbcn-。切换时保存旧会话，切回恢复它；/new 仅对当前后端新建。
