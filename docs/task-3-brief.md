# task-3 复原简报

> 来源：旧会话 `659d519f-2ddc-45da-9218-36dc15642117` 的 `session_projcache`（会话正文已随 2026-11-09 的 `~/.dsh` 重置丢失，但首轮提示词与 todo 仍保存于该缓存文件）。
> 原会话进度：1 turn / 16 steps，todo 第 1 项 in_progress，其余 pending。

## 原始任务提示词（逐字复原）

你是团队里的独立验证工程师（QA）。团队共享目录 F:\code\dsh-scnet-connect，已有一个由 Lead 实现的 DSH 插件 `dsh-scnet-connect`，把本机 SCNet 客户端（超算互联网）的免费模型 SCNet-Max 接入 DSH。任务板任务 id 是 task-3：先 team_task_get 读取，再 team_task_update action=claim expected_revision=1 认领，完成后 complete。

你的写权限：.research/verify/、docs/verify-report.md。**不要修改** lib/、package.json、cordis.patch.yml、README（Lead 负责）；发现问题写进报告即可。

背景事实（已由 Lead 与另一名成员实测确认，可直接用）：
- 上游：`https://api.scnet.cn/api/llm/v1`，OpenAI 兼容；模型 id `SCNet-Max`（大小写敏感，免费）；鉴权 `Authorization: Bearer sk-...`；key 在 `C:\Users\H\.sclaw\agent\scnet-credentials\*.json` 的 `{scnet:{type:'api_key',key}}`；客户端不需要运行。
- 插件：`F:\code\dsh-scnet-connect`，入口 lib/index.js，用 `PiAiAdapter` 注册 provider `scnet`，每次请求重读凭据；装配行 id=`scnet-connect`、name=`dsh-scnet-connect`；安装命令 `dsh plugin --profile <p> add link:F:\code\dsh-scnet-connect`。
- DSH CLI：`D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`（不在 PATH）。DSH 0.2.1-rc.3。当前桌面版 GUI 在 http://127.0.0.1:11256（**不要重启/杀它**，也不要在 ~/.dsh 上做破坏性操作）。用临时 `$env:DSH_HOME` 做隔离测试。
- 已验证过（可复现，但你要独立跑一遍）：scratch profile `--dump-config-schema` → complete:true；headless 模板 + `--patch` 把 agent-default-model 指到 scnet/SCNet-Max 后，纯文本与工具调用（DSH_TOOLS_MODE=native）都成功；插件会写 `$DSH_HOME/scnet-connect-status.json` 诊断文件。

请按 task-3 描述完成 6 项（装配验证、真实 E2E 文本+工具、错误路径、lib/*.js 代码审查、交付物检查、写 docs/verify-report.md）。代码审查重点：key 是否会泄漏（日志/status 文件/错误信息）、异常处理、reasoning 映射是否与 docs/scnet-api.md 一致（合法值 none/minimal/low/medium/high/xhigh/max；off→none；非法值会 400 code 10013）、模型元数据（contextWindow 262144 / maxTokens 32768 的取舍）、无谓写文件/性能问题、DSH 卸载路径。只报真实且可复现的问题，不为了挑刺而挑刺。

报告结构：结论表（每项 通过/失败/未验证 + 证据命令与关键输出）、问题清单（P0/P1/P2 + 复现步骤 + 建议修法）、对交付物/README 的最小必改项。最后 send_message 给 lead：通过/失败一览 + 必须修的缺陷编号。用 PowerShell 7。

## 复原的 todo 列表（原顺序，18 项中的 7 项）

1. 探查仓库结构与现有交付物/文档（lib/、package.json、cordis.patch.yml、docs/） — **in_progress**
2. 干净装配验证：临时 DSH_HOME + add link + dump-config/schema — pending
3. 真实 E2E：headless 模板 + patch，纯文本 + 工具调用两条 — pending
4. 错误路径验证：credentialDir 不存在 / 错误 apiKey — pending
5. 代码审查 lib/*.js（key 泄漏/异常/reasoning 映射/元数据/写文件/卸载路径） — pending
6. 交付物检查（package.json、README、cordis.patch.yml、.gitignore、明文 key grep） — pending
7. 写 docs/verify-report.md 并 send_message 给 lead，complete task-3 — pending

## 环境事实更新（续跑前必读）

原提示词里的几条环境假设在 2026-11-09 事故后已变化：

- 桌面版 GUI 端口仍为 **11256**（patch 已重新固定），但**会话历史已被清空**，现在只有 09:07 之后新建的会话。
- 团队任务板与 lead/成员之间的 `team_task_get` / `team_task_update` / `send_message` 属于**旧的协作会话上下文**，随会话丢失已不存在。续跑时若这些工具不可用，直接把 6 项验证当作独立 QA 任务执行，结果落到 `docs/verify-report.md` 即可。
- 插件已重新装入 desktop profile（`link:F:\code\dsh-scnet-connect`），`node_modules/dsh-scnet-connect` 为有效 Junction。
- 隔离测试的正确姿势（2026-11-09 实测）：`cp -r` profile 到临时 `$env:DSH_HOME`，`CI=true dsh plugin --profile <copy> install` 补符号链接，**改一个不同端口**避免与真机冲突，然后 `dsh --profile <copy> --no-open` 真启动，看到 `dsh web: http://127.0.0.1:<port>/?token=...` 才算通过。注意 `--dump-config` **不校验必填项**。

## 已实测到的错误路径素材（可直接引用）

`C:\Users\H\.sclaw\agent\scnet-credentials` 当前不存在，插件表现：

```
"credential": {
  "source": "unavailable",
  "error": "找不到 SCNet 模型服务凭据目录（C:\\Users\\H\\.sclaw\\agent\\scnet-credentials）：ENOENT ...。请先打开 SCNet 客户端并登录 ..."
}
```

结论：缺少凭据时插件**不崩**、仍完成 provider 注册（`registered: true`）并写出诊断文件——这是「错误路径验证」和「异常处理审查」的正向证据。同时说明 **E2E 真实调用需要先让 SCNet 客户端登录并生成 key**，否则只能验证装配与失败路径。
