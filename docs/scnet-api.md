# SCNet 客户端「免费模型 scnet-max」直连调用方案（逆向结论 + 实测）

> 状态：**已实测跑通**（客户端**不需要**运行，不需要登录态 Cookie）。
> 对象：本机 `D:\Program Files\scnet-client\`（Electron 客户端「计算服务」v4.1.0，commit 8363e92）。
> 验证时间：2026-11-09（Asia/Shanghai）。作者：scnet-recon。

---

## 0. TL;DR

| 项 | 结论 |
|---|---|
| 协议 | **OpenAI Chat Completions 兼容**（`openai-completions`），SSE 流式 |
| Base URL | `https://api.scnet.cn/api/llm/v1` |
| 端点 | `GET /models`、`POST /chat/completions` |
| 鉴权 | `Authorization: Bearer sk-...`（模型服务 API Key，43 字符，本机已落盘） |
| Key 位置 | `C:\Users\<user>\.sclaw\agent\scnet-credentials\<identityHash>.json` → `{"scnet":{"type":"api_key","key":"sk-..."}}` |
| Provider 配置 | `C:\Users\<user>\.sclaw\agent\models.json` → `providers.scnet`（baseUrl/api/authMode/modelListMode/models） |
| 模型 id | `SCNet-Max`（大小写不敏感；客户端内部常量同时也是 `"scnet-max"` 小写形式） |
| 模型能力 | text+image 输入、tool calling、thinking（`reasoning_content`）、1,048,576 ctx / 131,072 max output |
| 计费 | `priceLabel: "free"`，客户端 UI 文案为「**限时免费**」（不是永久免费） |
| 客户端是否常驻 | **否**。Key 是平台长期 API Key，客户端关闭后仍可用（已实测） |
| 其它免费模型 | 否。32 个可见模型里只有 `SCNet-Max` 的 `priceLabel` 是 `free`（其余为 `none` / `special`） |

**最小可用调用**（可直接照抄，详见 §1）：

```js
const KEY = JSON.parse(fs.readFileSync(credFile,'utf8')).scnet.key;
const res = await fetch('https://api.scnet.cn/api/llm/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'SCNet-Max',
    messages: [{ role: 'user', content: '你好' }],
    max_tokens: 256,
  }),
});
// 200: choices[0].message.content + choices[0].message.reasoning_content + usage
```

---

## 1. 怎么调用（可直接抄的 Node 片段）

### 1.1 定位凭据与配置

客户端把「模型服务凭据」托管在 pi/scnet agent 运行时目录（**不是** `%APPDATA%\scnet-client`）：

- 凭据目录：`~/.sclaw/agent/scnet-credentials/`（Windows 下即 `C:\Users\<user>\.sclaw\agent\scnet-credentials\`）。
  - 文件名为账号 identity 哈希（本机为 `303a5f74e62126ad2fc46e60.json`，24 位 hex）。
  - 内容（实测，key 已脱敏）：
    ```json
    { "scnet": { "type": "api_key", "key": "sk-<REDACTED>" } }
    ```
- Provider 配置：`~/.sclaw/agent/models.json` → `providers.scnet`：
  ```json
  {
    "name": "超算互联网",
    "baseUrl": "https://api.scnet.cn/api/llm/v1",
    "api": "openai-completions",
    "authMode": "api-key",
    "modelListMode": "automatic",
    "models": [ { "id": "SCNet-Max", "priceLabel": "free", "input": ["text","image"],
                  "contextWindow": 1048576, "maxTokens": 131072,
                  "toolCalling": true, "thinkingMode": "levels", ... } ],
    "visibleModelIds": [ ... 32 项 ... ]
  }
  ```

> 跨平台兜底：`~/.sclaw` 可由环境变量 `SACP_SMOKE_AGENT_HOME` 覆盖（`app.asar` 内 `~/.sclaw` 路径逻辑见 §5 证据 E3）。
> 插件实现建议：**优先读 `models.json` 拿 baseUrl/模型清单，再在 `scnet-credentials/*.json` 中任选一个含 `scnet.api_key` 的文件读 key**；不要写死 hash 文件名（换账号会变）。

### 1.2 非流式（实测输出）

脚本：`tools/repro/direct-verify.mjs`（`node tools/repro/direct-verify.mjs chat`）。
实测请求/响应（key 已脱敏）：

```json
// POST https://api.scnet.cn/api/llm/v1/chat/completions
{
  "model": "SCNet-Max",
  "messages": [{ "role": "user", "content": "用一句话回答：1+1 等于几？" }],
  "max_tokens": 128
}
```
```json
// HTTP 200
{
  "id": "…", "object": "chat.completion", "model": "SCNet-Max",
  "choices": [{
    "index": 0, "finish_reason": "stop",
    "message": {
      "role": "assistant",
      "content": "1+1等于2。",
      "reasoning_content": "We need answer in Chinese one sentence. \"1+1等于2。\" Should comply one sentence.",
      "provider_specific_fields": {}
    }
  }],
  "usage": {
    "completion_tokens": 27, "prompt_tokens": 41, "total_tokens": 68,
    "completion_tokens_details": { "reasoning_tokens": 20 },
    "prompt_tokens_details": { "cached_tokens": 0 }
  },
  "service_tier": "default"
}
```

### 1.3 流式 SSE（实测原始片段）

`POST` 同一端点，body 加 `"stream": true`，响应头 `content-type: text/event-stream`，每行 `data: {…}`，结尾 `data: [DONE]`。
完整原始流见 `.research/scnet-probe/05-stream-raw.txt`、`.research/scnet-probe/07-tools-stream-raw.txt`。

```
data: {"id":"…","created":1794159468,"model":"SCNet-Max","object":"chat.completion.chunk",
       "choices":[{"index":0,"delta":{"reasoning_content":"","content":"","role":"assistant"}}],"service_tier":"default"}

data: {"…","choices":[{"index":0,"delta":{"reasoning_content":"We","content":""}}],"service_tier":"default"}
…（思考流）
data: {"…","choices":[{"index":0,"delta":{"reasoning_content":"","content":"1"}}],"service_tier":"default"}
…（正文流）
data: {"…","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: {"…","choices":[{"index":0,"delta":{}}],"usage":{"completion_tokens":49,"prompt_tokens":37,"total_tokens":86,
       "completion_tokens_details":{"reasoning_tokens":43},"prompt_tokens_details":{"cached_tokens":0}}}
data: [DONE]
```

要点：思考过程在 `delta.reasoning_content`，正文在 `delta.content`，两者可能交替；**末尾单独一帧带 `usage`**（部分中继产品会丢这帧，插件应容忍）。

### 1.4 思考强度（`reasoning_effort`，实测合法集合与效果）

- **默认（不带该字段）= 开启思考**（会返回 `reasoning_content`）。
- 合法值只有：`none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`。
- `none` = **关闭思考**（实测 `reasoning_tokens=0`，且不再输出 `reasoning_content`）。
- 其它任何值（`off`/`disabled`/`on`/`default`/`auto`/`bogus`/带尾空格）→ HTTP 400，`code:"10013"`。

实测（同一道题、`max_tokens=1024`，取 `usage.completion_tokens_details.reasoning_tokens`）：

| reasoning_effort | HTTP | reasoning_tokens | 总 completion_tokens |
|---|---|---|---|
| `none` | 200 | 0 | 2 |
| `minimal` | 200 | 32 | 35 |
| `low` | 200 | 52 | 55 |
| `medium` | 200 | 84 | 87 |
| `high` | 200 | 84 | 87 |
| `xhigh` | 200 | 48 | 50 |
| `max` | 200 | 189 | 191 |

> 结论：服务端**接受**这 7 个值，`high` 与 `medium` 在该题上无差异，`max` 明显更长；`xhigh` 反而短（服务端映射不严格）。客户端 `models.json` 中 SCNet-Max 的 `reasoning:false`，说明官方客户端**并不主动**发送 `reasoning_effort`（靠服务端默认思考）；DSH 插件可自行映射（建议：off→`none`，minimal/low/medium/high/xhigh/max 原样透传）。
> 另测：`thinking:{type:"disabled"}`、`enable_thinking:false`、`thinking:{type:"enabled"}` 均**被忽略**（仍会思考），只有 `reasoning_effort:"none"` 有效。

### 1.5 工具调用（实测，非流式与流式都可用）

非流式请求里 `tools` 为 OpenAI 标准 function schema；响应 `finish_reason:"tool_calls"`：

```json
{
  "choices":[{
    "finish_reason":"tool_calls",
    "message":{
      "role":"assistant","content":"","reasoning_content":"",
      "tool_calls":[{"id":"call_00_…","type":"function",
                     "function":{"name":"get_weather","arguments":"{\"city\": \"杭州\"}"}}]
    }
  }],
  "usage":{"completion_tokens":39,"prompt_tokens":306,"total_tokens":345,
           "prompt_tokens_details":{"cached_tokens":256}}
}
```
流式时 `delta.tool_calls` 逐片到达（带 `index`，`function.arguments` 是**分片的 JSON 字符串**，需按 index 累积）：

```
data: {"…","choices":[{"delta":{"content":"","tool_calls":[{"id":"call_00_…","type":"function","index":0,
       "function":{"arguments":"","name":"get_weather"}}]}}]}
data: {"…","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}}]}
data: {"…","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\""}}]}}]}
…
```
工具结果回传就是标准 OpenAI 消息：`{"role":"assistant","content":null,"tool_calls":[…]}` + `{"role":"tool","tool_call_id":"call_1","content":"…json…"}`（实测 HTTP 200，正确利用工具结果作答）。
**客户端对 SCNet-Max 强制 `parallel_tool_calls:false`**（见 §5 证据 E8），插件建议同样置 false。

### 1.6 图片输入（实测）

`content` 用 OpenAI 多模态数组，`image_url.url` 用 data URL（实测 200，识别出纯色图颜色「红色」）：

```json
{"role":"user","content":[
  {"type":"text","text":"这张图是什么颜色？只答颜色"},
  {"type":"image_url","image_url":{"url":"data:image/png;base64,<…>"}}
]}
```

### 1.7 其它可选参数

- `max_tokens` 生效（按 131072 上限）；`stream` 生效。
- 响应含 `service_tier:"default"`、`provider_specific_fields:{}`、`id` 为 `hex-timestamp` 形式，快照可用于日志。
- 未验证（不影响 DSH 接入）：`temperature`/`top_p`/`seed`/`response_format`/`stream_options`；OpenAI 兼容实现通常接受，但 SCNet 文档未公开，插件应避免依赖。

### 1.8 客户端未运行时的验证方式

**模型调用不依赖客户端进程**。验证命令（客户端关闭状态下已实测通过）：

```powershell
node tools/repro/scnet-chat.mjs            # 非流式，打印 reasoning + content + usage
node tools/repro/scnet-chat.mjs --stream   # 流式 SSE
node tools/repro/direct-verify.mjs         # 全量探针（models/effort/stream/tools/坏 key/并发）
```

若返回 `401 Authentication Failed`：说明本机凭据被平台删除/账号失效，需要**启动并登录一次 SCNet 客户端**（`D:\Program Files\scnet-client\计算服务.exe`），客户端会走 §4 的刷新链路重建 `~/.sclaw/agent/scnet-credentials/*.json`；之后本方案即可继续使用（无需保持客户端常驻）。

---

## 2. 鉴权：两种"token"必须区分

| | 模型服务 API Key（本方案用） | 平台会话 JWT（不要混用） |
|---|---|---|
| 形态 | `sk-` + base64，43 字符；解码为 `<keyId>-<userId>-<createdAtMs>` | HS256 JWT，243 字符；payload：`{"creator":"ac","role":"1","invoker":"ac_client","user":"<userName>","userId":"<id>","expireTime":"<ms>"}` |
| 位置 | `~/.sclaw/agent/scnet-credentials/*.json` | `%APPDATA%\scnet-client\config.json` → `accessToken` |
| 用途 | **LLM API**：`api.scnet.cn/api/llm/v1/*`，`Authorization: Bearer sk-…` | **平台 API**：`www.scnet.cn/acx/*`（`Token: <jwt>` + `Cookie`），用于创建/查询 Key、账号状态等 |
| 生命周期 | 长期，直到平台删除/账号停用；客户端重建时可能换新 | 有 `expireTime`（本机示例 ≈ 2026-11-15 到期），由客户端登录/刷新维护 |
| 能否独立签发 | 不能（需要平台会话 Cookie，见 §4） | 不能（需要客户端登录） |

实测：**只带 `Authorization: Bearer <sk-key>` + `Content-Type: application/json`** 即可调通，无需 Cookie、租户 header、签名、version header。
无效 key → `HTTP 401`：
```json
{"error":{"message":"Authentication Failed (request_id: 6f5c…-20261109013928162)","type":"invalid_request_error","param":null,"code":"401"},"request_id":"…"}
```

> 注意：用 JWT 直接调 `https://www.scnet.cn/acx/llm/api-key/createActivityApiKey`（只带 `Token` 头、无 Cookie）实测返回 **401 `{"code":"401","msg":"用户未登录!"}`**。平台 `acx` 接口依赖登录时下发的 Cookie（内存 CookieJar，不落盘；`%APPDATA%\scnet-client\Network\Cookies` 里也没有 Token cookie）。→ **插件不能"自己在外部新建 key"**，只能读客户端已落盘的 key（或驱动客户端刷新）。

---

## 3. 模型清单与「免费」含义

`GET /models`（实测 33 个 id，比客户端 models.json 多一个 embedding）：

```
DeepSeek-V4.1-Flash-1017, Kimi-K3.1-Pro, Kimi-K3.1-Pro-Highspeed, GLM-5.3-Flash,
MiniMax-M3.1-Flash, Qwen3.8-Flash, GLM-5.3, MiniMax-M3, DeepSeek-V4.1-Flash, Kimi-K3,
DeepSeek-V4-Pro-0813, Qwen3.8-Max, DeepSeek-V4-Flash-0731, GLM-5.2, Spark-X2.5, GLM-5.1,
Qwen3.7-Max, Kimi-K2.7-Code, Kimi-K2.6, Kimi-K2.5, GLM-5, MiniMax-M2.7, MiniMax-M2.5,
Qwen3.7-Plus, Qwen3.6-Plus, Qwen3.6-Flash, Qwen3.6-27B, Qwen3.5-122B-A10B, MiMo-V2.5-Pro,
Qwen3-235B-A22B, SCNet-Max, GLM-5.2-Base, Qwen3-Embedding-8B
```
`GET /models` 单项结构极简：`{"id":"…","object":"model","ownedBy":"system"}`（没有上下文/价格/能力信息，这些只在客户端 models.json / 平台模型目录里）。

**`priceLabel` 语义**（来自客户端源码/UI 文案，证据见 §5 E9）：
- `"free"` → 模型选择器显示「**限时免费**」（英：`Free for a limited time`）。**当前只有 `SCNet-Max` 是 free**。
- `"none"` → 不显示价格标签（普通按量计费模型）。
- `"special"` → 特殊计费（`Qwen3-235B-A22B`、`GLM-5.2-Base`）。
- 结论：**免费模型仅 SCNet-Max，且是"限时"免费**，随时可能变更；不能当作永久免费能力对外承诺。

`SCNet-Max` 元数据（`models.json` 实测）：
```json
{ "id":"SCNet-Max","name":"SCNet-Max","priceLabel":"free","toolCalling":true,
  "reasoning":false,"thinkingMode":"levels","input":["text","image"],
  "contextWindow":1048576,"maxTokens":131072,
  "tags":["文本生成","深度思考"],"logoUrl":"https://cdn.scnet.cn/assets/images/icr/SCNet-Max.jpg" }
```
> 注意两套上限并存：`app.asar` 里还有一处硬编码对 `scnet` provider 的 `SCNet-Max` 做 `contextWindow=min(ctx,262144)`、`maxTokens=min(max,32768)`（见证据 E5 `C()`），但**平台实际下发/实测可用的是 1048576 / 131072**。插件展示建议用平台值，请求时按需限制输出长度以控时延。

---

## 4. 凭据生命周期（插件"只读这个 key"是否够稳？）

### 4.1 Key 是怎么来的（客户端行为）

`app.asar` 中 `scnet` provider 的凭据刷新逻辑（证据 E4/E6）：

1. 客户端先调平台 API（`www.scnet.cn` + `Token: accessToken` + `Cookie`）创建/复用模型服务 Key：
   - `POST /acx/llm/api-key/createActivityApiKey` `{}` —— 优先返回"活动/免费额度"Key；
   - 若返回 `providerCode: "API010010"`，回退到团队账号 Key：
     `GET /acx/user/users/cluster-user-detail` → 取 member 账号（`accountId/groupId/userId`），
     `POST /acx/llm/api-key/query`（`apiKeyName = scnet-client-member-<createUser>`，`serviceType:"model"`）
     → `GET /acx/llm/api-key/detail?id=…` 取明文 key；不存在则 `POST /acx/llm/api-key/create`
     （`serviceTypes:["model"]`, `accessibleModelScope:"ALL"`）。
2. 把结果写入账号作用域凭据库：`{ "scnet": { "type":"api_key", "key":"sk-…" } }`
   → `~/.sclaw/agent/scnet-credentials/<identityHash>.json`（目录/文件权限 0700/0600）。
3. provider 注册时 baseUrl = `"https://api.scnet.cn/api/llm/v1"`（去掉末尾 `/`），api = `openai-completions`。

### 4.2 什么时候刷新/重建（触发点，证据 E6/E7）

- **启动/空闲**：`onLifecycleIdle → scheduleScnetCredentialRefresh()`；
- **账号变化**：监听 `userInfo` 变化 → `refreshRequests.add("credentials")`；`accessToken` 变化只使执行权限失效，不重建 key；
- **用户手动授权**：RPC `providers.authorize-platform-models` → `refreshScnetCredentialAfterAccountChange()`；
- **请求 401**：`createScnetModelStream` 的自定义 `fetch` 包装器捕获 401 → 重新走上面的创建链路**重试一次**；若拿到的新 key 仍 401 → 清空凭据并抛「SCNet 登录已失效，请重新登录。」（`auth.session_expired`）。
- 平台侧限制：账号停用 → `API010013`（客户端文案：`您的账号已停用，暂不支持使用平台模型服务…`）；模型服务未开通 → `模型服务尚未开通`，客户端会调 `GET /llm/account/config/status` / `POST /llm/account/config/authorize` 自动开通（证据 E10）。

### 4.3 稳定性证据（实测）

- `scnet-credentials/303a5f74e62126ad2fc46e60.json` 创建/修改时间 = `2026-11-08T16:06:57Z`（首次运行）；
- key 内嵌时间戳解码 = `2026-11-08T16:06:56Z`，已知客户端之后又启动过（`Network`/`Cookies` 更新于 11-09 00:04/00:12），但**该文件 mtime 未变** → 客户端"创建/查询后值相同则不落盘"（凭据提交按 JSON 差异写）。
- 客户端进程当前**未运行**，直连仍 200 → key 不依赖客户端常驻/内存态。

**结论**：插件只读该 key **足够稳**（同一账号下长期有效，客户端只在必要时轮换/改写文件）。插件应：
1. 每次调用前重新读文件（或缓存 + 401 时重读），不要缓存整进程生命周期；
2. 401 时重读一次文件再重试一次；仍 401 → 提示用户「启动/登录 SCNet 客户端以刷新凭据」；
3. 不要缓存/打印 key，不要写回该目录。

---

## 5. 错误码 / 限流 / 并发（实测 + 客户端源码映射）

### 5.1 实测

| 场景 | HTTP | body 要点 |
|---|---|---|
| 正常 | 200 | 见 §1 |
| 无效 `sk-` key | 401 | `{"error":{"message":"Authentication Failed (request_id: …)","type":"invalid_request_error","code":"401"}}` |
| 非法 `reasoning_effort` | 400 | `{"error":{"message":"Invalid request parameters. (request_id: …)","code":"10013"}}` |
| 8 并发小请求（thinking off） | 200×8 | 总耗时 2.76s，无 429 |
| 16 并发小请求 | 200×16 | 总耗时 1.96s，无 429 |
| 4 并发普通请求 | 200×4 | 1.4–2.2s，无 429 |

→ **SCNet-Max 在当前量级没有暴露 429/RPM 门槛**。仍建议插件做并发上限（2–4）与 429/5xx 退避，避免平台后续收紧。

### 5.2 客户端对 provider 错误的归类（证据 E11，`app.asar` 内映射表）

- `402` / `INSUFFICIENT_BALANCE` / `QUOTA_EXCEEDED` / `BILLING_HARD_LIMIT_REACHED` / `BILLING_NOT_ACTIVE` → `remote.quota_exceeded` / `model.quota_exceeded`
- `429` / `10011` / `LIMIT_BURST_RATE` / `RATE_LIMIT_EXCEEDED` / `RATE_LIMIT_ERROR` → `remote.rate_limited` / `model.rate_limited`
- `10007` / `REQUEST_CONCURRENCY_CONFLICT` → `remote.concurrency_limited`
- `10010` / `CONTENT_ILLEGAL` → `remote.content_rejected`
- `10013` / `INVALIDPARAMETER` → `invalid_argument`（本次实测命中）
- `401` → `auth.authentication_failed`；`403` → `auth.permission_denied`；`408/504` → `network.timeout`；`502/503` → `remote.service_unavailable`
- 客户端 provider 层对上述"可重试"错误有一次/有限重试策略；插件侧建议：`401` 重读凭据重试 1 次；`429/5xx` 指数退避（≤3 次）；`400/402/10007/10010/10013` 直接失败并展示。

### 5.3 免费额度/RPM 备注

- 平台模型描述里出现过「RPM预设为50」（`DeepSeek-V4-Pro-0813`，见 `models.json` description），说明平台有 RPM 预设概念，但 **SCNet-Max 未标注 RPM**。
- 免费模型的额度限制由平台账号策略控制，客户端代码中没有写死 SCNet-Max 的额度值（未找到常量）。

---

## 6. asar 证据索引（文件、偏移、片段）

> 抽取产物：`.research/scnet-asar/`（`tools/repro/asar-extract.mjs` 自写解析器，asar 头 = `u32(4) + u32(headerSize)`，JSON 从 offset 16 开始；135,829,495B → 1,369 个文本文件 / 70,285,956B）。
> 主进程 bundle：`.research/scnet-asar/dist-electron/main/index.js`（1,796,846B 单行 minified）；pi-ai 运行时 bundle：`dist-electron/main/b.js`；渲染层：`dist/static/js/**`。

| # | 证据 | 位置 | 片段/说明 |
|---|---|---|---|
| E1 | 模型 id 大写常量 | `index.js` @687737 | `let j="scnet",q="SCNet-Max"`；`I=new Set([...,"scnet-max",...])`；`A(e)` 按小写集合决定 input 模态 |
| E2 | provider 定义 + base URL | `index.js` @688619 / @1723680 / @695527 | `D={id:"scnet",name:"超算互联网",api:"openai-completions"}`；`P()` 返回 `"https://api.scnet.cn/api/llm/v1/"`（`www.scnet.cn` 时）；注册时 `baseUrl:(0,b.w0)().replace(/\/$/u,"")` |
| E3 | 凭据目录/账号作用域 | `index.js` @649989 / @1063270 | `scnetCredentialDir: join(agentDir,"scnet-credentials")`；`getAccountPath:e=>join(credentialDir,`${e}.json`)`, `scopedProviderId:"scnet"`；`agentDir` 来自 `~/.sclaw/agent`（可由 `SACP_SMOKE_AGENT_HOME` 覆盖） |
| E4 | 平台创建 Key 链路 | `index.js` @1311970 | `POST /llm/api-key/createActivityApiKey` → `API010010` 回退 `cluster-user-detail` + `api-key/query|detail|create`（`apiKeyName: scnet-client-member-<createUser>`） |
| E5 | SCNet-Max 参数特判 | `index.js` @677692 / @687737 | `C()`：scnet 的 `scnet-max` 取 `min(ctx,262144)`、`maxTokens=min(...,32768)`；`L()`：`reasoning: !isScnetMax && …`、`maxTokens:131072` |
| E6 | 401 刷新 + 重试一次 | `index.js` @1284671（模块 `Fw`/`zu` 的 `createScnetModelStream`） | 自定义 `fetch`：只设 `Authorization: Bearer <api_key>`；401→取新 key→重试；再 401→清凭据抛 `auth.session_expired` |
| E7 | 刷新触发点 | `index.js` @1264579 / @1267478 / @1272369 | `onLifecycleIdle→scheduleScnetCredentialRefresh`；`userInfo` 变化→`refreshRequests.add("credentials")`；`refreshScnetCredentialAfterAccountChange` |
| E8 | SCNet-Max 强制串行工具 | `index.js` @1689049 | `if(api==="openai-completions" && /^(?:gpt-|SCNet-Max)/i.test(id) && hostname 匹配 scnet.cn) payload.parallel_tool_calls=false` |
| E9 | priceLabel UI 文案 | `dist/static/js/async/9.4d8ee17dc5.js` @25162 / `dist/static/js/qe.e76cc4e81e.js` @239370,498284 | `"free"===model.priceLabel` → i18n `freeLimited`；zh：「限时免费」，en：「Free for a limited time」；thinking levels：`off/minimal/low/medium/high/xhigh/max` |
| E10 | 模型服务授权检查 | `index.js` @691244 / @691922 | `GET /llm/account/config/status?accountId=` → `modelServiceEnabled`；`POST /llm/account/config/authorize?accountId=` 自动开通 |
| E11 | 错误码映射 | `index.js` @398528 | 402/quota、429/10011、10007 并发、10010 内容、10013 参数 的 providerCode→error code 映射 |
| E12 | 平台 API 客户端 | `index.js` @1075 | axios `baseURL=(0,u.gU)()`（默认 `https://www.scnet.cn`），默认 headers `source: Electron`、`version: <appVersion>`；`/acx` 前缀拼接见 @653734 `y()`：`url: e.url.startsWith("/acx/")?e.url:`/acx${e.url}``，并写 `Cookie` + `Token` 头 |
| E13 | 免费/付费之外：模型目录发现 | `index.js` @693678 / @1311970 | 客户端从 `GET /acx/llm/api/console/model` 拉取模型目录（id/description/logo/priceLabel/输入模态等），写入 `models.json` |

**可复现脚本与原始输出**：
- `tools/repro/asar-extract.mjs` —— asar 抽取（本任务自写，不依赖 @electron/asar）
- `tools/repro/search-asar.mjs` / `slice-asar.mjs` —— 大型单行 bundle 的正则检索/切片
- `tools/repro/direct-probe.mjs` —— Lead 的最小直连探针
- `tools/repro/direct-verify.mjs` —— **本报告主验证脚本**（models / 非流式 / effort 网格 / SSE / tools / 坏 key / 并发）
- `tools/repro/effort-burst.mjs` —— effort 合法值与 token 数、8 并发
- `tools/repro/image-tools-burst.mjs` —— 图片、工具回传、16 并发
- `tools/repro/probe-scnet.mjs` —— 反面验证：只带 JWT、无 Cookie 调平台 `acx` → 401「用户未登录!」
- 原始响应（`.research/scnet-probe/`）：`01-models.json`、`02-chat-plain.json`、`03-effort-grid.json`、`04-thinking-variants.json`、`05-stream-raw.txt`、`05-stream-status.txt`、`06-tools-nonstream.json`、`07-tools-stream-raw.txt`、`08-bad-key.json`、`09-concurrency-4.json`、`10-image-input.json`、`11-tool-followup.json`、`12-burst16.json`、`99-summary.json`

---

## 7. 风险与注意事项（给 Lead/插件实现的硬约束）

1. **未公开 API**：`api.scnet.cn/api/llm/v1` 是客户端内部使用的接口，无公开文档/兼容性承诺；客户端升级（现 4.1.0）可能改路径/协议/模型 id。所有 endpoint、字段都应集中配置，便于升级时改一处。
2. **"免费"是限时的**：`SCNet-Max` 仅 `priceLabel:"free"` → UI「限时免费」。不要在产品文案承诺永久免费；建议插件在模型描述里如实标注「SCNet 客户端内免费模型（限时）」。
3. **凭据敏感**：`sk-…` 等同于账号模型服务权限。插件必须：只读、不打印、不写日志、不上传；不要把它写进 `~/.dsh` 明文配置或仓库。读取失败时给出清晰指引（先启动客户端登录一次）。
4. **~~不能自建 key~~（已推翻，见 §9）**：早期结论是「平台 `acx` 接口需要登录 Cookie（内存态、不落盘），仅凭 `config.json` 的 JWT 会 401，插件只能消费客户端已落盘的 key」。**这个结论只对了一半**：JWT 不能直接当 Cookie 用（`Token: <jwt>` 头、`Cookie: Token=<jwt>` 都是 401），但 JWT 可以通过平台自己的接口换到真正的会话 Cookie：
   - `POST /ac/api/auth/loginDesktopClientByToken.action`（表单 `desktopToken=<jwt>&sensors_anon_id=&type=tokenLogin`）→ 200 + `Set-Cookie: jsessionid=…; Token=…`；
   - 拿到 Cookie 后 `POST /acx/llm/api-key/createActivityApiKey`（**必须 `Content-Type: application/json` + body `{}`**）即可拿到 `sk-` key，实测与客户端落盘的 key 是同一个。

   因此「免客户端登录」在平台侧是成立的，实现见 §9 与 `lib/scnet-platform.js` / `lib/scnet-web-login.js`。
5. **账号/权限门槛**：账号停用（`API010013`，文案「您的账号已停用…」）、模型服务未开通（客户端会自动 authorize；外部无法代劳）都会导致 401/不可用。
6. **JWT 有效期**：`config.json.accessToken` 的 `expireTime` 是会话级（本机示例 ≈ 2026-11-15）。它不影响 sk-key 调用；但客户端刷新 key 需要有效会话，故长期不用客户端可能导致客户端侧无法自动续期（届时重新登录即可）。
7. **并发**：当前实测 16 并发无 429，但平台有 `10007/REQUEST_CONCURRENCY_CONFLICT`、`10011/LIMIT_BURST_RATE` 错误码。插件默认并发 ≤2–4，遇 429/10007 退避重试并提示。
8. **`reasoning_effort` 取值严格**：非法值直接 400（不是忽略），DSH 侧思考等级映射务必只输出 7 个合法值之一；`off` 必须映射成 `reasoning_effort:"none"`（不能用 `off`/`thinking:disabled`）。
9. **SSE 解析**：`reasoning_content` 与 `content` 双通道、末帧 `usage` 可能缺失、`[DONE]` 收尾；工具参数按 `index` 分片累积。不要假设"第一段 delta 一定有内容"。
10. **许可证/ToS**：客户端 `package.json` 标注 `license: MIT` 但这是应用元数据，不代表授权第三方接入其云端模型服务；对外分发插件前应由用户确认《超算互联网用户协议》与免费活动条款。本方案仅做本机个人使用的互操作。
11. **实现建议**（给 Lead 的 provider 参数）：`baseUrl=https://api.scnet.cn/api/llm/v1`、`api=openai-completions`、`model=SCNet-Max`、`Authorization: Bearer <key from ~/.sclaw>`、`parallel_tool_calls=false`、`max_tokens` 默认 8k–32k 以内、thinking 等级映射到 7 档、非流式与流式都支持、`401` 时重读凭据一次。

---

## 8. 对原始线索的校正（调用链路到底怎么走）

任务给了几条线索，实测结论如下，避免后续实现走弯路：

1. **`resources/cli/index.js` + `SCNET_CLIENT_CLI_DESCRIPTOR` named-pipe RPC 与模型调用无关**。
   该 CLI 只注册了只读诊断命令 `version / status / doctor / task inspect / task diagnose / logs tail`（`resources/cli/index.js` 末尾 `createInstalledCli()`，RPC method 为 `cli.status`、`cli.doctor`、`cli.task.inspect`、`cli.task.diagnose`、`cli.logs.tail`），底层是主进程 named pipe（`SCNET_CLIENT_CLI_DESCRIPTOR` → `{protocolVersion,socketPath,token,pid}`）。
   模型调用**不走**这个 RPC，也不需要 `host.invoke`。
2. **客户端主进程没有为模型提供本地 HTTP 端口**（没有 `listen` 的 LLM 服务）。唯一与"本地端点"有关的是 dev 构建的 `dev.http-endpoint.attach/readback`（临时把 `scnet-llm` 指向 loopback fixture，用于开发调试，正式构建不可用）。
3. **真实链路**：渲染层 UI → 主进程 pi agent 运行时（`app.asar` 内 `openai-completions` provider，`createScnetModelStream` 包一层鉴权 `fetch`）→ **HTTPS 直连 `https://api.scnet.cn/api/llm/v1/chat/completions`**。因此对 DSH 插件而言，最稳的接入点就是**同样的 HTTPS OpenAI 兼容直连**（§1），完全绕开客户端 UI/RPC。
4. **asar 中的 `scnet-max`**：主进程 `dist-electron/main/index.js` 有 3 处（模型 id 特判、参数上限特判、input 模态集合）；渲染层有 3 个 chunk（`dist/static/js/async/9x.361426ac1e.js`、`9.4d8ee17dc5.js`、`vq.f6f428b12f.js`，用于会话任务埋点/模型选择器）。它们只是"模型目录/UI 逻辑"，不是 endpoint 定义；endpoint 由 `baseUrl` 常量 + `models.json` 决定（证据 E2）。

---

## 9. 免客户端登录（零客户端路径，v0.3.0 起）

目标：**不安装、不运行 SCNet 桌面客户端**也能拿到 `sk-` key。

### 9.1 平台登录态到底是什么

模型网关（`api.scnet.cn/api/llm/v1`）只认 `Authorization: Bearer sk-…`，而 `sk-`
只能由平台（`www.scnet.cn`）签发；平台认的是登录时下发的**一对 Cookie**：

| Cookie | 含义 | 实测说明 |
| --- | --- | --- |
| `jsessionid` | 平台会话 | 登录后 32 位十六进制 |
| `Token` | 平台令牌 | 登录后 48 字符；**不是** `config.json` 里那个 JWT |

踩过的坑（都已实测复现）：

- `Token: <jwt>` 请求头 → 401 `{"code":"401","msg":"用户未登录!"}`
- `Cookie: Token=<jwt>` → 同样 401（JWT 不是 Cookie 值）
- 只补 `source: Electron` / `version: 4.1.0` 等客户端头 → 仍 401，Cookie 缺一不可

### 9.2 三条登录通道（全部实测）

**A. 桌面 JWT → 会话 Cookie（`lib/scnet-platform.js` 的 `exchangeJwt`）**

```text
POST https://www.scnet.cn/ac/api/auth/loginDesktopClientByToken.action
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
body: desktopToken=<jwt>&sensors_anon_id=&type=tokenLogin
→ 200 {"code":"0","data":{userName,id,X-Jwt-Access-Token,…}}
   + Set-Cookie: jsessionid=…; Token=…
```

注意：**必须是表单编码**。发 JSON 会得到
`{"msg":"params not enough: [desktopToken] is null","code":"1003"}`。

**B. 网页短信登录（`lib/scnet-web-login.js`，插件只用这一条）**

端点和参数取自平台自己的前端（`/ui/acm/index.html` → `assets/Login-*.js`）：

```text
POST /sso/captcha.action                     → {"code":"0","data":"data:image/jpeg;base64,…"}
POST /sso/sendRegisterMessageCode.action     → 发短信验证码（必须带 captcha）
POST /sso/auth/login.action                  → {"code":"0","data":"<跳转地址(带 ticket)>"}
    表单：service（必填，= <平台>/ac/api/auth/loginSsoRedirect.action）、originalUrl、
          sensorsAnonId、captcha、mobilephoneNum(+86…)、messageCode、mode=2
```

**发码成功判定（重要）**：平台前端对 `/sso/sendRegisterMessageCode.action` 写的是
`validateCode: ["0","1004"]`，即 `code === "0"` **或** `code === "1004"` 都算成功。
`1004` 的语义是「该手机号已注册」——对登录来说完全正常（平台会切到「快捷登录」分支）。
把 `1004` 当失败是本插件 v0.3.0 的一个误报，已修正。

发码还要带 `t` / `sn`（平台用 `et(phone)` 算的 md5 + 时间戳 + 随机串）。实测不是强校验，
但缺了会偶发 `3002 signature failed`，所以插件照抄同样形状的值。

**账号密码登录（平台支持，但本插件不实现）**：平台要求把密码用它的公钥做
**RSA/PKCS#1 v1.5** 加密后以 base64 提交（公钥硬编码在 `/ui/acm/assets/rsa-encry-*.js`，
512 位 → 定长 88 字符，Node 用 `crypto.publicEncrypt` + `RSA_PKCS1_PADDING`）。
接口本身可用，但密码必须经过插件进程，收益低于风险，因此插件只保留短信登录。

错误码实测：

| 场景 | 返回 |
| --- | --- |
| 账号或密码错 | `{"msg":"Username or password is incorrect","code":"401"}` |
| 关键字段缺失 | `{"msg":"Invalid parameters","code":"1005"}` — **与密码错误同一个码**，所以插件统一按「登录被拒」提示 |
| 短信验证码错/过期 | `{"code":"1009"…}` / `{"code":"3002","msg":"signature failed"}` |
| 登录成功 | `data` 是带 `ticket` 的跳转地址；GET 它才会把 `Token` Cookie 落到当前会话 |

**C. 微信扫码（插件里做不到，如实说明）**

- `POST /sso/getQRcodeUrl.action` 能拿到 `{url, key, ts}`（200）
- 插件不提供扫码通道，也不提供「回填 token」通道（两者都需要用户手工搬运凭据，体验与安全性都更差）。

### 9.3 用会话换 key

```text
POST https://www.scnet.cn/acx/llm/api-key/createActivityApiKey
Cookie: jsessionid=…; Token=…
Content-Type: application/json      ← 必须是 JSON！表单会得到 405
body: {}
→ {"code":"0","data":{"apiKey":"sk-…","baseUrl":"https://api.scnet.cn/api/llm/v1",…}}
```

实测这个 key 与客户端落盘的那个**完全相同**，所以免客户端登录不会在多处造出不同 key。

其它已实测可用的 Cookie 侧接口：

| 用途 | 接口 | 备注 |
| --- | --- | --- |
| 会话/身份 | `GET /acx/user/users/current-user-info?includeToken=true&refresh=true` | 401 = 会话失效 |
| 列出 key | `POST /acx/llm/api-key/query` | body 用 `{"createUser":"<userId>"}`；用 `accountId` 查不到 |
| 取 key 明文 | `GET /acx/llm/api-key/detail?id=<id>` | |
| 退出 | `GET|POST /acx/user/users/logout` | |

### 9.4 为什么不做「插件内二维码」

`GET https://www.scnet.cn/sso/wx/qrcodeLogin.action?oauthKey=<key>:<ts>:<createBy>`
对任何非微信客户端请求**恒返回 402**：

```json
{"status":402,"error":"Payment Required","message":"No message available","path":"/sso/wx/qrcodeLogin.action"}
```

已排除的因素（都实测过）：`createBy` 取 `scnet/sso/web/mall/www/空`、两个域名
（`www.scnet.cn`、`www.hpccube.com`）、带/不带 `Referer`、GET/POST、带/不带
`WCOA_TS` 与 `jsessionid`、`Accept: image/*`、OAuth2 `authorize` 流程下的 `service`。
平台前端 JS 里拼二维码地址用的 `createBy` 变量在页面中**根本没有赋值**
（`loginObj.createBy: ""`），说明该页面模板已被改成按网关透传。

所以设置页**不给假承诺**：只提供短信登录这一条通道。

### 9.5 插件的落盘与生命周期

- 会话文件：`$DSH_HOME/scnet-session.json`（0600，`open(…,'w',0o600)` 后 rename）

  ```json
  { "cookies": {"jsessionid":"…","Token":"…"}, "apiKey": "sk-…", "baseUrl": "…",
    "account": {"userId":"…","userName":"…"}, "obtainedAt":"…","keyedAt":"…",
    "expiresAt":"…","source":"web|jwt" }
  ```

- key 缓存 6 天；过期或被清空时，下一次请求自动用 Cookie 重新向平台换 key（已实测）。
- 会话失效 → 状态文件写 `credential.source: "unavailable"`、`login.phase: "expired"`，
  设置页提示「平台会话已过期，请重新登录」。
- 密码只在本进程内存里存在一次（加密后提交），**不落盘、不进日志、不返回给前端**。
- Cookie/key 等价于账号权限：状态路由与设置页只给掩码，诊断文件不含密文。
