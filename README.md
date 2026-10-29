# dsh-plugin-soulbridge

把 [soulbridge](https://github.com/Jason0826/soulbridge) 接到 DSH 上的宿主适配器。

soulbridge 的核心不知道 DSH 的存在；这个包只做**接线**：在正确的时机调用四个动词，
把结果放进系统提示，并在失败时安静降级（[ADR 0024](https://github.com/Jason0826/soulbridge/blob/main/docs/adr/0024-adapters.md)）。

## 它做什么

| 时机 | 调用 | 现状 |
|---|---|---|
| 提示组装 | `context({ track: false })` → 注入 `<soul>` / `<style>` / `<affect>` / `<memories>` | 🚧 目前是占位标记 |
| 每条**用户**消息 | `observe(turn)` → 写记忆 + 情绪采样 | ✅ 已实现 |
| 会话结束 | `reflect(turns)` | ❌ 未接：`observe` 已逐轮蒸馏，`session/disposed` 在桌面端不触发 |
| 模型主动查询 | `recall` / `remember` 工具 | 🚧 未接 |

**不会做**：改变事实判断、编造记忆、把个人记忆写进项目文件。

日志：`~/.soulbridge/plugin.log`（`SOULBRIDGE_HOME` 可覆盖）。数据落在 `~/.soulbridge/soul.db`，
与 CLI 和任何其他工具共享同一个库。

## 安装（正式发版前，走 git 标签）

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
dsh plugin --profile desktop add "github:Jason0826/dsh-plugin-soulbridge#v0.0.4"
```

然后确认它出现在 `package.json` 的 `dsh.profile.bundles` 里，重启 DSH。

> `dsh plugin add` 会调用 pnpm；如果提示 store / virtual-store 不一致，见文末「已知问题」。

## 依赖

| 包 | 版本 | 说明 |
|---|---|---|
| `soulbridge` | `^0.0.6` | 从 npm 安装，是第一个暴露库入口（`main`/`exports`）的版本 |

## 判读日志

| 日志 | 含义 |
|---|---|
| `apply() called (v0.0.2)` | 插件被加载（标签是历史遗留，不代表版本号） |
| `section registered` + `section.text() evaluated` | 注入通路成立 |
| `user/message source=user chars=N` | 收到用户消息 |
| `soul ready: db=… soul=… user=…` | core 与数据库就绪 |
| `observe ok: chars=… written=… affect=… confidence=…` | **整条链路成功** |
| `skipping profile bundle …` (stderr) | bundle 被启动器跳过，原因就在后面 |

## 卸载

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
node "…/pnpm.mjs" remove dsh-plugin-soulbridge
# 或 dsh plugin --profile desktop remove dsh-plugin-soulbridge
```

再从 `dsh.profile.bundles` 里删掉 `dsh-plugin-soulbridge`，重启。

## 已知问题

### `dsh plugin add` 报 store / virtual-store 不一致

`~/.dsh` 若是指向另一块盘的目录联接，而 profile 的 `node_modules` 是在联接建立**之前**创建的，
pnpm 会同时报 `ERR_PNPM_UNEXPECTED_STORE` 和 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`。

修复：在**真实路径**下重装一次依赖，让 `.modules.yaml` 记录的路径与 pnpm 的解析一致。

### profile 的 `package.json` 带 BOM 会让应用起不来

DSH 启动器对 `package.json` 直接 `JSON.parse`，不剥 BOM。用 Windows PowerShell 的
`Set-Content -Encoding utf8` 改它会写入 BOM，导致启动崩溃或 bundle 被静默跳过。
本仓库用 `scripts/profile-manifest.ps1` 改写清单，用 `scripts/check-encodings.ps1` 检查编码。

## 配置（可选）

`~/.soulbridge/plugin-config.json`：

```json
{
  "distill": "llm",
  "provider": "deepseek-account",
  "model": "deepseek-flash",
  "maxLlmChars": 2000
}
```

| 字段 | 作用 |
|---|---|
| `distill` | `rules`（默认）只在本地做规则抽取；`llm` 在**规则没抽到**时再问宿主模型 |
| `provider` / `model` | 宿主模型路由；只在 `distill: llm` 时使用 |
| `maxLlmChars` | 超过此长度的消息不送模型（跳过并记录，不做截断） |

为什么是"规则优先、模型补漏"：实测规则精确率 1.00，但 26 条真实消息里漏了 19 条；
让模型覆盖规则没有收益，只在漏掉时补才有。宿主模型**只能在真实轮次内调用**，
启动时调用会被账号 provider 拒绝（见 `docs/experiment-2026-10-29-host-llm.md`）。