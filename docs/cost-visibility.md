# 花在哪儿了（宿主侧运维记录）

> **这份文档不属于 soulbridge。** soulbridge 是记忆与人格层（`packages/core` 里没有一行成本逻辑）：
> 它存"发生了什么"，不记"这值多少钱"。用量与账单是**宿主的运维数据**，所以放在这个仓库：
> 这里已经有 `scripts/trace-stats.mjs` 这类观测脚本，`billing.mjs` 和它们是一类东西。
>
> 2026-11-04 从 soulbridge 仓库搬过来（原先误放在 `docs/briefs/0026`，等于把"看账单"
> 登记成了产品需求）。

## 两个工具，口径分开

| 谁 | 记什么 | 落点 |
|---|---|---|
| 插件（`index.js` 的 `turn-cost`） | 每轮：请求数、步骤数、失败重试、插件自己的调用、四类 token、耗时、结束原因 | `~/.soulbridge/trace.jsonl`；一轮 ≥30 次请求时另打一行到 `plugin.log` |
| `scripts/billing.mjs` | 每天：金额、请求数、三类 token，以及按导出单价重算的复核值 | 终端 |

**插件不估金额。** 价目有峰谷两档（导出里同一 token 类出现两个单价）且会变，抄一份进代码
就是第二份真相。钱的唯一来源是平台导出的 CSV。

## 实测（2026-11-04）

```
11/01–11/04   ¥100.22 · 6,028 次请求 · ¥0.0166/次
金额构成：输入命中 56.3% / 输入未命中 23.3% / 输出 20.1%
输入 token 占 99.8%，其中缓存命中 99.2%
单价复核：按 price×amount 重算 ¥100.22 vs 账单 ¥100.22（差 0.00%）
一次会话 387 轮，单轮最多 108 次请求，平均 18 次
```

读法：**钱主要在输入，输入主要在缓存命中**——所以"少发请求"比"少发 token"更值钱；
一个 573 轮的会话每轮都要重新买一遍全部历史，单轮 ¥0.017 里绝大部分就是这个。

## 怎么跑

```powershell
cd D:\git-workspace\repos\dsh-plugin-soulbridge
node scripts/billing.mjs                    # D:\Download 里最新的 usage_data_*.zip
node scripts/billing.mjs --days 4           # 只看最近 4 天
node scripts/billing.mjs --zip <file.zip>   # 指定导出
node scripts/billing.mjs --dir <folder>     # 已解压的两个 CSV
node scripts/billing.mjs --json             # 给程序读
```

导出来自平台用量页（`cost-*.csv` 金额、`amount-*.csv` 请求与 token）。

## 已知限制

- 子代理跑在自己的会话里，**各自一条记录**，不滚到父轮（事件流没有谱系）。
- 崩溃/重启导致的未结束轮次没有记录；同会话再来一轮时，上一条以 `open:true` 补写。
- 平台的 `request_count` 与插件计数口径不同（前者含所有 key 与所有进程），核对看差额。

## 判读日志

| 日志 | 含义 |
|---|---|
| `turn cost: session=… turn=… requests=N (steps=S failed=F plugin=P)` | 这一轮到了 30 次请求 |
| `{"event":"turn-cost",…}`（trace） | 每轮一条，字段见上表 |

## 提醒换会话（2026-11-05）

同一条 `turn-cost` 记录还回答另一个问题：**这个会话还能不能继续开下去**。

```
阈值（插件内常量 SWITCH_SESSION，一处声明）
  每请求上下文 ≥ 300k token（历史会话 420k 时出过整轮空回复）
  或 轮数 ≥ 100
节奏  每跨一级提醒一次；600k/200 轮是第 2 级——翻倍才再说，不是每轮都说
落点  pre-step 注入 <switch-session turns=… context-per-request=…>，由模型转告用户
      plugin.log 一行  switch-session: remind turn=N
      trace 一条  {"event":"switch_session",…}
```

**为什么由模型转告，而不是插件自己弹提示**：插件没有写"用户可见消息"的通道，能保证用户看到的只有回复本身。所以注入的是一句**给模型的指令**（"请提醒用户……"），而不是一条通知。

**为什么每级只说一次**：每轮都说会变成墙纸；翻倍才说，说明"情况确实更糟了"。
