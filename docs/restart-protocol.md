# Web host: 启动、重启与高频开发

这份文档同时服务两件事：**host 别莫名其妙掉线**，和**开发时会话要能安全地反复重启它**。
两个场景的前提不同，所以先分开定义，再合并成同一套机制。

## 1. 两个场景

| | 生产 | 开发 |
|---|---|---|
| 谁在重启 | 几乎没人手动重启 | 每改一版就重启，可能每几分钟一次 |
| 最怕什么 | host 挂了没人发现、机器重启后不恢复 | 重启被静默丢弃、双 host、重启把自己这轮杀掉 |
| 容忍的等待 | 30 秒无所谓 | 30–60 秒是上限，且必须知道"这次到底重启了没有" |

同一套脚本要同时满足两者，靠的是**区分"请求重启"和"执行重启"**，而不是加开关。

## 2. 已经修掉的三个问题（2026-11-07）

| 问题 | 表现 | 修法 |
|---|---|---|
| 日志自吞 | 25 次启动、0 条 `ready at`；`Add-Content` 报"文件正由另一进程使用" | 重启记账写 `web-restart.log`，不再和 host 抢 `web-host.log` |
| 按进程名杀 | `-Name 'DeepSeek Harness'` 同时命中桌面版和 web host | 改成按端口/命令行精确匹配，`-StopDesktop` 才是显式开关 |
| 变量名撞车 | `foreach ($pid in ...)` 一旦真有进程就抛 "Cannot overwrite variable PID" | 改用 `$hostPid`（原来循环体从没执行过，所以没暴露） |

## 3. 目标形态

```
DshWebHost（计划任务，AtLogOn）
  └─ wscript.exe web-host-hidden.vbs        ← 没有控制台窗口
       └─ powershell web-host-supervisor.ps1 ← 常驻守护，持任务为 Running
            └─ cmd /c web-host.cmd           ← 隐藏窗口
                 └─ dsh --profile web --port 3080 --no-open  →  web-host.log
                      └─ 打印 token 行 → supervisor 写 web-url.txt + DSH-Web.url
```

三层各管一件事：

- **任务**：只在登录时拉一次，跑起来就长期持有；它不再是"看门狗"。
- **supervisor**：host 退出（崩溃也算）→ 5 秒后重启；每次启动都把新 token 发布出去。
- **restart-web.ps1**：人来按的那个按钮。停任务 → 等进程树真的消失 → 起任务 → 等新 token → 写链接。

## 4. 不变量

1. **3080 上最多一个 host。** supervisor 启动前先看端口，被占就等；重启脚本先停任务再等进程树消失，等不到才强杀。
2. **重启串行。** `web-restart.lock` 带 pid；占用者已死视为残留并清除；等满 `-LockWaitSeconds` 仍未拿到就退出码 2（`BUSY`）。
3. **URL 永远指向当前进程。** 谁启动谁发布；崩溃重启同样发布，所以快捷方式不会停在上一轮的 token 上。
4. **日志只由一个写者持有。** host 写 `web-host.log`；重启写 `web-restart.log`；守护写 `web-supervisor.log`。
5. **重启有明确结论。** 退出码 0/2/3/4 + 一行 `ready at` / `NOT READY` / `BUSY` / `REFUSED`。

## 5. 三个入口，别用错

| 场景 | 用什么 | 为什么 |
|---|---|---|
| 人手重启（终端里、快捷键） | `powershell -File scripts\restart-web.ps1` | 前台执行，能立刻看到退出码 |
| **会话内**（agent 自己触发的重启） | `schtasks /run /tn DshWebRestartOnce` | 会话里直接跑脚本 = 重启脚本是被杀进程的子进程，会连坐 |
| 崩溃自愈 | 不用管，supervisor 做 | 5 秒后自动重启并刷新 URL |

## 6. 开发会话的重启协议（给在另一个会话里写代码的那个 agent）

**铁律：不要在轮次进行中重启。** 重启会杀掉当前轮，这一轮不会进 `turns` 表——2026-11-06 的 turn 11 和 11-07 01:51 的 turn 18 都是这么丢的。

推荐的循环：

```
1. 改代码 → 构建 → 单测（不重启）
2. 需要生效时：把结论写进 state.md / 交接（重启会丢这一轮的原始对话）
3. 触发：schtasks /run /tn DshWebRestartOnce      ← 脱离进程树，不会连坐
4. 等 30–60 秒，读 ~/.soulbridge/web-restart.log 末尾：
      ready at  http://127.0.0.1:3080/?token=...   → 成功
      BUSY / NOT READY / REFUSED                   → 见第 8 节
5. 用新链接重开标签页（旧 cookie 随新 token 失效）
```

节奏建议：

```
同一分钟内不要请求第二次重启      → 第二次会排队（最多 180s），不是被丢弃
一次改动能合并成一个批次             → 少重启一次 = 少丢一轮上下文
重启前必须落盘                     → 否则这一轮的推理过程只剩日志，不在记忆里
```

`-DelaySeconds 90` 是留给"先把这句话发出去"的窗口：任务触发后 90 秒才真正动手，够本轮结束。

## 7. 切换步骤（一次性，需要管理员权限注册任务）

```powershell
# 1. 任务动作：cmd.exe /c web-host.cmd  →  wscript.exe //B //Nologo web-host-hidden.vbs
$vbs = 'D:\git-workspace\repos\dsh-plugin-soulbridge\scripts\web-host-hidden.vbs'
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B //Nologo "' + $vbs + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'DshWebHost' -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force

# 2. 兜底心跳：每 5 分钟确认 3080 还在，不在就把任务拉起来
$hb = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "D:\git-workspace\repos\dsh-plugin-soulbridge\scripts\web-host-heartbeat.ps1"'
$hbTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::MaxValue)
Register-ScheduledTask -TaskName 'DshWebHeartbeat' -Action $hb -Trigger $hbTrigger `
  -Settings $settings -Principal $principal -Force

# 3. 重启一次验证
powershell -NoProfile -ExecutionPolicy Bypass -File D:\git-workspace\repos\dsh-plugin-soulbridge\scripts\restart-web.ps1
```

回滚（一条命令，恢复旧动作）：

```powershell
$old = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c D:\git-workspace\repos\dsh-plugin-soulbridge\scripts\web-host.cmd'
Set-ScheduledTask -TaskName 'DshWebHost' -Action $old
```

**注意**：`AtLogOn` + `Interactive` 意味着"登录后才跑"。Windows 更新重启后如果停在登录界面，host 不会自己回来——那要靠自动登录，属于安全取舍，另行决定，不在本机制范围内。

## 8. 排错：先看哪个文件

| 症状 | 看 | 判据 |
|---|---|---|
| 点了没反应 | `web-restart.log` 末行 | `BUSY` = 另一个重启在跑；没有新行 = 脚本没起来 |
| 起来又断 | `web-supervisor.log` | 连续 `host exited (code ...)` = host 崩溃，看 code |
| 链接打不开（401） | `web-url.txt` 与浏览器地址 | 文件里的 token 才是有效的；地址栏那个已被重定向丢掉 |
| 端口被占 | `Get-NetTCPConnection -LocalPort 3080` | OwningProcess 是谁；不在任务树里就是残留 |
| 任务状态可疑 | `Get-ScheduledTaskInfo DshWebHost` | `0xC000013A` = 控制台被关掉的旧症状，切换后不该再出现 |

## 9. 验收线

```
① 连按两次重启 → 第二次要么排队成功，要么明确 BUSY，不能"看起来成功但没重启"
② 启动期间 3080 从未出现两个 listener
③ 手动杀掉 host 进程 → 5 秒内 supervisor 把它拉回来，且 web-url.txt 变了
④ 全程没有 cmd 窗口出现
⑤ 重启后 Get-ScheduledTaskInfo 的 State 是 Running，不是 Ready
```
