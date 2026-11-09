# task-3 独立验证报告 — dsh-scnet-connect

- 验证者：独立 QA（无 Lead 上下文，按 `docs/task-3-brief.md` 的 A/B/C/D 执行）
- 日期：2026-11-09 09:57–10:35（GMT+8）
- 被验证对象：`F:\code\dsh-scnet-connect`（`package.json` v0.1.0，入口 `lib/index.js`）
- 写权限遵守：只写了 `docs/verify-report.md` 与 `.research/verify/`（gitignored），未改动 `lib/`、`package.json`、`cordis.patch.yml`、`README.md`
- 未做任何破坏性操作：11256 的桌面 GUI 全程未重启/未终止（结束前复核仍在监听）；未在 `C:\Users\H\.dsh` 的 profile 上做修改

## 0. 结论一览

**6 项验证全部通过，无 P0 / P1 缺陷；6 条 P2/P3 改进项，均不影响功能可用性。**

第 3 项原本按简报 C 应标「未验证 — 缺凭据」，但测试进行中（10:11）本机 SCNet 客户端数据目录出现并生成了 model-service key，因此完成了**真实上游 E2E**，结论从「未验证」升级为「通过」。

| # | 验证项 | 结论 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 干净装配（临时 DSH_HOME + 真启动） | **通过** | 两条独立路径均在日志里看到 `dsh web: http://127.0.0.1:<port>/?token=…`，且 `scnet-connect-status.json` 为 `registered: true`（明细见 §1） |
| 2 | 真实 E2E：纯文本 | **通过** | 真实 `api.scnet.cn`，最终 `text=收到`，`totalTokens=6007`（含思考 token） |
| 3 | 真实 E2E：工具调用 | **通过** | 真实上游发起 `read(package.json)` → `tool_result` → 第二轮 `text=dsh-scnet-connect` |
| 4 | 错误路径 | **通过** | 缺凭据目录 / 401 错误 key / 损坏凭据文件三种输入都「不崩、错误可读、不泄漏 key」 |
| 5 | `lib/*.js` 代码审查 | **通过（附 QA-1/2/6）** | 无 key 泄漏路径；发现映射精度、死代码、状态文件残留等问题，见 §5 与 §6 |
| 6 | 交付物检查 | **通过（附 QA-3/4/5）** | 跟踪文件无明文 key；`npm pack` 只含 8 个文件、缺 `docs/` 与 `tools/`，见 §6 |
| 7 | 报告 + 提交 | **通过** | 本文件 + `git commit` |

> 说明：注入到会话里的旧简报把 6 项写成「装配/E2E/错误路径/代码审查/交付物/写报告」。本报告按实际验证内容拆成 7 行（E2E 拆成文本与工具两条），内容与 6 项一一对应。

## 1. 装配验证

### 1.1 路径 A：桌面 profile 副本（0.2.1-rc.3 时期，10:02）

```powershell
$home2 = 'F:\code\dsh-scnet-connect\.research\verify\home-assembly'
Copy-Item -Recurse "$env:USERPROFILE\.dsh\profiles\desktop" "$home2\profiles\scnet-check"
# 把副本里的 webserver.port 从 11256 改成 11259（避开正在使用的 GUI）
(Get-Content "$home2\profiles\scnet-check\cordis.patch.yml" -Raw) -replace 'port: 11256','port: 11259' |
  Set-Content "$home2\profiles\scnet-check\cordis.patch.yml" -Encoding utf8
$env:DSH_HOME = $home2
CI=true & $dsh plugin --profile scnet-check install
& $dsh --profile scnet-check --no-open
```

关键输出：

```
dsh web: http://127.0.0.1:11259/?token=4BW5XpEreoGI2iuLDw9DVsVJkmdp5exI0mQvmPXtc
```

`$DSH_HOME/scnet-connect-status.json`：

```json
{ "registered": true, "provider": "scnet", "providerName": "超算互联网 SCNet",
  "baseUrl": "https://api.scnet.cn/api/llm/v1",
  "models": [{ "id": "SCNet-Max", "contextWindow": 262144, "maxTokens": 32768,
               "input": ["text","image"], "reasoning": true }] }
```

> 这一条同时验证了简报 C 强调的坑：**`--dump-config` 不校验必填项**，只有真启动才能证明 `webserver.host` 等必填字段齐全。副本里补了 `host: 127.0.0.1` + 新端口后一次启动成功，无 stderr。

### 1.2 路径 B：全新出厂 `web` profile（当前 runtime，10:15）

```powershell
$env:DSH_HOME = 'F:\code\dsh-scnet-connect\.research\verify\home-web'
& $dsh --profile web-check --from-default-profile web --dump-config
CI=true & $dsh plugin --profile web-check add link:F:\code\dsh-scnet-connect
& $dsh --profile web-check --patch .\.research\verify\web-check.patch.yml --no-open
```

关键输出（patch 把端口改到 11261）：

```
dsh web: http://127.0.0.1:11261/?token=KhMztCDCoAKun41NEIAEy4zihz-RCjehHkFXp6gM3rc
```

status 文件（此时本机已有真实客户端凭据）：

```json
{ "registered": true,
  "models": [{ "id": "SCNet-Max", "name": "SCNet-Max · 免费", "contextWindow": 262144, "maxTokens": 32768 }],
  "credential": { "source": "client-file",
                  "file": "C:\\Users\\H\\.sclaw\\agent\\scnet-credentials\\303a5f74….json",
                  "maskedKey": "sk-NTM4L…MjM=" } }
```

结论：**不依赖 Lead 的 desktop profile**，从出厂模板 + `plugin add link:` + bundle patch 也能完成装配并真启动；插件装配行 `id=scnet-connect` / `name=dsh-scnet-connect` 生效，`dsh.profile.bundles` 自动追加 `dsh-scnet-connect`。

## 2. 真实 E2E（真实上游 `api.scnet.cn`）

装配：出厂 `headless` profile（`home-e2e/profiles/scnet-e2e`）+ `plugin add link:`，用 `--patch` 只覆盖 `agent-default-model`，**不配置 apiKey**，让插件自己发现客户端凭据。

```powershell
$env:DSH_HOME = 'F:\code\dsh-scnet-connect\.research\verify\home-e2e'
$env:DSH_TOOLS_MODE = 'native'
printf '用 read 工具读取 F:/code/dsh-scnet-connect/package.json，然后只回答该文件的 name 字段值' |
  & $dsh --profile scnet-e2e --patch patch-real.yml --json -
```

### 2.1 纯文本

任务：`只回答两个字：收到`

```json
{"type":"text","text":"收到"}
{"type":"status","phase":"step_end","turn":1,"step":1,
 "usage":{"inputTokens":1909,"outputTokens":2,"totalTokens":6007,"cacheReadTokens":4096}}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
```

### 2.2 工具调用

```json
{"type":"tool_call","callId":"call_00_p4nmlhn8eu0i449by5hf1l99","tool":"read",
 "input":{"file_path":"F:/code/dsh-scnet-connect/package.json"}}
{"type":"tool_result","callId":"call_00_p4nmlhn8eu0i449by5hf1l99","status":"completed",
 "result":"<path>F:\\code\\dsh-scnet-connect\\package.json</path>…(file content)…"}
{"type":"status","phase":"step_start","turn":1,"step":2}
{"type":"text","text":"dsh-scnet-connect"}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
```

两轮 usage：`1931/49/6076 (cacheRead 4096)` → `614/7/6637 (cacheRead 6016)`，说明多轮 tool 消息与 usage 累计都正常。

> **环境注意**：本机 `dsh --profile <p> --json "<含空格的任务文本>"` 在 0.2.1-rc.3 与 0.2.2-rc.1 上都会抛出
> `'D:\Programs\DeepSeek' 不是内部或外部命令`（单字任务文本正常）。这是 CLI 启动器的参数处理问题，**与插件无关**：同一条提示词改用 stdin（最后的 `-`）就 100% 成功。复现：`& $dsh --profile scnet-e2e --json "hello world"` vs `printf 'hello world' | & $dsh --profile scnet-e2e --json -`。

### 2.3 本地 mock 上补充的下发字段断言

为在**不消耗真实额度**的前提下断言请求体，另起一个本地 OpenAI 兼容 mock（`11260`），把插件 `baseUrl` 指过去、`apiKey` 用假 key（`.research/verify/e2e.patch.yml`）。抓到的首轮请求：

```
url=/v1/chat/completions  stream=true  model=SCNet-Max
authorization: Bearer sk-mock-QA-0123456789abcdef   ← 来自插件配置
max_tokens=32768   max_completion_tokens=undefined  ← compat.maxTokensField 正确
reasoning_effort=max  tools=25（create_goal…read…write）
roles=developer/user/user/user
```

工具回路：mock 返回 `tool_calls` → DSH 执行 `glob` → 第二轮请求带 `role=tool` + `tool_call_id` → 返回文本，`turn_end completed`。

## 3. 错误路径

### 3.1 凭据目录不存在（真实 DSH 调用）

patch 把 `credentialDir` 指到不存在的目录、`apiKey` 留空：

```json
{"type":"turn_end","reason":{"kind":"error","error":{"code":"UNKNOWN","message":
"找不到 SCNet 模型服务凭据目录（…no-such-cred-dir）：ENOENT: no such file or directory…。请先打开 SCNet 客户端并登录，正常发起一次模型对话（客户端会自动创建 model-service API Key），或在插件配置里用 apiKey 直接指定。"}}}
```

进程 exit 1，无堆栈、无崩溃；启动阶段仍 `registered: true` 并写出 status 文件（`credential.source = "unavailable"`）。

### 3.2 错误 apiKey（mock 返回 401）

```json
{"type":"turn_end","reason":{"kind":"error","error":{"code":"AUTH","message":
"401: {\"message\":\"Authentication Failed. (request_id: mock-req-1)\",\"code\":\"10001\"…}"}}}
```

- 401 被映射成 `code: AUTH`，信息可读；
- 该轮只产生 2 个请求（主请求 + 标题请求），**没有重试风暴**；
- `grep -c "sk-bad"` 对 stdout/stderr 均为 0，**错误信息不带上游 key**。

### 3.3 凭据文件损坏 / 多份凭据（纯函数单测）

`.research/verify/unit-check.mjs`（12/12 通过）：

| 用例 | 结果 |
| --- | --- |
| 目录不存在 → 抛错且消息含目录路径 | PASS |
| 只有损坏 JSON → 抛「没有可用的 API Key」 | PASS |
| 损坏 + 有效混合 → 取到有效 key（source=client-file） | PASS |
| 多份凭据 → 取 mtime 最新 | PASS |
| 配置 apiKey 优先于文件 | PASS |
| 空目录名 → 回落默认目录（有则返回、无则抛错，不返回空 key） | PASS |
| `maskKey` 空/短/长三种形状都不返回完整 key | PASS |
| 默认描述符 ctx 262144 / max 32768 / `max_tokens` 拼写 | PASS |
| SCNet-Max 超限（1048576/131072）被钳到 262144/32768 | PASS |
| 非 SCNet-Max 模型不钳制 | PASS |
| `inputImages:false` / `reasoning:false` 生效 | PASS |
| `models.json` 缺失 → undefined；存在则覆盖 name/ctx/max，且配置优先 | PASS |

### 3.4 key 泄漏专项

用真实 key 的完整值去 grep 所有输出（不打印 key 本身）：

```
real-text.out/.err, real-tool2.out/.err            contains-full-key=false  contains-prefix8=false
home-e2e/scnet-connect-status.json                 contains-full-key=false  contains-prefix8=true   ← 掩码前 8 位
```

`status` 里只有 `"maskedKey": "sk-NTM4L…MjM="`。仓库跟踪文件 `git grep -nE "sk-[A-Za-z0-9_-]{16,}"` 无命中。

## 4. 思考等级映射（实测逐档）

用 `--patch` 只改 `agentDefaultModel.reasoningEffort`，从抓包读实际下发的 `reasoning_effort`：

| DSH 档位 | 实际下发 | 是否是上游合法值 | 是否与 `docs/scnet-api.md` 的建议一致 |
| --- | --- | --- | --- |
| off | `none` | ✅ | ✅（off→none，实测真关闭） |
| minimal | `low` | ✅ | ❌ 建议原样透传 `minimal` |
| low | `low` | ✅ | ✅ |
| medium | `high` | ✅ | ❌ 建议原样透传 `medium` |
| high | `high` | ✅ | ✅ |
| xhigh | `max` | ✅ | ❌ 建议原样透传 `xhigh` |
| max | `max` | ✅ | ✅ |

即：**7 档被压成 4 档**，不会触发 400（发出去的都是合法值），但用户选的 minimal/medium/xhigh 在上游不具备可区分性。见 §5 QA-2。

## 5. 代码审查（`lib/*.js`）

### 5.1 通过项

| 关注点 | 结论 | 依据 |
| --- | --- | --- |
| key 泄漏 | **无** | key 只出现在 `Authorization` 头；日志/status 走 `maskKey`；错误信息只带路径；401 文案原样透传上游、不含 key（§3.4） |
| 每次请求重读凭据 | **生效** | `auth.resolve()` 与 `adapter.resolveApiKey` 都调 `resolveCurrentApiKey()`；实测断点：真实 E2E 用 `client-file`，mock E2E 用 `config`，切换 patch 即切换来源，无需重启 |
| 单次解析开销 | 可忽略 | `resolveApiKey` 0.47 ms/次、`readClientModelMeta` 0.55 ms/次（200 次均值，28 KB models.json）；相对一次 LLM 往返可忽略，不作为问题 |
| 异常处理 | **合理** | 凭据缺失、文件损坏、注册失败三条路径都有 try/catch，且注册失败只写 status + return，不让 host 崩 |
| 模型元数据 | **与客户端一致** | 客户端目录 `SCNet-Max: ctx 1048576 / max 131072`，但客户端主进程对 scnet-max 特判 `min(ctx,262144)`、`maxTokens=min(…,32768)`；插件 `clampForModel` 同规则，`tools/check.mjs` 也会告警偏差 |
| 请求字段 | **正确** | `compat.maxTokensField='max_tokens'`（抓包 `max_tokens=32768`、`max_completion_tokens=undefined`）；`supportsReasoningEffort` 真的下发 `reasoning_effort` |
| 无谓写文件 | **仅启动写一次** | `writeStatus` 只在 `apply()` 调一次；每请求不落盘 |
| 卸载 | **基本正确** | `ctx.effect` 里调 `registerAdapter` 返回的 disposer；`dsh plugin remove` 会自动把包从 `dependencies` 与 `dsh.profile.bundles` 里摘掉（见 5.2 QA-4 的残留项） |

### 5.2 发现的问题

见 §6 问题清单（QA-1…QA-6）。逐条都给了复现步骤与修法。

## 6. 问题清单

### QA-1（P2）思考等级映射有损：minimal / medium / xhigh 被折叠

- 位置：`lib/scnet-models.js:35-43`（`THINKING_LEVEL_MAP`）
- 现象：`minimal→low`、`medium→high`、`xhigh→max`。上游 7 个值全合法，DSH 也暴露 7 档，但用户选 3 个档位拿到的思考预算与相邻档一致。
- 影响：选择精度丢失；medium 档实际按 high 跑，更慢、思考 token 更多（免费模型不产生费用，但延迟可感知）。README「兼容性 / 已知限制」已如实写明此映射，所以不是隐藏缺陷，但与 `docs/scnet-api.md` §1.4 的建议（`off→none`，其余原样透传）不一致。
- 复现：§4 的逐档抓包表（`medium → high`、`minimal → low`、`xhigh → max`）。
- 建议修法：改成恒等映射即可（键与上游拼写完全同名）：
  ```js
  export const THINKING_LEVEL_MAP = Object.freeze({
    off: 'none', minimal: 'minimal', low: 'low', medium: 'medium',
    high: 'high', xhigh: 'xhigh', max: 'max',
  });
  ```
  同步改 README 的「思考等级映射」一行；`docs/scnet-api.md` 已有服务端对 medium/high 无差异的实测记录，若要保留折叠，至少把 minimal/xhigh 透传。

### QA-2（P2）`lib/scnet-auth.js` 是死代码，且被打进 npm 包

- 位置：`lib/scnet-auth.js`（全文件）
- 证据：全仓库（排除 `.research/`）`grep -rn "scnet-auth"` 零命中；实际用的是 `lib/scnet-credential.js` 里的 `readPlatformAccessToken`。`npm pack --dry-run` 明确列出 `lib/scnet-auth.js`。
- 影响：重复实现 `defaultClientDataDir` / JWT 解码，未来两份实现会漂移；包体多 4.9 KB；读者会误以为存在「登录态认证」路径（实际模型请求只用 model-service key）。
- 建议修法：删除 `lib/scnet-auth.js`（`index.js` 只从 `scnet-credential.js` 取 `readPlatformAccessToken`，删除后无引用断裂）。

### QA-3（P2）npm 包不含 `docs/` 与 `tools/`，README 里的链接与自检命令对 npm 用户失效

- 位置：`package.json` `files: ["lib","cordis.patch.yml","README.md"]`
- 证据：`npm pack --dry-run` 只打包 8 个文件（LICENSE/README/cordis.patch.yml/lib×4/package.json），`docs/scnet-api.md`、`tools/check.mjs` 均不在包内；而 README 有 `[docs/scnet-api.md](docs/scnet-api.md)` 链接、`node tools/check.mjs` 与 `npm run check` 两处命令。
- 影响：从 npm 安装的用户点链接 404、跑自检报 `Cannot find module tools/check.mjs`。仓库内使用不受影响。
- 建议修法（二选一）：
  1. `files` 增加 `"docs"`、`"tools"`（推荐，`tools/check.mjs` 对排障有用，且不含凭据）；
  2. 或在 README 相关段落注明「以下内容仅在仓库内可用，npm 包不包含」。

### QA-4（P2）卸载后 `scnet-connect-status.json` 残留，仍显示 `registered: true`

- 复现（临时 home，勿在 `~/.dsh` 做）：
  ```powershell
  CI=true & $dsh plugin --profile scnet-e2e remove dsh-scnet-connect
  printf '收到' | & $dsh --profile scnet-e2e --json -     # 正常启动，provider 已消失
  ```
  启动成功（只剩 `deepseek-official` 的缺 key 报错，属预期），但 `$DSH_HOME/scnet-connect-status.json` 的 `updatedAt` 保持不变，内容仍是 `registered: true`。
- 影响：卸载后按 README 排障会看到一份「插件已注册」的陈旧快照，误导排障；`node_modules` 里还会留一条悬空符号链接（pnpm 行为，无害）。
- 建议修法：在 `ctx.effect` 的 disposer 里顺手 `fs.rmSync(statusFilePath(), { force: true })`（用 try/catch 包住）；README 补一节「卸载」：
  ```powershell
  & $dsh plugin --profile desktop remove dsh-scnet-connect
  Remove-Item "$env:USERPROFILE\.dsh\scnet-connect-status.json" -ErrorAction SilentlyContinue
  ```

### QA-5（P2）README「安全与隐私」与 `apiKey` 逃生口自相矛盾

- 位置：`README.md` 安全段「API Key **不会**写进 DSH 配置、日志、诊断文件或本仓库」 vs 配置节 `apiKey: ''  # 直接指定 Key`
- 现象：一旦用户按配置节填 `apiKey`，key 就以明文落在 profile 的 `cordis.patch.yml` 里（本机 desktop profile 里已有同类先例：另一 provider 的 `Authorization: "Bearer sk-…"` 就是明文）。Diagnostics/日志确实不泄漏，但「不写进 DSH 配置」这句不成立。
- 建议修法：安全段改为「默认路径下 key 只留在客户端目录，不进 DSH 配置；若使用 `apiKey` 显式配置，key 会以明文存在于 profile 补丁文件中，请自行控制该文件权限」。

### QA-6（P3）两处小冗余

1. `lib/index.js:249-251` 的 `adapter.__rebuild` 从未被调用（全仓库 grep 仅定义处），而 `getModels()` 每次都会 `buildModels()`，该钩子无用 → 建议删除。
2. `statusFilePath()` 固定在 `$DSH_HOME/scnet-connect-status.json`，不区分 profile；同一 `DSH_HOME` 下同时跑 desktop 与 tui 时会互相覆盖，诊断信息失真（本次就出现过 `home-assembly` 与 `home-e2e` 各自独立、但同名文件互相覆盖的情况）。建议命名 `scnet-connect-status.<profile>.json`，或在文件里加 `profile` 字段。

### 附：`readClientModelMeta` 读 `toolCalling` / 忽略 `reasoning`（不计为缺陷，仅记录）

客户端目录里 `SCNet-Max.reasoning = false`、`thinkingMode = "levels"`，插件始终声明 `reasoning: true`（除非配置显式关）。这与 README「元数据优先级：配置 > 客户端目录 > 内置默认」的表述不完全一致（`reasoning` 未从目录读取），但**结果是对的**：上游实际返回 `reasoning_content`，声明 true 才能让 DSH 展示思考等级。建议在 README 元数据段补一句「`reasoning`/`toolCalling` 不从客户端目录读取」，避免读者误解优先级。

## 7. 对交付物 / README 的最小必改项

按「必须修」排序（全部 P2，无 P0/P1）：

1. **QA-1**：`THINKING_LEVEL_MAP` 改为恒等映射（`off→none`），同步 README「兼容性」一行。
2. **QA-2**：删除 `lib/scnet-auth.js`（无引用）。
3. **QA-3**：`package.json` 的 `files` 加 `"docs"`、`"tools"`（或 README 注明仅仓库内可用）。
4. **QA-4**：disposer 里清理 status 文件 + README 增补「卸载」小节。
5. **QA-5**：README 安全段补 `apiKey` 明文的说明。
6. （可选）**QA-6**：删 `__rebuild`、status 文件按 profile 命名。

另外两条与插件无关、但影响复现的环境事项，建议写进 README「故障排查」：

- 当前 runtime 已从 `0.2.1-rc.3` 变为 **`0.2.2-rc.1`**，README「兼容性」只写了 0.2.1-rc.3；本次在 0.2.2-rc.1 上装配 + 真实 E2E 均通过，可一并标注。
- 用 `dsh --json "含空格的任务文本"` 时本机会出现 `'D:\Programs\DeepSeek' 不是内部或外部命令`（CLI 启动器问题，非插件）；改用 stdin（`printf '…' | dsh --profile <p> --json -`）即可，README 的 headless 示例建议改用 stdin 写法。

## 8. 环境事实与偏差记录

| 时间 | 事实 | 影响 |
| --- | --- | --- |
| 09:57 | `dsh --version` = `0.2.1-rc.3` | 装配路径 A 在该版本上验证 |
| 10:11 | `C:\Users\H\.sclaw\agent\` 出现，含 `scnet-credentials/303a5f74….json`（`SCNet-Max` 客户端目录 ctx 1048576/max 131072、`priceLabel: free`） | 真实 E2E 得以执行；此前按简报 C 本应标「未验证」 |
| 10:10 左右 | 安装目录 mtime 变化；10:17 起 `--version` = `0.2.2-rc.1` | 10:13–10:16 的真实 E2E 期间版本无法逐次回放确认；10:15 的全新 profile 启动已确认在 0.2.2-rc.1 上通过 |
| 10:20 | 用 desktop profile 副本在 0.2.2-rc.1 上 `--dump-config-schema` 失败：`@anweat/dsh-browser@0.2.2` 与 dsh 0.2.2-rc.1 不兼容 | **与插件无关**，但意味着桌面 GUI（11256）一旦重启，可能被这个第三方 bundle 卡住；建议先处理 `@anweat/dsh-browser` 版本或移除该 bundle，再重启 |
| 全程 | 11256 的 GUI 未重启/未终止；测试用 11259、11260（mock）、11261 三个端口，结束均已清理 | 无副作用 |

## 9. 复现命令速查

```powershell
$dsh = 'D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$v   = 'F:\code\dsh-scnet-connect\.research\verify'

# 纯函数单测（12 项）
node F:\code\dsh-scnet-connect\.research\verify\unit-check.mjs

# 插件自带自检（本机已有客户端凭据时应全绿）
node F:\code\dsh-scnet-connect\tools\check.mjs

# 全新 profile 装配 + 真启动（端口 11261）
$env:DSH_HOME = "$v\home-web"
& $dsh --profile web-check --from-default-profile web --dump-config
CI=true & $dsh plugin --profile web-check add link:F:\code\dsh-scnet-connect
& $dsh --profile web-check --patch "$v\web-check.patch.yml" --no-open

# 真实 E2E（headless，任务文本走 stdin 规避 CLI 多词参数 bug）
$env:DSH_HOME = "$v\home-e2e"; $env:DSH_TOOLS_MODE = 'native'
printf '用 read 工具读取 F:/code/dsh-scnet-connect/package.json，然后只回答该文件的 name 字段值' |
  & $dsh --profile scnet-e2e --patch "$v\patch-real.yml" --json -

# mock 下发字段断言（另开终端：node $v\mock-scnet.mjs）
& $dsh --profile scnet-e2e --patch "$v\e2e.patch.yml" --json -  <<< '只回答两个字：收到'
```

> `.research/verify/` 被 `.gitignore` 排除，其中的 mock、patch、抓包、日志都不入库，也不会带出任何真实 key。

---

## 10. 整改记录（v0.2.0，2026-11-09）

本报告提出的 4 条必修项（QA-1 ~ QA-4）已在本轮修复；同批还按需求调整了模型发现逻辑并新增设置页。

### 10.1 QA-1 思考等级映射

- 改动：`lib/scnet-models.js` 的 `THINKING_LEVEL_MAP` 改为除 `off→none` 外全部恒等透传
  （`minimal/low/medium/high/xhigh/max` 与上游同名）。
- 验证：`node -e "import('./lib/scnet-models.js').then(m=>console.log(m.THINKING_LEVEL_MAP))"`
  → `{off:'none',minimal:'minimal',low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max'}`；
  真实请求仍走通（`medium` 档下发，见 §10.5）。

### 10.2 QA-2 死代码 `lib/scnet-auth.js`

- 改动：删除该文件（`git rm`），仓库内无任何引用；`npm pack` 不再包含它。

### 10.3 QA-3 npm 包缺 docs/tools

- 改动：`package.json` 的 `files` 增加 `docs`、`tools`。
- 验证：`npm pack --dry-run` 现在列出 `docs/*.md` 与 `tools/check.mjs`、`tools/repro/*`
  （共 29 个文件，unpacked 221 kB）。

### 10.4 QA-4 卸载后 status 残留 `registered: true`

- 改动：诊断快照加入 `pid`；插件 dispose 时若文件里的 `pid` 是本进程，则改写为
  `registered: false` + `disposedAt`。不再直接删除：headless 一次性运行退出时也会 dispose，
  删掉就没法事后排障；按 pid 判断则不会覆盖同一 `DSH_HOME` 下其它 profile 刚写的新快照。
- 验证（临时 home）：
  ```text
  $ printf '只回答两个字：收到' | dsh --profile scnet-e2e --patch patch-multi.yml --json -
  {"type":"text","text":"收到"} … turn_end completed
  $ node -e "console.log(require('./home-e2e/scnet-connect-status.json'))"
  registered: false, disposedAt: 2026-11-09T02:46:41.683Z, pid: 20984
  ```
  README 新增「卸载」小节，说明该行为与手动清理方式。

### 10.5 新增：免费模型自动发现（替代写死 SCNet-Max）

- 新模块 `lib/scnet-catalog.js`：读客户端目录 → 取 `priceLabel === 'free'` → 60 s 内存缓存；
  `refresh()` 强制重读并用 `GET /models` 校验可用性（校验失败不影响本地列表）。
- `lib/index.js` 按目录条目逐个 `buildModel`，注册全部免费模型；新增 `modelIds`
  配置用于显式指定（可含非免费模型），旧 `modelId` 保留为单模型别名。
- 验证（本机当前只有 SCNet-Max 免费）：
  ```text
  $ node tools/check.mjs
  ✓ 共 32 个模型，其中免费 1 个
  ✓ 免费模型：SCNet-Max
  ```
  多模型路径用 `modelIds: 'SCNet-Max,GLM-5.3-Flash'` 验证：请求返回「收到」，
  status 里两条模型分别是 `SCNet-Max · 免费` 与 `GLM-5.3-Flash`。

### 10.6 新增：设置页插件卡片（账号 / 模型 / 刷新）

- 宿主：`/plugins/dsh-scnet-connect/status`（GET）、`/plugins/dsh-scnet-connect/refresh`（POST），
  只返回掩码与元数据，不返回 key。
- 浏览器侧：`lib/client.js`（`dsh.client` + `exports["./client"]`），在 `settings.section`
  上注册「超算互联网」section。
- 验证（隔离实例 11262，Edge 无头真实渲染）：
  ```text
  设置 → 超算互联网：账号 acfb3k2o6j / 135****1024 / 已登录 / Key 掩码 / 1 个免费模型
  点「刷新模型」→ POST /plugins/dsh-scnet-connect/refresh 200，
    「状态更新于」由 10:51:52 变为 10:51:55，控制台无报错
  ```
  截图：`.research/verify/settings-shot2.png`（不入库）。桩件级回归：
  `node .research/verify/client-sim.mjs`（注册、渲染、错误态、刷新点击）。
