# DSH 插件与模型 Provider 注册最小契约

> 结论先行版。验证环境：DSH 0.2.1-rc.3（`dsh --version` 实测），Node 24.21.0 / pnpm 11.28.5（DSH 自带），
> 安装目录 `D:\Programs\DeepSeek Harness`，运行中的 GUI `http://127.0.0.1:11256`。
> 证据来源：解包 `resources/app.asar` 源码（`.research/dsh-plugin/asar-extract/`，只读解包，未改动安装目录）、
> 本机已装插件（`dsh-sensenova-pool`、`dsh-connect-trae`、`qq-mode-console`）、以及临时 `DSH_HOME` 下的实测安装/装配。

---

## 0. 四个待定问题的直接答案（Lead 优先看这里）

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | `dsh plugin --profile desktop add link:<本地目录>` 可行吗 | **可行**。DSH 自带的 pnpm 11.28.5 执行 `link:` 安装，依赖写进 profile `package.json`；包里有 `dsh.bundle.patch` 时会**自动追加进 `dsh.profile.bundles`**。实测输出：`✓ Lockfile passes supply-chain policies`、`+ dsh-hello-world 0.1.0 <- ..\..\..\hello-world`。**注意：目录必须先存在且 package.json 合法**，否则 pnpm 装完后的 reconcile 解析 bundle 失败并抛 `cannot resolve profile bundle`（首次实测踩到过）。 | 见 §2.3 实测记录 |
| 2 | 插件里的 `import '@deepseek-ai/dsh-llm-pi-ai'` / `'@earendil-works/pi-ai'` / `'@deepseek-ai/schemastery'` 从哪解析 | **从 DSH 安装自带包解析，不需要插件自带 node_modules**。`dsh-app-boot` 启动时构建 `ProfileRuntimeResolution`（`createRuntimeResolution` → `collectInstallationScopePackages`，递归安装包的整个依赖图），再通过 Node 的 ESM/CJS resolver hooks 供给。安装清单里 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai`、`@deepseek-ai/schemastery`、`@earendil-works/pi-ai` 都在。profile 的 pnpm workspace 设了 `autoInstallPeers: false`，**peerDependencies 不会被实际安装**。**实测**：把含 `import PiAiAdapter / resolveRetryPolicy / createProvider / openAICompletionsApi / schemastery` 的 provider-skeleton 装进 scratch profile 跑 `--dump-config-schema` → `"complete": true`（模块全部解析成功）。**唯一实测失败**：`import { credentialRef } from '@deepseek-ai/dsh-credentials'` → `Cannot find package`；改用 `ctx.get('credentials')` + 普通字符串引用即可（sensenova-pool 就是这么做，不 import 该包）。 | 见 §3.2 末尾「import 解析实测」 |
| 3 | 如何不影响 GUI 做加载验证 | **`dsh --profile desktop --dump-config` 不可用**：实测直接报 `error: profile "desktop" is managed exclusively by the Electron application`（`dsh-desktop-host` CLI 里 `manageDesktopProfile` 只放行 `plugin` 子命令，不放行 profile dump/boot）。可行替代：① 临时 `DSH_HOME` 建 scratch profile 跑 `--dump-config` / `--dump-config-schema`（实测 `complete: true, diagnostics: []`）；② 用 shipped `headless` profile 做真实模型调用验证（`--patch` 叠加层 + `agent-default-model` 改 provider/model）。`dsh headless` **没有** `--model/--provider` 参数（`--help` 实测只有 `--json/--session-id`），模型只能由配置决定。 | 见 §6 |
| 4 | 不写 client（React 设置卡片）行不行？`volatile` 是否必需？ | **完全可行**。`qq-mode-console` 就是纯 host 插件（文件头注释亲述「本插件没有 browser/client 半」），照常加载并被读写设置。`volatile` **只影响设置页能否写穿**（无 volatile 字段时 `volatileForm()` 会抛 `has no volatile fields`），不影响插件加载/provider 注册。宿主侧插件只需 `name/inject/Config/apply` 四个导出；`Config` 里给需要从设置页改的字段加 `.extra('volatile', true)`（兼容写法，Schemastery 3.18.1 无 `.volatile()`）。 | `qq-mode-console/lib/index.js:44-113` |

---

## 1. 插件发现与安装机制（已实测）

### 1.1 目录与清单

```
$DSH_HOME/profiles/<profile>/          # 默认 C:\Users\H\.dsh\profiles\desktop
├── package.json                       # dependencies + dsh.profile.bundles（有序）
├── cordis.patch.yml                   # 该 profile 的用户补丁层（热重载）
├── pnpm-workspace.yaml                # nodeLinker: hoisted; autoInstallPeers: false
└── node_modules/
```

profile 的 `package.json` 形如（真实 desktop profile 截取）：

```jsonc
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-connect-trae": "4.6.4",
    "qq-agent-presets": "link:C:/Users/H/.dsh/plugins/qq-agent-presets",
    "dsh-refresh-plugin": "link:F:/code/dsh-desktop-refresh/dsh-refresh"
  },
  "dsh": {
    "profile": {
      "bundles": [                       // 有序：决定 bundle 补丁的应用顺序
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-connect-trae",
        "qq-agent-presets"
      ]
    }
  }
}
```

**一个插件 = 一个 npm 包 + `package.json` 里的 `dsh.bundle.patch` + 一个 cordis 插件入口模块。**

```jsonc
// 插件 package.json 关键字段
{
  "name": "dsh-hello-world",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",                  // cordis 插件模块入口
  "exports": { ".": "./index.js", "./package.json": "./package.json" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },   // 也可为字符串数组
  "engines": { "dsh": ">=0.2.1-rc.3 <0.3.0-0" }             // 可选，见 §1.4 版本门槛
}
```

### 1.2 装配顺序（`dsh-app-boot` 源码实证）

`prepareProfile` / `readProfilePatches`（`dsh-app-boot/lib/index.js:1066-1138`）：

1. 空根 entry 列表 `[]`
2. **每个 bundle 的 patch**，按 `dsh.profile.bundles` 顺序（bundle 源码：`loadProfileDirectory` → `bundlePatchPaths`，`index.js:1016-1052`）
3. profile 自己的 `cordis.patch.yml`
4. `$DSH_HOME/cordis.patch.yml`（home 级用户层，机器级偏好；当前本机不存在）
5. `--patch <file>` 叠加层（可重复，按 argv 顺序）
6. 遥测开关补丁

每层都是**同一个补丁数组**，用 `applyEntryPatches`（`index.js:48-111`）拍平后一次性作用到空根上。语义：

- `- insert: [entry, ...]`：无 `id` 时追加到顶层；`id:` 指向 group entry 时插入其 `config` 子列表。
- 非 insert 补丁必须带 `id`，把该 entry 的其余字段（`name`/`config`/`disabled`/…）整体覆盖；`config` 是**整块替换而非 merge**（dsh-base 文件头注释明确）。
- `name:` 可做目标校验（不匹配则 warning + skip）。
- 支持 `!!js` 表达式（如 `disabled: !!js "!ctx.get('profileContext')"`）。
- 无效 patch 抛错（文件级）；目标行不存在只 warning。
- insert 支持相对路径 name（`./plugin-dir` 会转成 file URL，`index.js:3972-3980`）。

### 1.3 安装命令与效果

```powershell
# DSH CLI（不在 PATH，用安装目录里的 cmd）
$dsh = 'D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'

# 安装到 desktop profile（Electron 运行中也可执行，见 §6.3 生效时机）
& $dsh plugin --profile desktop add link:F:\code\dsh-scnet-connect          # link 本地目录
& $dsh plugin --profile desktop add dsh-some-package                        # npm 包
& $dsh plugin --profile desktop remove dsh-some-package
& $dsh plugin --profile desktop ls --depth 0                                # 只读查看（实测可跑）

# 本地插件目录需先准备好合法 package.json + cordis.patch.yml，再 add link:
```

`dsh plugin` = 把参数**原样转发给 pnpm**（`dsh/lib/bin.js:116-128`），运行在 profile 目录；
`packageManager` 由 Desktop 注入为 `resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`（`dsh-desktop-host/lib/cli.js:97-108`）。
所以**不需要全局 pnpm，也不需要系统 Node**。

### 1.4 版本/兼容门槛（必须知道，否则插件被静默跳过）

`evaluatePluginCompatibility`（`dsh-app-boot/lib/index.js:280-337`）：

- 若插件 `package.json` 自带 `engines.dsh`（字符串 range）→ **只看它**，`peerDependencies` 被忽略。
- 否则检查所有 `peerDependencies` 里 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的 range 是否满足当前 runtime 版本。
- 不满足：bundle 仍安装但**启动时被 skip**，`dsh plugin ls` 会打印警告，例如本机实测：
  `Plugin @michengai/dsh-skills-manager@1.1.13 is incompatible with dsh 0.2.1-rc.3 ... profile startup denies it`。
- 补救：`dsh plugin allow-version` 或用 plugin manager 授予精确版本豁免。

**建议**：
- 给插件加 `"engines": { "dsh": ">=0.2.1-rc.3 <0.3.0-0" }`（简单、不误判）；
- 或者照 `dsh-connect-trae` 写 `peerDependencies`（`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai` 等 range 用 `>=0.1.7-rc.1 <0.3.0-0`）。peer 里**不要**写非 `@deepseek-ai/dsh*` 包去卡版本，它们不参与 gate。

### 1.5 模块解析（回答 Q2 的细节）

- 启动时 `createRuntimeResolution` 把**安装包依赖图**（`@deepseek-ai/dsh-desktop-runtime` 的 `dependencies` 递归）和 **profile 已装包**整理成 resolver 表（`index.js:716-799`），两种 scope：`installation` / `profile`。
- 插件代码里的 bare import 由这个 resolver 供给，所以 `import '@deepseek-ai/dsh-llm'`、`import '@deepseek-ai/schemastery'`、`import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'`、`import { createProvider } from '@earendil-works/pi-ai'` 都能解析。
- **因此插件 `package.json` 的最佳写法**：

```jsonc
{
  // 运行时导入由宿主 installation scope 供给，不必装进插件自身
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.4 <5.0.0",
    "@deepseek-ai/dsh-llm": ">=0.1.7-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-llm-pi-ai": ">=0.1.7-rc.1 <0.3.0-0",
    "@deepseek-ai/schemastery": ">=3.18.4 <4.0.0",
    "@earendil-works/pi-ai": ">=0.85.1 <2.0.0"
  },
  // 仅本地 typecheck 需要实体：devDependencies 可选，但 profile 里 autoInstallPeers=false 不会真装 peer
  "devDependencies": { "@types/node": "^22.20.0", "typescript": "^5.9.3" }
}
```

- 如果插件确实要在自己的 `node_modules` 里带实现（不推荐），才会被 `link:` / pnpm 装进去；否则一律走 installation scope，避免双份库导致协议类型不一致。
- 若插件要 `tsc` 类型检查，可在仓库里把上述包放 `devDependencies`（npm/pnpm 装到插件自身开发环境），但**发布/安装到 profile 时不要**把它们塞进 `dependencies`。

---

## 2. 最小插件骨架（已实测装配）

### 2.1 文件三件套

`.research/dsh-plugin/hello-world/`（可直接复制）：

```
hello-world/
├── package.json        # dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml    # - insert: [{ id, name, config }]
└── index.js            # export name / inject / Config / apply
```

`index.js` 的核心契约（cordis 插件）：

```js
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-hello-world';   // 仅诊断用；loader entry 的 name 才是包名
export const inject = [];                // 依赖的服务名数组，如 ['llm'] / ['settings'] / ['credentials']
export const Config = z.object({         // 宿主用它对 entry 的 YAML `config:` 做校验
  greeting: z.string().default('hello').description('...'),
});
export function apply(ctx, config) {     // entry 激活时调用；ctx 是 cordis Context
  ctx.logger?.info?.('...');
  ctx.effect?.(() => () => { /* dispose */ });
}
export default { name, inject, Config, apply };
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-hello-world       # ★ 若要暴露 settings 命名空间，id 必须等于命名空间名
      name: dsh-hello-world     # ★ 包名：loader 用它 require/import 入口模块
      config:
        greeting: hello
```

> `id` 与 `name` 的区别（`qq-mode-console` 注释踩坑记录）：`name` 是 npm 包名（解析入口）；`id` 是 loader 行标识，**也是 settings 命名空间名**。二者可以不同，但需要设置页可写时 `id` 必须等于插件里用的命名空间。

### 2.2 加载成功的实测验证（推荐给 Lead 的本地闭环）

在**临时 DSH_HOME** 里做（不会碰用户的 desktop profile）：

```powershell
$dsh = 'D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$env:DSH_HOME = 'F:\code\dsh-scnet-connect\.research\dsh-plugin\tmp-home'   # 仅本进程
& $dsh plugin --profile probe add link:F:\code\dsh-scnet-connect\.research\dsh-plugin\hello-world
& $dsh --profile probe --dump-config          # 看 composed tree 里有没有你的 entry
& $dsh --profile probe --dump-config-schema   # ★ 会 import 插件模块、跑 Config schema
```

实测结果：
- `--dump-config` 输出中该 entry 出现在独立层注释下：

```yaml
# == dsh-hello-world
- id: dsh-hello-world
  name: dsh-hello-world
  config:
    greeting: hello from dsh-hello-world
```

- `--dump-config-schema` 生成 620 KB JSON，`"complete": true`、`"diagnostics": []`，且含
  `"id": "dsh-hello-world"` 与 Config 字段默认值 `"default": "hello"` —— 即入口模块被真实 import、schema 被收集。

> 这一步等价于「插件模块能被加载 + Config 合法 + 装配产生正确 entry」，但不触发 `apply()`。要验证 `apply()` 副作用，用 §6.2 的 headless 真跑。

---

## 3. 模型 provider 注册 API（最重要）

### 3.1 先分清两条路：**配置就能加 provider**，插件不是必需

DSH 内置 `@deepseek-ai/dsh-llm-pi-ai` 这个多 provider 适配器，**零代码**即可接入任意 OpenAI 兼容网关。
真实 desktop profile 的 `cordis.patch.yml:25-149` 就是这么接的（现有 5 个自定义 provider）：

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      scnet:                                # 路由名 = GenerateOptions.provider
        displayName: SCNet
        apiKeyEnv: SCNET_API_KEY            # 凭据引用名，不写明文 key
        api: openai-completions             # 也可 openai-responses / anthropic-messages
        baseURL: https://api.scnet.cn/api/llm/v1
        models:
          - id: SCNet-Max                   # ★ 大小写与上游 /v1/models 完全一致
            name: SCNet-Max
            contextWindow: 1048576
            maxTokens: 384000
            input: [text]                   # 上游支持图片再改成 [text, image]
            reasoningEfforts:               # 上游实测接受 low/medium/high/max
              off: null                     # 注意：不发 reasoning_effort 时上游仍可能思考
              low: low
              medium: medium
              high: high
              max: max
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: scnet
    model: SCNet-Max
```

> **SCNet 上游协议已由团队实测确认**（`.research/scnet-probe/`）：`GET https://api.scnet.cn/api/llm/v1/models` 返回 OpenAI 形状（含 `SCNet-Max`、`DeepSeek-V4.1-Flash` 等）；`POST .../v1/chat/completions` 支持流式 SSE（`delta.content` / `delta.tool_calls` 分片）、非流式、工具调用、`reasoning_effort: low|medium|high|max`，响应里带 `reasoning_content`。**结论：scnet 是标准 OpenAI 兼容端点 → 不需要 loopback shim，走 `openai-completions` 即可。**

字段全集（`dsh-llm-pi-ai/README.zh.md` 表格，权威）：`apiKeyEnv`、`displayName`、`api`、`baseURL`、`models`、`modelOverrides`、`compat`、`defaultContextWindow`（默认 262144）、`defaultMaxTokens`（默认 32768）、`requestImagePixelBudget`、`requestImageMaxBytes`、`maxRequestImageBytes`、`retryPolicy`。

**评估：如果 scnet 客户端暴露的是标准 OpenAI `/v1/chat/completions` + `/v1/models`，这条路 15 行 YAML 就能完成，且不需要 shim、不需要写协议转换。**但用户明确要求「开发插件」，所以建议：**插件只做薄封装** —— 自带 `cordis.patch.yml` 往 `llm-pi-ai` 的 `providers` 里 insert 一个 `scnet` 路由，或由插件在 apply 里动态注册（见 3.2）。前者最小、最稳，且能随 profile 分发。

### 3.2 插件内动态注册 provider（`ctx.llm.registerAdapter`）

`@deepseek-ai/dsh-llm` 的 `llm` 服务公开面（`dsh-llm/lib/index.js`）：

```ts
class LlmRuntime {
  listProviders(): { id: string; name: string }[]
  registerAdapter(providers: string[], adapter: LlmAdapter): (() => void) & { replace(next: string[]): void }
  registerConfigurableProviders(entries: { provider, displayName, settingsNs, settingsPath, baseURLEnv?, nativeAuth? }[]): ...
  registerModelDiscovery(settingsNs, discover): () => void
  listModels(provider): Promise<ModelInfo[]>
  resolveModelInfo(provider, model, signal?): Promise<ModelInfo>
  prepareCall(config, signal?, configure?): Promise<PreparedCall>
  stream(options): AsyncIterable<StreamChunk>
}
```

最小可用注册（本质就是 `dsh-sensenova-pool` 的做法，**首选参考它的源码** `F:\code\dsh-sensenova-pool\src\index.ts`）：

```ts
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-scnet-connect';
export const inject = ['llm'];

export const Config = z.object({
  baseUrl: z.string().default('https://<scnet>/v1').extra('volatile', true),
});

export function apply(ctx, config) {
  const models = [{
    id: 'scnet-max', name: 'scnet-max',
    api: 'openai-completions', provider: 'scnet', baseUrl: config.baseUrl,
    input: ['text', 'image'],
    contextWindow: 1048576, maxTokens: 384000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { maxTokensField: 'max_tokens' },
  }];

  const profile = {
    provider: 'scnet',
    displayName: 'SCNet',
    streamIdleTimeoutMs: 300_000,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-scnet-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    maxRequestImageBytes: 20_971_520,
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
    piProvider: {
      ...createProvider({
        id: 'scnet', name: 'SCNet',
        auth: { apiKey: { name: 'SCNet', async resolve({ credential }) {
          const key = credential?.key;
          return key ? { auth: { apiKey: key }, source: 'scnet' } : undefined;
        } } },
        models,
        api: openAICompletionsApi(),
      }),
      getModels: () => models,
    },
  };

  const adapter = new PiAiAdapter({
    profiles: () => new Map([['scnet', profile]]),
    auth: INERT_AUTH,                          // 必填；不给会触发 pi-ai 环境变量探测
    resolveApiKey: async () => <apiKey>,       // 见 §4：从 ctx.credentials.resolve() 取
  });
  ctx.llm.registerAdapter(['scnet'], adapter); // ★ 注册后模型出现在选择器
  ctx.effect?.(() => () => adapter.dispose?.());
}
```

需要 `INERT_AUTH`（阻断 pi-ai 自造凭据，见 sensenova `index.ts:106-129`）：

```ts
const INERT_AUTH = {
  credentials: {
    async read() { return undefined; },
    async list() { return []; },
    async modify() { throw new Error('no pi-ai credential lifecycle'); },
    async delete() { return undefined; },
  },
  authContext: { async env() { return undefined; }, async fileExists() { return false; } },
};
```

模型描述符可用字段（来自 sensenova `buildModels()` 与 pi-ai 模型定义）：`id`、`name`、`api`、`provider`、`baseUrl`、`input`（`['text','image']`）、`reasoning`（bool）、`thinkingLevelMap`（DSH 等级 → 上游 `reasoning_effort` 拼写，如 `{off:'none', low:'low', high:'high', max:'xhigh'}`）、`cost`、`contextWindow`、`maxTokens`、`compat:{maxTokensField:'max_tokens'}`、`headers`。

> 更简单的替代：如果 scnet 就是标准 OpenAI 兼容端点，**不要写 adapter**，把 3.1 的 provider 配置放进插件 bundle 的 `cordis.patch.yml`：

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      scnet:
        apiKeyEnv: SCNET_API_KEY
        api: openai-completions
        baseURL: https://<scnet>/v1
        models: [{ id: scnet-max, name: scnet-max, contextWindow: 1048576 }]
```
  这条 insert 会按层序**追加**到既有 `llm-pi-ai` 行？——不行：非 insert 补丁是**整块覆盖** `config`。正确做法是 `- insert: [{...}]` 到顶层新增一个**独立** `llm-pi-ai` 行会因同名 entry 冲突。**因此在 bundle 层不能简单"追加 provider"**：要么插件 apply 里动态 `registerAdapter`（推荐，互不冲突），要么由 profile 用户层覆盖整个 `llm-pi-ai.config.providers`（会与用户现有 provider 冲突）。**结论：插件形态走 `ctx.llm.registerAdapter` 最干净。**

### 3.2.1 import 解析实测（回答 Q2 的关键证据）

把 `.research/dsh-plugin/provider-skeleton/`（顶层 import 了 `@earendil-works/pi-ai`、`@earendil-works/pi-ai/api/openai-completions.lazy`、`@deepseek-ai/dsh-llm-pi-ai`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`）装进 scratch profile 后：

```
& $dsh --profile probe2 --dump-config-schema
...
"complete": true            # 全部 import 成功，schema 收集完成
```

对照实验：额外 `import { credentialRef } from '@deepseek-ai/dsh-credentials'` 时 `"complete": false`，
诊断 `Cannot find package '@deepseek-ai/dsh-credentials' imported from .../provider-skeleton/index.js`。
→ **不要在插件里 import `@deepseek-ai/dsh-credentials` 的品牌工具**；凭据一律用 `ctx.get('credentials')` + 字符串引用名（`sensenova-pool` 即此写法）。

### 3.3 若必须 loopback shim：职责与最小实现要点

什么时候需要 shim：上游不是标准 OpenAI 兼容（鉴权/协议怪）、需要 key 轮换/429 屏蔽、需要请求体规范化。`dsh-sensenova-pool/src/shim.ts` 是完整范本（441 行），最小要点：

1. `createServer` 只 `listen(0, '127.0.0.1')`，`ready` Promise 等 `listening`；把 `http://127.0.0.1:<port>` 写进模型描述符的 `baseUrl`（**必须等端口就绪后再 buildModels/registerAdapter**，否则 baseUrl 会抛）。
2. 共享密钥：进程内 `randomBytes`，DSH 侧 `resolveApiKey: async () => shim.token()`；校验 `Authorization: Bearer`（timingSafeEqual），拒绝非 loopback Host/Origin（防 DNS rebinding）。
3. 路由：`GET /v1/models`（给 pi-ai 目录发现）、`POST /v1/chat/completions`（流式 `text/event-stream` 透传 + 非流式 JSON 透传）、`GET /healthz`。
4. 流式：直接 `Readable.fromWeb(upstream.body).pipe(res)`；上游中途断流补 `data: [DONE]\n\n`，否则客户端一直等。
5. 请求体规范化（OpenAI 兼容网关常见 400）：`developer` role → `system`、`content:null` 清理、tool arguments 对象→字符串、`reasoning_effort` 非法档位映射。sensenova 的 `sanitizeChatRequest` 可参考。
6. 错误映射：**429 绝不穿透**给 DSH，改报 `503 + Retry-After`（DSH retry 会退避重试）；400/403/404 原样；错误体用 OpenAI 形状 `{error:{message,type,code}}`，pi-ai 才能翻译成 failure code。
7. disposer 里 `await shim.close()`（`server.close` + `closeAllConnections`），且**返回**该 Promise（否则 Windows 上 libuv 断言 0xC0000409）。

> scnet 客户端如果是本机登录态/需要自定义鉴权，shim 里放「取 token → 转发」最合适；若只是静态 API key + 标准 OpenAI 协议，直接 `openai-completions` 即可，无需 shim。

---

## 4. 凭据与设置存储

### 4.1 `~/.dsh/.credentials.yaml` 格式（实测本机）

```yaml
version: 1
records:
  <scope>/<id>:               # 插件自持记录，如 dsh-sensenova-pool/keys
    kind: grant               # grant = 自由 payload；api-key = 仅 kind/key/env
    payload:                  # grant payload 被逐字保留，多字段安全
      keys: [...]             # 例：key 池
      externalKey: '...'
  DEEPSEEK_API_KEY: 'sk-...'   # 扁平条目 = ambient/环境式凭据（apiKeyEnv 按名解析）
  SCNET_API_KEY: '...'
```

- **grant vs api-key 互斥**：`api-key` 只允许 `kind/key/env`，`grant` 只允许 `kind/payload`。写错 kind 会让 credentials-local 在 `loadInitial` 解析失败 → **整个 DSH 启动中止**（sensenova 源码注释亲述踩坑）。池/多字段只能进 `grant.payload`。
- 文件里现有真实 key，文档/代码里一律用 `SCNET_API_KEY` 这样的**引用名**，不要抄值。

### 4.2 凭据 API（`ctx.get('credentials')`，`dsh-credentials` README 权威）

```ts
const credentials = ctx.get('credentials');
const hit = await credentials.resolve('SCNET_API_KEY');        // { value, source } | undefined
await credentials.describe(ref);                               // { configured, source?, writable } 不返回值
await credentials.set(ref, 'sk-…');  await credentials.unset(ref);

const key = '<scope>/<id>';
await credentials.readRecord(key);       // CredentialRecord | undefined
await credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { ... } }));  // 唯一写路径
await credentials.describeRecord(key); await credentials.listRecords(); await credentials.deleteRecord(key);
```

读取时机：`inject: ['llm']` 时 credentials 服务可能尚未 ACTIVE（冷启动磁盘 IO）。正确姿势是 `ctx.inject(['credentials'], onReady)`（sensenova `index.ts:582-609`），**不要**轮询或首次读空就写回（会抹掉磁盘上的 key）。

### 4.3 settings / Config / volatile

- 0.2.x **没有** `ctx.settings.register()`；命名空间从 loader entry 推导：
  `configEditor.entries().find(row => row.options.id === ns)` → `entry.fiber.runtime.Config` → `volatileForm(schema)`（只保留 `meta.volatile` 字段）。
- 所以「设置页可写」三条件：① 有一个 `id === 命名空间名` 的 loader entry；② 插件模块导出 `Config`；③ `Config` 里至少一个 `volatile` 字段。
- 无 client 半不影响加载与 provider 注册；只是没有自定义设置卡片。设置值可通过 profile `cordis.patch.yml` 的 entry `config:` 提供，或通过其他插件/API 写 `settings`。
- 兼容写法：`z.string().extra('volatile', true)`（不要用 `.volatile()`，profile 里 `@deepseek-ai/schemastery` 可能没有该方法）。

---

## 5. 插件入口契约速查（从真实插件归纳）

| 导出 | 必需 | 说明 |
|---|---|---|
| `name` | 建议 | 诊断名；与 loader entry `name` 无强绑定 |
| `inject` | 视情况 | 服务名数组；要 `ctx.llm` 就 `['llm']`，要读凭据就 `['llm','credentials']`（或后置 `ctx.inject`） |
| `Config` | 要设置/schema 时 | Schemastery object；宿主校验 YAML config |
| `apply(ctx, config)` | 必需 | 激活回调；用 `ctx.effect` 注册 disposer |
| `default` | 可选 | 某些场景 bundler 兼容用 |

`dsh` 插件的 package.json 两个关键字段：`main` 指向入口（ESM `type: module`），`dsh.bundle.patch` 指向 patch 文件。

---

## 6. 本地开发验证闭环（不碰运行中的 GUI）

### 6.1 CLI 基本事实（实测）

```powershell
$dsh = 'D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'   # 不是 PATH 命令
& $dsh --version          # 0.2.1-rc.3
& $dsh --help
& $dsh plugin --profile <p> <pnpm args...>
& $dsh --profile <p> [--patch <yml>...] [--dump-config | --dump-config-schema | --dump-default-config]
& $dsh <profile> [app args...]      # 简写
```

- `--dump-config`：打印组合后的 profile tree（**desktop profile 被拒绝**，见 Q3）。
- `--dump-config-schema`：offline 收集 schema，**会 import 插件模块**（可验证入口可加载 + Config 合法），输出 `x-cordis.complete/diagnostics`。
- `--dump-default-config`：不含用户层/--patch。
- `--from-default-profile <web|headless|acp|sdk|sdk-minimal>`：用 shipped 模板重建 profile。

### 6.2 真实模型调用验证（headless）

`headless` app 的 **全部** 参数（`dsh headless --help` 实测）：

```
Usage: dsh --profile headless [options] [task...]
Options: --json, --session-id <id>, -h/--help
```

**没有 `--model`/`--provider` 开关**。模型由配置决定（`agent-default-model` entry）。推荐隔离验证法（不碰 desktop profile）：

```powershell
# 1) 用一个临时 profile（可在临时 DSH_HOME 里，也可以复用 shipped headless）
$env:DSH_HOME = 'F:\code\dsh-scnet-connect\.research\dsh-plugin\tmp-home'
& $dsh plugin --profile scnet-test add link:F:\code\dsh-scnet-connect      # 你的插件
# 2) 若插件自带 llm-pi-ai provider 配置，还需把默认模型指过去：
#    编辑 $env:DSH_HOME\profiles\scnet-test\cordis.patch.yml：
#    - id: agent-default-model
#      name: '@deepseek-ai/dsh-agent-default-model'
#      config: { provider: scnet, model: scnet-max }
# 3) 真跑一条消息（会消耗一次上游调用）
& $dsh --profile scnet-test "用一句话回答：1+1 等于几"          # 等价 `dsh --profile scnet-test`
# 或直接 headless 模板 + 叠加层：
& $dsh --profile headless --patch F:\...\scnet-patch.yml "你好"
```

> `dsh --profile headless` 会自动在 `$DSH_HOME/profiles/headless` 初始化 shipped 模板（`dsh-base`+`dsh-headless`），不会动 desktop profile；模型/凭据来自同一个 `$DSH_HOME`（可临时指到别处）。
> 想用真实 `~/.dsh` 的 key，就**不要**改 `DSH_HOME`，改用 shipped `headless` profile + `--patch`（只新增/覆盖目标行，不会写用户 desktop 的 patch 文件）。

### 6.3 把插件装进正在运行的 desktop（步骤交给 Lead 决策）

```powershell
& $dsh plugin --profile desktop add link:F:\code\dsh-scnet-connect
# 生效：
#  - dsh-refresh 插件 README 原话：应用运行时会监听 profile 的 bundles 列表变化并自动重组 loader，
#    但当前已加载页面不会包含新的 client 半 → host-only 插件通常无需重启即可装配；client 需要 F5/重启。
#  - 最稳妥：完全退出并重新打开 DeepSeek Harness（不要 kill 进程；由用户操作）。
# 回滚：
& $dsh plugin --profile desktop remove <package-name>   # 或手工删 package.json 的 dependency + bundles 条目
```

### 6.4 日志与「插件是否加载」观测

- **启动失败**诊断：`$DSH_HOME/logs/startup-*.log`（由 `dsh/lib/bin.js` 的 `reportStartupFailure` 写入；本机暂未生成）。
- Electron 崩溃日志：`C:\Users\H\AppData\Roaming\@deepseek-ai\dsh-desktop\logs\crash-*.log`（本机 3 个历史文件）。
- 常规运行日志：DSH Desktop 不落盘到文件，`ctx.logger`/`console.error` 走进程 stderr；桌面版看不到时用 DevTools/或临时用 §6.1 的 dump 验证。
- 验证 provider 真的注册：`--dump-config` 看 entry 是否装配 → `--dump-config-schema` 看模块是否可 import；运行期看 GUI 模型选择器是否出现 `scnet` 分组，或 headless 实跑一条。

### 6.5 不要做的事

- 不要 kill 正在跑 GUI 的进程；不要让第二个实例抢 `11256`（默认端口冲突会失败）。
- 不要改 `D:\Programs\DeepSeek Harness` 安装目录（只读解包 asar 到 `.research/`）。
- 不要直接改 `~/.dsh/.credentials.yaml` 里的 grant 记录结构（写错 kind 会让整个 DSH 起不来）。

---

## 7. 仍不确定 / 需在真实插件上验证的点

1. **desktop 运行中「bundles 列表变化自动重组 loader」对 host 插件的实际生效情况**：dsh-refresh README 这么说，但我没有在运行中的 GUI 上真装插件验证（怕影响用户会话）。建议 Lead 决定是否直接 `add link:` 后由用户点 F5/重启。
2. **scnet 客户端模型协议已确认（团队实测，见 `.research/scnet-probe/`）**：`https://api.scnet.cn/api/llm/v1` 是标准 OpenAI 兼容端点，`SCNet-Max` 支持 SSE 流式、工具调用、`reasoning_effort`（low/medium/high/max），响应含 `reasoning_content`。**结论：不需要 shim**，`llm-pi-ai` 的 `openai-completions` 配置即可覆盖；剩余待确认的只是「装配后 GUI 选择器与实跑」。
3. **`@earendil-works/pi-ai`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai`、`@deepseek-ai/schemastery` 从 installation scope 解析已实测通过**（provider-skeleton 的 `--dump-config-schema` → `complete: true`）；但 `@deepseek-ai/dsh-credentials` 实测解析失败，插件别 import 它。该结论在 scratch profile 得到，desktop profile 的 bundle 层更多但解析表来自同一个安装锚点，预期一致；插件首次 dump-config-schema 可再确认。
4. **settings 写穿**：若需要 GUI「设置→插件」卡片里改 baseURL/apiKey，还要 client 半 + `dsh.client.inject`（trae/sensenova 的 `package.json.dsh.client` 是范本）；本项目的用户需求未明确要求卡片，可先不做。
5. **`dsh plugin --profile desktop add` 在 GUI 运行中执行是否会被 profile 文件锁/插件管理器 watcher 干扰**：`ls` 实测可跑、未在运行中写；建议先 `ls`/`why` 只读确认，再执行 `add`。

---

## 8. 可复制材料索引

| 材料 | 路径 |
|---|---|
| 最小 hello-world 插件（已实测装配，验证 loader+Config 契约） | `.research/dsh-plugin/hello-world/` |
| SCNet provider 插件骨架（已实测 import 全部解析成功，待填真实 baseURL/key） | `.research/dsh-plugin/provider-skeleton/` |
| asar 解包的关键源码 | `.research/dsh-plugin/asar-extract/`（`dsh-llm`、`dsh-llm-pi-ai`、`dsh-app-boot`、`dsh-credentials`、`dsh-desktop-host`、`dsh-base` 等） |
| asar 解包工具（只读） | `.research/dsh-plugin/tools/asar-list.mjs` |
| 实测生成的 schema / composed config | `.research/dsh-plugin/asar-extract/cli/probe-schema.json` 等 |
| 参考插件源码（provider 注册 + shim） | `F:\code\dsh-sensenova-pool\src\index.ts`、`src\shim.ts` |
| 参考插件源码（大而全，含 client） | `F:\code\upstream-src\dsh-connect-trae-main\src\` |

---

## 附：关键源码位置（便于复核）

- profile/bundle 装配：`asar-extract/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`
  - 补丁语义 `applyEntryPatches`：L48-111
  - bundle → patch 文件：L518-532
  - profile 目录/manifest/template：L547-628
  - 加载 bundle 层：L1016-1052
  - 补丁顺序：L1119-1138
  - 兼容性 gate：L280-337
  - 运行时模块解析表：L716-799
  - patch 解析（YAML 语法）：L3954-4006
- LLM 服务/Adpater 契约：`asar-extract/.../dsh-llm/lib/index.js`（`LlmAdapter` L1671-1756，`LlmRuntime` L1761-2400，`normalizeModelInfo` L2120-2164）
- pi-ai 适配器：`asar-extract/.../dsh-llm-pi-ai/lib/index.js`（exports `Config, PiAiAdapter, apply, inject, name, recordKeyFor, supportedProtocols`；配置面见同目录 `README.zh.md`）
- 凭据 seam：`asar-extract/.../dsh-credentials/README.zh.md`
- CLI：`asar-extract/.../dsh/lib/bin.js`、`dsh-desktop-host/lib/cli.js`、`dsh/lib/profile-boot-C14i-8IN.js`
