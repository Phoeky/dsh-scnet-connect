# SCNet Connect

[![npm](https://img.shields.io/npm/v/dsh-scnet-connect)](https://www.npmjs.com/package/dsh-scnet-connect)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

把 **SCNet 模型**接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。
可**免客户端登录**，使用免费模型（`SCNet-Max`，基座基本可确定为 DeepSeek Flash）。

- **零客户端**：不装 SCNet 桌面客户端，用手机短信登录即可使用
- **零配置**：装了客户端的话，自动读凭据、自动发现免费模型
- **设置页管理**：账号、登录、模型开关都在 DSH 设置里

---

## 快速开始

### 方式一：免客户端登录（推荐）

```bash
dsh plugin --profile desktop add dsh-scnet-connect
```

然后打开 **设置 → SCNet Connect**：

1. 填手机号 → 点「获取验证码」→ 输入图形验证码
2. 点「发送短信验证码」→ 填收到的 6 位验证码
3. 点「登录」

登录成功后插件会自动换取模型 Key，无需其他操作。

### 方式二：用本机 SCNet 客户端

先装好 SCNet 客户端并登录，正常发起一次对话（让客户端把凭据落到本地），然后：

```bash
dsh plugin --profile desktop add dsh-scnet-connect
```

插件会自动读取凭据，客户端之后可以关掉。

> 装完如果没生效，改一下 profile 的 `cordis.patch.yml`（加一行注释再保存）触发热重载，或重启 DSH。

---

## 使用

在 DSH 的模型选择器里选 **SCNet Connect → SCNet-Max**。

设置页可以：

| 功能 | 说明 |
| --- | --- |
| 查看账号 | 用户名、ID、脱敏手机号、登录态剩余天数 |
| 登录 / 退出 | 短信登录；退出后插件停止供 Key，可随时「恢复使用」 |
| 只显示免费模型 | 默认开启。关闭后会把目录里所有模型都注册出来（可能产生费用） |
| 刷新模型 | 重新读模型目录并用网关校验可用性 |

---

## 配置

全部有默认值，一般不用改。需要时在 profile 的 `cordis.patch.yml` 里给 entry 加 `config`：

```yaml
- id: scnet-connect
  name: dsh-scnet-connect
  config:
    freeOnly: true           # 只注册免费模型（默认开）
    credentialSource: auto   # auto | client | login
    modelIds: ''             # 逗号分隔；留空 = 自动发现
    contextWindow: 0         # 0 = 跟随目录/默认
    maxTokens: 0             # 0 = 跟随目录/默认
```

<details>
<summary>全部字段</summary>

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `credentialSource` | `auto` | `auto` 先客户端再登录；`client` 只用客户端；`login` 只用设置页登录 |
| `freeOnly` | `true` | 只注册 `priceLabel=free` 的模型 |
| `credentialDir` | 空 | 默认 `~/.sclaw/agent/scnet-credentials` |
| `apiKey` | 空 | 直接指定 Key（会明文存在配置文件里） |
| `baseUrl` | `https://api.scnet.cn/api/llm/v1` | 网关地址 |
| `modelIds` | 空 | 指定模型 id，逗号分隔 |
| `modelName` | 空 | 自定义显示名（仅单模型时生效） |
| `contextWindow` / `maxTokens` | `0` | 覆盖上下文/输出上限 |
| `inputImages` | `true` | 是否声明接受图片 |
| `reasoning` | `true` | 是否声明支持思考等级 |
| `verifyWithGateway` | `true` | 刷新时用 `GET /models` 校验 |

</details>

---

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 模型选择器里没有 SCNet Connect | 确认插件已装、profile 的 `dsh.profile.bundles` 里有 `dsh-scnet-connect`，然后触发热重载或重启 DSH |
| 设置页没有 SCNet Connect | 需要 DSH `0.2.2` 及以上（`settings.section` slot） |
| 没有可用模型 | 点「刷新模型」；免客户端模式下登录成功后会自动刷新 |
| 报 `No API key for provider: scnet` | 没有可用凭据：去设置页登录，或装客户端并登录一次 |
| 提示「平台会话已过期」 | 在设置页重新登录一次 |
| 短信收不到 | 确认手机号正确、图形验证码没填错；平台有 60 秒与每小时次数限制 |
| 上游 429 | 插件不屏蔽限流，降低并发或稍等重试 |

---

## 安全

- **不接收账号密码**：只走短信验证码，密码从不经过插件。
- 登录会话存于 `$DSH_HOME/scnet-session.json`（权限 `0600`），退出登录即删除。
- **这两样东西等价于你的账号权限**：不要复制给他人，不要提交进仓库。
- 插件只在本机回环地址上暴露设置页路由，且**不返回** Key / Cookie / 验证码明文。
- 若用 `apiKey` 配置项，它以明文存在 profile 的 `cordis.patch.yml` 里，请自行控制权限。

> `sk-` Key 是账号级凭据、与 SCNet 客户端共用，平台没有吊销接口。
> 所以「退出登录」的语义是**停止使用**，不是让 Key 在平台失效；要作废请到 SCNet 平台重置账号凭据。

---

## 已知限制

- 免费模型取决于平台：目前只有 `SCNet-Max` 标记为 `free`。
- 「免费」是平台侧的**限时**政策，不是永久免费；本插件不提供额度，也不绕过计费。
- 插件内**不提供微信扫码**（平台二维码接口对非微信客户端恒返回 402）。
- 用的是未公开的客户端内部接口，SCNet 客户端升级后可能变化。

---

## 开发

```bash
git clone <repo> && cd dsh-scnet-connect
node tools/check.mjs          # 自检：凭据、模型目录、账号
node tools/check.mjs --live   # 额外请求一次 /models
```

```text
lib/index.js            插件入口：注册 provider、设置页路由
lib/client.js           浏览器侧：设置页卡片
lib/scnet-login.js      免客户端登录状态机
lib/scnet-platform.js   平台接口封装
lib/scnet-web-login.js  短信登录与验证码
lib/scnet-catalog.js    模型目录发现与过滤
lib/scnet-credential.js 客户端凭据读取
lib/scnet-models.js     模型描述符
```

## License

[MIT](LICENSE)
