# 实验记录：插件能否使用宿主模型（ctx.llm）

- 日期：2026-10-29
- 版本：`dsh-plugin-soulbridge@0.0.11`（含一次性 POC 模式）
- 结论：**账号型 provider 拒绝插件侧的直接调用**
- 状态：已停止实验，POC 代码已从生产插件移除

## 问题

蒸馏（把用户的一段话提炼成 ≤40 字的记忆）目前是规则实现。规则臂的实测数据是
`P=1.00 / R=0.78`（12 条标注样本）。问题：能否用 DSH 宿主自己的模型提升召回，
而不引入额外的 key 或端点？

## 设计

在插件的 `apply()` 中加一次性模式：若 `~/.soulbridge/poc.json` 存在，就把 12 条
fixture 依次送进 `ctx.get('llm').stream({ provider, model, messages })`，把原始回复
写入 `poc-result.json`。评分器（`scripts/poc-distill.mjs --score`）与规则臂共用同一套
判据，保证可比。

- `provider: deepseek-account`
- `model: deepseek-flash`
- 请求体按 `RequestMessage` 构造：`{ id, role: 'user', content: [{type:'text',text}], source: {kind:'user'} }`

## 结果

12 条全部返回：

```json
{
  "raw": "",
  "chunkTypes": ["finish"],
  "finish": "error",
  "detail": {
    "code": "ACCOUNT_SIGN_IN_REQUIRED",
    "message": "Sign in to DeepSeek to use the account provider. The request destination must allow account authentication."
  }
}
```

耗时 1–450 ms，请求确实发出并被拒绝，不是空流。

## 排除项

上一轮曾出现「12 条全部 0 ms 空流」，那是 `messages` 用了
`{ role, content: string }`（错误结构）导致适配器立即结束。修正为 `RequestMessage`
后错误变成 `ACCOUNT_SIGN_IN_REQUIRED`，说明**请求已进入适配器，被鉴权层拒绝**。
两个问题不同，不能混为一谈。

## 解释

账号型 provider 的凭据绑定在**经过认证的请求目的地**上（即 agent 循环发起的调用），
插件在启动阶段的裸调用没有这个上下文。这是宿主的安全边界，不是可以通过改参数绕过的
缺陷；绕过它等于绕开账号鉴权，不做。

## 对设计的影响

| 方案 | 可行性 | 备注 |
|---|---|---|
| 插件内直接调账号 provider | ❌ 实测被拒 | 除非调用发生在鉴权上下文内（未验证） |
| 在真实轮次内调用（observe/turn 期间） | ？ 未验证 | 需要一次真实回合的探针，代价小 |
| 用户在 DSH 里配置 API-key provider | 可能 | 不依赖账号登录，插件可调用 |
| OpenAI 兼容端点（A） | ✅ 已知可行 | 需要 key；对 Claude Code 等宿主同样适用 |
| 不做 LLM 蒸馏 | ✅ 立即可用 | 规则臂 P=1.00 / R=0.78 |

## 下一步（待定，不在本实验内）

1. 在真实轮次内做一次探针，确认“鉴权上下文内调用”是否成立；
2. 若成立，蒸馏放在 turn 内；若不成立，走 API-key provider 或端点；
3. 端点方案（A）同时服务未来非 DSH 宿主，可作为跨宿主的参考实现。

---

## 补充实验（同日）：turn 内调用

针对上面的开放问题——「鉴权上下文是否随 turn 传递」——单独做了一个探针包
（`dsh-plugin-soulbridge-probe`，private，测完即卸载）：

- 触发：第一次真实 `user/message`
- 调用：同一个 `provider: deepseek-account` / `model: deepseek-flash`
- 结果：

```json
{
  "phase": "in-turn",
  "ok": true,
  "finish": "stop",
  "chunkTypes": ["block-start", "reasoning-delta", "block-end", "text-delta", "usage", "finish"],
  "text": "提交前先跑测试。提交前先跑测试。",
  "ms": 1567
}
```

**结论修订**：账号 provider 的鉴权随**请求上下文**传递，不随进程。同一个调用：

| 时机 | 结果 |
|---|---|
| 插件 `apply()`（启动，无 turn） | `ACCOUNT_SIGN_IN_REQUIRED` |
| 真实 `user/message` 回合内 | `ok: true`，1567 ms |

所以 C 方案成立，但**只能在 turn 内调用**；不能做离线批量跑，因此「用 fixture 批量对比
规则 vs 模型」这条路在 DSH 上不可行，只能用真实消息做长期测量。

## 真实消息的规则命中率（26 次 observe）

| 指标 | 值 |
|---|---|
| `written >= 1`（规则记住了） | 7 |
| `written = 0`（规则漏了） | 19 |
| 漏掉且 ≥20 字 | 6 |
| 消息长度中位数 | 24 字 |
| 最长 | 18205 字（一次粘贴） |

如果 LLM 只在「规则漏掉」时兜底，调用量是 19/26（73%）；如果只在「漏掉且 ≥20 字」时兜底，
是 6/26（23%）。单次调用约 1.5 秒，在 observe 的异步路径里，不阻塞用户看到回复。