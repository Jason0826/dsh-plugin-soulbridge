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
| 插件（`index.js` 的 `turn-cost`） | 每轮：请求数、步骤数、失败重试、插件自己的调用、四类 token、`mainMax`（宿主单请求最大前缀）、耗时、结束原因 | `~/.soulbridge/trace.jsonl`；一轮 ≥30 次请求时另打一行到 `plugin.log` |
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

## 主动建议（2026-11-05 提醒换会话；2026-11-06 泛化为触发器注册表，[0018](https://github.com/Jason0826/soulbridge/blob/main/docs/briefs/0018-behaviour-influence.md)；2026-11-07 加成本模型与压缩预算；2026-11-07 闸门改读真实上下文 mainMax）

同一条 `turn-cost` 记录还回答另一个问题：**这个会话还能不能继续开下去**。

```
注册表   PROACTIVE_TRIGGERS（声明式行：新习惯 = 加一行，不改代码路径）
  行 compact-limit     已压缩 ≥2 次 且 每请求 ≥ 200k → 这次建议换新会话
                       （两压一会话：摘要套摘要会失真；先写 state.md 再开）
  行 context-compact   每请求上下文 ≥ 200k → 建议 /compact 续命
                       （用户偏好留在本会话；预算 ≥2 次后本行让位给 compact-limit）
  行 switch-session    每请求 ≥ 300k 或 轮数 ≥ 100 → 换会话提醒，
                       措辞是「优先 /compact，反复压缩或变慢再新开」
节奏     每行每级一次；翻倍（400k / 600k…）才再说——不是每轮都说
信号     闸门读 mainMax（本轮宿主主请求的最大前缀 = 真实上下文），不读弧平均：
        跨轮平均是滞后统计——2026-11-07 实测弧 141k、真值 245k，200k 线
        连哑五轮；且弧里混着插件自己的小模型调用（插件调用不骑会话上下文）。
        mainMax 缺失的旧记录回退弧平均。轮成本算钱仍用全量四类 token（钱是钱）
账本     compaction/end → sessionLedger.compact()：重置上下文弧（prompt/requests/
        mainMax 归零，轮数保留作年龄守卫），重新武装 200k 线——否则压缩后继续报旧账
        （turn 14 实测 27k 却报 350k，虚报 13 倍）
        启动时 rebuildLedger 从 trace 重放（turn-cost→note、ledger-compact→compact
        按事件里的绝对数对账；2.95MB 全量一遍）——账本是内存态，重启不清预算/弧/轮数，
        否则下次过线会建议压缩已花光的预算（11-07 已压 2 次）。reminded 不重放
        （proactive 事件只带 trigger 不带 level）→ 重启可能把仍有效的建议再说一次，
        预算数精确；compact() 对未见过的会话也计数（A9 发现已关闭）
        plugin.log 一行  ledger: rebuilt from trace (turn-cost=N ledger-compact=M)
        plugin.log 一行  ledger: compaction observed, context arc reset (compactions=N)
        trace 一条      {"event":"ledger-compact","session":…,"compactions":N}
落点     pre-step 注入 <proactive id=…>，由模型转告用户
        plugin.log 一行  proactive: remind id=… turn=N trigger=…
        trace 一条  {"event":"proactive","id":…,"action":"asking","trigger":…}
```

**提醒里带钱，不只带 token（2026-11-07）**：`context-compact` / `compact-limit` 的文案算出
「每轮约 ¥X，压缩到基线后约 ¥Y（差 N 倍）」。单价取离峰价（命中 ¥0.02 / 未命中 ¥1 每 M），
携带率 = 近几轮平均请求数 × 命中价 + 0.29 × 未命中价——0.29 是实测驱逐率（14 个轮间隔里
4 次全量重读），未命中贵 50 倍，**驱逐占携带成本约四分之三**。压缩后基线 27k 是 turn 14 实测。

**200k 不是魔数，是算出来的（EOQ 模型，参数全部来自本会话 trace）**：

```
每轮携带成本 = k × 上下文      k = n×命中价 + 驱逐率×未命中价 = ¥0.39/M·轮
每次压缩成本 = F ≈ ¥0.07       读全段 + 摘要输出 + 新前缀首次全未命中
最优阈值 C* = R + √(2Fg/k)     R=27k 基线, g=20.4k/轮增长
叙事定价 N=¥0/次   → 115k（每 4.3 轮压一次，太频）
叙事定价 N=¥0.2/次 → 196k ≈ 现行 200k   ← 两压一会话的隐含价码
```

平台很平：100k–210k 全在最优 ±20% 内（200k vs 115k = ¥0.33/天）。**硬边界只有两条：
别低于 80k（周期 <3 轮，压缩本身成负担），别骑过 300k（线性变贵 + context rot）。**
参数敏感性（驱逐率 0.1–0.5、请求数 3–15、增速 10k–40k）让机器答案在 89k–186k 摆动——
精调无意义，**阈值由叙事和质量决定，钱只负责画边界**。

**长离开前先压（turn-12 教训，进文案不进触发器）**：驱逐不可预测（22 分钟被逐、82 分钟反而
没逐，可能与同账号其他流量竞争），做不成信号；但代价可算——隔夜那笔 ¥0.343 是本会话最大
单笔开销，压缩后再隔夜只要 ¥0.027。所以这句话写进 `context-compact` 的建议里，靠习惯执行。

**为什么由模型转告，而不是插件自己弹提示**：插件没有写"用户可见消息"的通道，能保证用户看到的只有回复本身。所以注入的是一句**给模型的指令**（"请提醒用户……"），而不是一条通知。

**为什么每级只说一次**：每轮都说会变成墙纸；翻倍才说，说明"情况确实更糟了"。

**为什么是三行**：200k 是"该 compact 了"的提前量，300k 是"compact 可能不够了"的升级，compact-limit 是"压缩预算花光了，这次换新的"——先建议压缩，再建议换会话，预算用完后同一条线改口。三行的 action 都是 asking（0018 动作四选一），默认 silent 不在注册表里。两行按压缩次数**瓜分** 200k 线（partition 测试压着：预算内 context-compact 说话、预算外让位），同一轮不会两条打架。
