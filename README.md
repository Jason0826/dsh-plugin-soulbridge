# dsh-plugin-soulbridge

**Spike**（0.0.1）：验证 DSH 插件能否给 soulbridge 提供两个确定能力——系统提示注入、会话事件观察。

不碰记忆库、不调 core、不写任何用户数据。目的只有一个：**拿到运行时证据**。

## 它做什么

| 挂载点 | 行为 | 日志 |
|---|---|---|
| `ctx.systemPrompt.section` | 注册 `name: soulbridge`、`order: 10` 的常驻段，文本为一行标记 | `section registered` / `section.text() evaluated` |
| `ctx.on('session/event')` | 记录事件类型与 payload 的 key 列表 | `session/event type=… dataKeys=[…]` |
| `ctx.effect` | 注册卸载清理 | `effect registered` / `effect disposed` |

日志位置：`~/.soulbridge/plugin.log`（可用 `SOULBRIDGE_HOME` 覆盖）。

**只记 key，不记内容**——第一轮不采集任何对话文本。

## 安装

```powershell
# 1. 装进 DSH 的 desktop profile
cd $env:USERPROFILE\.dsh\profiles\desktop
npm install "D:\git-workspace\repos\dsh-plugin-soulbridge"

# 2. 把包加进 bundles（编辑 package.json）
#    "dsh": { "profile": { "bundles": [ …, "dsh-plugin-soulbridge" ] } }
```

然后**重启 DSH**。

## 卸载

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
npm uninstall dsh-plugin-soulbridge
# 同时从 package.json 的 dsh.profile.bundles 里删掉它
```

## 判读日志

| 日志 | 含义 |
|---|---|
| `apply() called` | 插件被加载了 |
| `section registered` + `section.text() evaluated` | 注入通路成立 |
| `session/event type=user/message dataKeys=[…]` | 事件通路成立，且能看到用户消息的字段 |
| `effect disposed` | 卸载时清理正常 |
| 完全没有 `apply() called` | 插件没被加载（bundles 或依赖没配对） |

## 已知风险

- DSH 是 nightly（本机 `version` 文件为 44.7.0），插件 API 可能已漂移
- 首次加载失败时，DSH 可能只打一条警告；先看 `plugin.log` 再看应用日志
- 本包是 ESM + 纯 JS，无构建步骤；正式版应改为 TypeScript 并加类型

## 实测记录（2026-10-28，本机 nightly 44.7.0）

**不需要重启**：修改 profile 的 `package.json` 后，应用自己热加载了插件（`apply()` 在配置写入后立即被调用）。

已确认：

| 项 | 结果 |
|---|---|
| `systemPrompt.section` | 注册成功，`text()` 每次 assembly 重算（日志中两次求值） |
| 注入生效 | 标记文本出现在模型系统提示中 |
| `session/event` | 收到 `assistant/message`、`tool/call`、`tool/result`、`step/start`、`step/end`、`system/message`、`job/registered` |
| `ctx.effect` | 注册成功，disposer 尚未触发 |
| `user/message` | **未观测到**（本轮用户消息早于监听器注册），待下一轮确认 |

payload 形状（data 的 key）：

```
assistant/message  turn, step, message, usage, stream
tool/call          turn, step, callId, name, arguments
tool/result        turn, step, message, meta
```

`session` 对象暴露 `eventsSnapshot` / `log` / `header` / `contextFold` / `toolHistoryProjection`，可绕过事件直接读快照。

## 安装备注

`dsh plugin --profile desktop add <path>` 在本机失败：`~/.dsh` 是指向 `D:\DSH\home` 的目录联接，pnpm 的 store 与 virtual-store 路径解析不一致（`ERR_PNPM_UNEXPECTED_STORE` / `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`）。

改为零包管理器安装：

```powershell
New-Item -ItemType Junction -Path "D:\DSH\home\profiles\desktop\node_modules\dsh-plugin-soulbridge" -Target "D:\git-workspace\repos\dsh-plugin-soulbridge"
# 再把 "dsh-plugin-soulbridge" 加进 package.json 的 dsh.profile.bundles
```

卸载用 `scripts/rollback.ps1`。

## 事故记录：manifest BOM 导致启动崩溃

2026-10-28，安装本插件时手工编辑了 profile 的 `package.json`。Windows PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写入 UTF-8 BOM，而 desktop host 的 `readProfileManifest` 直接 `JSON.parse`，不剥 BOM：

```
DesktopHostFatalError: Unexpected token '﻿', "﻿{" is not valid JSON
  at readProfileManifest (.../dsh-app-boot/lib/index.js:913)
```

结果：应用启动即崩溃，需要手工改回无 BOM 才能恢复。

**此后所有 manifest 写入必须走 `scripts/profile-manifest.ps1`**（`UTF8Encoding(false)` + 写后校验），不要再用 `Set-Content` / `Out-File`。
