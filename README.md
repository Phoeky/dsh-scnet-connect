# dsh-scnet-connect

把本机 **SCNet（超算互联网「计算服务」客户端）** 里的免费模型 **`SCNet-Max`** 接入
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的插件。

装好之后，DSH 模型选择器里会多出一个分组 **「超算互联网 SCNet」**，里面是
**`SCNet-Max · 免费`**。选它就能在 DSH 里对话、让模型调用本地工具、看图、以及使用
思考等级 —— 不需要把 API Key 复制到 DSH，也不需要 SCNet 客户端一直开着。

> SCNet 客户端里的「免费」是**限时免费**（客户端 UI 文案为「限时免费」/ free for a
> limited time），不是永久免费。本插件只是把你已有账号的免费额度接进 DSH，不提供额度、
> 也不绕过任何计费。

---

## 工作原理

```text
DSH（PiAiAdapter）
  → provider "scnet"（模型 SCNet-Max）
  → 读取 ~/.sclaw/agent/scnet-credentials/*.json 里的 model-service API Key
  → https://api.scnet.cn/api/llm/v1/chat/completions（标准 OpenAI Chat Completions，SSE）
```

SCNet 客户端的模型网关本身就是**标准 OpenAI 兼容端点**，所以本插件**没有**协议转换
bridge，也没有 loopback shim —— 只有一个「发现本机凭据 + 声明模型 + 注册 provider」
的薄适配层（这是与 `dsh-connect-trae` / `dsh-connect-qoder` 最大的不同：那两个插件
的上游是非标准协议，所以需要 bridge + shim）。

关键事实（均由本机实测确认，详见 [`docs/scnet-api.md`](docs/scnet-api.md)）：

| 项 | 值 |
| --- | --- |
| Base URL | `https://api.scnet.cn/api/llm/v1` |
| 模型 id | `SCNet-Max`（大小写敏感） |
| 鉴权 | `Authorization: Bearer sk-...`（model-service API Key） |
| Key 位置 | `~/.sclaw/agent/scnet-credentials/<hash>.json` → `{ "scnet": { "type": "api_key", "key": "sk-..." } }` |
| 协议 | OpenAI Chat Completions（流式 SSE、`tool_calls`、`reasoning_content`、图片 `image_url`） |
| 需要客户端运行吗 | 不需要（key 落盘后即可直连） |

---

## 功能

- **零配置**：自动发现本机 SCNet 客户端的登录凭据，不需要手动填 Key。
- **免 Key 复制**：Key 只留在 SCNet 客户端自己的数据目录里，插件每次请求时读取；
  客户端轮换 Key 后无需重启 DSH。
- **工具调用**：DSH 本地工具（`read` / `write` / `edit` / `pwsh` …）由 DSH 执行，
  模型负责产生结构化 `tool_calls`（已实测通过）。
- **思考等级**：`SCNet-Max` 支持思考，插件把 DSH 的思考等级映射到上游
  `reasoning_effort`（`off → none` 是真的关闭思考，实测 reasoning token 归零）。
- **图片输入**：`SCNet-Max` 原生支持图片，插件向 DSH 声明 `input: [text, image]`。
- **无需 shim**：标准 OpenAI 端点直连，少一层故障点。
- **可观测**：启动后写一份 `$DSH_HOME/scnet-connect-status.json` 诊断快照
  （注册状态、模型元数据、凭据来源；**不含 Key 明文**）。

---

## 安装

### 1. 前置：本机 SCNet 客户端已登录

装好 SCNet 客户端并登录账号，**正常发起过至少一次模型对话**（客户端会自动在平台上
创建 model-service API Key 并落盘到 `~/.sclaw/agent/scnet-credentials/`）。
之后客户端可以关掉。

### 2. 安装插件

```powershell
# DSH CLI 不在 PATH 里，用安装目录里的这个
$dsh = 'D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'

# 本地目录安装（开发/本机使用）
& $dsh plugin --profile desktop add link:F:\code\dsh-scnet-connect
```

`dsh plugin` 会把参数转发给 DSH 自带的 pnpm；装完后插件会出现在 profile 的
`dependencies` 与 `dsh.profile.bundles` 里（后者决定启动时装配哪些 bundle）。

### 3. 让运行中的 DSH 生效

DSH 的 loader 监听 profile 的补丁层变化：**改动一下 profile 的 `cordis.patch.yml`
（例如追加一行注释并保存）即可触发热重载**，插件会立刻注册 provider。也可以直接
完全退出并重新打开 DSH。

生效后可以在 `$DSH_HOME/scnet-connect-status.json`（默认 `C:\Users\<你>\.dsh\scnet-connect-status.json`）
看到：

```json
{
  "plugin": "dsh-scnet-connect",
  "registered": true,
  "provider": "scnet",
  "providerName": "超算互联网 SCNet",
  "models": [{ "id": "SCNet-Max", "name": "SCNet-Max · 免费", "contextWindow": 262144, "maxTokens": 32768 }],
  "credential": { "source": "client-file", "maskedKey": "sk-NTM4L…MjM=" }
}
```

### 4. 使用

在 DSH 的模型选择器里选 **「超算互联网 SCNet → SCNet-Max · 免费」**，正常对话即可。

---

## 配置（可选）

全部字段都有默认值，零配置即可用。需要覆盖时，在 profile 的 `cordis.patch.yml` 里
给本插件的 entry 加 `config`（或通过插件设置页编辑，若你的 DSH 版本提供）：

```yaml
- id: scnet-connect
  name: dsh-scnet-connect
  config:
    credentialDir: ''        # 默认 ~/.sclaw/agent/scnet-credentials
    apiKey: ''               # 直接指定 Key（留空 = 自动读客户端凭据）
    baseUrl: 'https://api.scnet.cn/api/llm/v1'
    modelId: 'SCNet-Max'     # 换其它模型 id 也可以（SCNet 网关区分大小写）
    modelName: ''            # 模型显示名；留空 = 自动（免费模型显示为「SCNet-Max · 免费」）
    contextWindow: 0         # 0 = 跟随客户端目录 / 内置默认（SCNet-Max 上取 262144）
    maxTokens: 0             # 0 = 跟随客户端目录 / 内置默认（SCNet-Max 上取 32768）
    inputImages: true
    reasoning: true
```

> `contextWindow` / `maxTokens`：SCNet 客户端对 `scnet-max` 有一条内部特判，把有效
> 上下文压到 262144、输出压到 32768（平台目录里写的是 1048576 / 131072）。插件默认
> 跟随客户端的保守值；如果你确认自己的账号按平台值可用，可以显式调大。

---

## 验证

### 不启动 DSH 的自检

```powershell
cd F:\code\dsh-scnet-connect
node tools/check.mjs          # 凭据发现 + 模型元数据 + 平台登录态
node tools/check.mjs --live   # 额外请求一次 /models（不消耗生成额度）
```

### 用 headless 模式真跑一条（不碰你正在用的桌面 DSH）

```powershell
$dsh = 'D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$env:DSH_HOME = 'F:\code\dsh-scnet-connect\.research\verify\tmp-home'

# 用一个独立的 headless profile
& $dsh --profile scnet-test --from-default-profile headless --dump-config
& $dsh plugin --profile scnet-test add link:F:\code\dsh-scnet-connect

# 把默认模型指到本插件的 provider（写一个 patch 文件）
@'
- insert:
    - id: agent-default-model
      name: '@deepseek-ai/dsh-agent-default-model'
      config:
        provider: scnet
        model: SCNet-Max
        reasoningEffort: high
'@ | Set-Content -Encoding utf8 "$env:DSH_HOME\scnet-e2e.yml"

$env:DSH_TOOLS_MODE = 'native'
& $dsh --profile scnet-test --patch "$env:DSH_HOME\scnet-e2e.yml" --json "只回答两个字：收到"
```

预期输出里能看到 `{"type":"text","text":"收到"}` 与 `turn_end`。让模型调用工具时，
`--json` 流里会出现 `{"type":"tool_call",...}` 与 `tool_result`（插件已实测通过）。

---

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 模型选择器里没有「超算互联网 SCNet」 | 插件未装配：确认 `dsh plugin --profile desktop add ...` 成功、profile 的 `dsh.profile.bundles` 里有 `dsh-scnet-connect`，然后按上文「让运行中的 DSH 生效」触发热重载或重启 DSH。 |
| `SCNet 模型服务凭据不可用（...）` | 本机没有可用的 model-service Key：打开 SCNet 客户端登录并正常发一条消息，让客户端创建 Key；或在插件配置里填 `apiKey`。 |
| 发送消息报 `Authentication Failed`（401） | Key 已失效/被平台撤销：重新打开客户端发一条消息让客户端刷新 Key（或重新登录），然后重试。 |
| `模型服务尚未开通` / 账号停用 | 这是 SCNet 平台账号状态问题（需要账号主在平台侧开通模型服务/解除停用），插件无法代劳，按平台提示处理。 |
| 输出被截断 / 上下文不够 | 调大 `maxTokens` / `contextWindow`（见配置），或换更长上下文场景。 |
| 上游 429 / 限流 | 插件不屏蔽限流；降低并发或稍等重试。实测 8–16 并发小请求未触发 429。 |
| 想换成别的 SCNet 模型 | 改 `modelId`（例如目录里的 `GLM-5.3-Flash`、`Kimi-K3` 等）；注意只有 `SCNet-Max` 是 `free`。 |

---

## 安全与隐私

- 插件**只读** SCNet 客户端自己写入的凭据文件，不写客户端数据、不改平台账号。
- API Key **不会**写进 DSH 配置、日志、诊断文件或本仓库；诊断快照里只有
  `sk-xxxxxxxx…xxxx` 形式的掩码。
- 插件不额外起本地端口、不做代理转发；请求由 DSH 进程直接发往 `api.scnet.cn`。
- 用的是未公开的客户端内部端点，SCNet 客户端升级后协议可能变化；如遇问题请附
  `docs/scnet-api.md` 里的验证脚本输出反馈。

---

## 兼容性 / 已知限制

- 只支持 DSH `0.2.1-rc.3` 一代的插件契约（`dsh.bundle.patch` + cordis 插件 +
  `ctx.llm.registerAdapter`），已在 DSH 0.2.1-rc.3 上实测。
- 模型 id、上下文/输出上限以 SCNet 平台实际下发为准；`SCNet-Max` 之外模型的免费
  状态由 SCNet 决定。
- 思考等级映射：`off→none、minimal/low→low、medium/high→high、xhigh/max→max`
  （上游只接受 `none|minimal|low|medium|high|xhigh|max` 七个值，非法值会 400）。
- 不支持 SCNet 平台侧的「模型服务开通」等账号操作；这些只能在 SCNet 客户端/平台完成。

---

## 开发

```text
lib/index.js            # cordis 插件入口：注册 provider、model descriptor、诊断快照
lib/scnet-credential.js # 发现/读取客户端 model-service API Key 与模型目录
lib/scnet-models.js     # SCNet-Max 模型元数据 + DSH 思考等级映射
cordis.patch.yml        # bundle 装配行（id=scnet-connect）
tools/check.mjs         # 独立自检脚本（--live 会请求 /models）
tools/repro/            # 逆向阶段的直连验证脚本（不参与运行时）
docs/                   # SCNet API 逆向报告 / DSH 插件契约报告
```

自检：

```powershell
node tools/check.mjs --live
```

## License

MIT
