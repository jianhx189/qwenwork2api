# QwenWork2API

把**千问办公**（QwenWork）的办公积分变成标准的 **OpenAI 兼容 API**，自带实时看板。
零第三方依赖，一个 `node server.mjs` 就能跑。

> Turn QwenWork office credits into an OpenAI-compatible API with a built-in live dashboard.
> Zero dependencies — just `node server.mjs`.

---

## 为什么用它

- **一个 Base URL 打通全部档位**：`/v1/chat/completions` 直接用，Claude Code、Codex、Chatbox、DSH、OpenWebUI 都能接。
- **零依赖**：不用 Node 之外的任何东西，不用 Docker，不用数据库，账号与用量都是本地 JSON。
- **自带看板**：今日调用 / 成功率 / 平均耗时 / P95 / 剩余积分 / 24 小时趋势 / 模型与账号分布 / 调用日志，5 秒自动刷新。
- **一键试跑**：看板上每个模型都有「试跑」按钮，服务端真实打一条，回耗时和正文——不用猜某个档位现在能不能出字。
- **多账号轮转**：号池按剩余积分优先挑，401 自动续期、5xx/429 换号重试，已向客户端写字节后绝不重试（不会重复输出）。
- **响应模型名改写**：上游返回内部档位名，转发时改回你请求的模型名，客户端只看到自己选的那个。

## 支持的档位

档位名来自官方客户端 `modelSelector` 枚举；中文标签取自客户端 `dynamic-text` 文案。

| 对外模型名 | 上游档位 | 官方标签 | 说明 |
|---|---|---|---|
| `qwenwork-lite` | `qwork-lite` | 轻量 | 最省积分的档 |
| `qwenwork-standard` | `qwork-auto` | 标准 | 日常任务 |
| `qwenwork-advanced` | `qwork-advanced` | 高级 | 复杂任务 |
| `qwenwork-ultimate` | `qwork-ultimate` | 旗舰 | 官方「专业旗舰」 |
| `qwenwork-enterprise` | `safety` | 企业专属 | 合规场景 |
| `qwen3.7-max` | `qmodel_latest` | Qwen3.7-Max | 官方「Qwen 最强模型」 |
| `qwen3.6-plus` | `q35model_preview` | Qwen3.6-Plus-DogFooding | 内测档 |
| `qwen3.8max` / `qwen3.8` | `qwork-advanced` | — | 兼容旧调用，等同高级档 |

模型名大小写不敏感（`Qwen3.8-Max` 也能用）。**具体能用哪几个由账号套餐决定**，没有权限的上游会回 403。

## 快速开始

```bash
git clone https://github.com/jianhx189/qwenwork2api.git
cd qwenwork2api

# 1) 取签名组件（唯一硬依赖，从官方 Linux 包提取）
curl -LO https://assets.qwenwork.cn/release/latest/qwenworkcn-linux-amd64.deb
dpkg-deb -x qwenworkcn-linux-amd64.deb unpack
cp unpack/opt/apps/QwenWorkCN/resources/qoder-auth-wasm/qoder_auth_wasm_bg.wasm ./
rm -rf unpack qwenworkcn-linux-amd64.deb

# 2) 起服务
node server.mjs
```

启动后会打印后台地址（含管理令牌）：

```
[qwenwork2api] listening :4021
[qwenwork2api] admin  http://127.0.0.1:4021/admin?token=xxxxx
[qwenwork2api] wasm   OK 3f2a…  288929B
```

打开后台 → 右上角「添加账号」→ 浏览器里完成一次设备授权 → 新建一个令牌 → 客户端填：

```
Base URL : http://<你的地址>:4021/v1
API Key  : sk-qw-...        # 后台新建的那个
Model    : qwenwork-advanced
```

## 后台看板

- 五个 KPI：今日调用、成功率、平均耗时（含 P95）、剩余积分、可用账号
- 24 小时调用趋势（成功/失败堆叠，悬浮看每小时明细）
- 模型分布 / 账号分布
- 模型目录：每个档位的今日调用、平均耗时、健康点、**试跑**按钮
- 账号：套餐、剩余/已用积分进度条、刷新余额、删除
- 令牌：掩码展示、一键复制完整 Key、停用/启用、删除
- 调用日志：全部 / 成功 / 失败 / 重试 四档筛选，滚到底自动暂停刷新
- 快捷键：`R` 刷新，`Esc` 关弹窗；支持深色模式（跟随系统）

管理令牌存在 `data/admin_token.txt`，也可以用 `ADMIN_TOKEN` 环境变量覆盖。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `4021` | 监听端口 |
| `ADMIN_TOKEN` | 随机生成 | 管理令牌 |
| `QW_MAX_RETRIES` | `2` | 首次之外的额外尝试次数 |
| `QW_HEADER_TIMEOUT_MS` | `45000` | 首字节超时（会真正中断底层请求） |
| `QW_STREAM_IDLE_MS` | `60000` | 流式空闲超时 |
| `REFRESH_MS` | `600000` | 定时刷新余额间隔 |
| `QWENWORK_WASM_PATH` | 同目录 | 签名组件路径 |
| `QWENWORK_CLIENT_VERSION` | 内置 | 伪装用的客户端版本 |

## 文件边界

```
server.mjs               HTTP / 账号池 / 重试 / 管理 API
admin.html               看板（单文件，无外部资源）
lib/                     协议层（账号、签名、聊天转发）
data/state.json          账号与令牌（首次运行自动生成，勿提交）
data/logs.jsonl          调用流水
qoder_auth_wasm_bg.wasm  签名组件（从官方包提取，勿提交）
```

## 常见问题

**上游回 403 / 没有权限**：账号套餐不含该档位，换档位或换号。

**`max_tokens` 报错**：千问办公上游硬上限 32000，超过要自己夹。

**首帧慢**：这个网关没有前缀缓存，长上下文由 prefill 决定；想要快就把上下文压小或改用带缓存的通道。

**多个账号一起跑会怎样**：按剩余积分优先挑号，失败换号，不会同时压同一个号。

## AI 一键安装

把下面整段丢给 Claude Code / Codex / Cursor：

> 在远端 Linux 机器上帮我部署 qwenwork2api：
> 1. `git clone https://github.com/jianhx189/qwenwork2api.git && cd qwenwork2api`
> 2. 下载 `https://assets.qwenwork.cn/release/latest/qwenworkcn-linux-amd64.deb`，用 `dpkg-deb -x` 解开，把 `opt/apps/QwenWorkCN/resources/qoder-auth-wasm/qoder_auth_wasm_bg.wasm` 拷到项目根目录，删掉 deb 和解包目录
> 3. `node server.mjs`（Node ≥ 18.17），确认 `/health` 返回 `wasm:true`
> 4. 用 PM2 常驻：`pm2 start server.mjs --name qwenwork2api && pm2 save`
> 5. 把启动日志里的后台地址（含 token）和 `/health` 结果发我，并提醒我去点设备授权

## License

MIT。协议层来自 [tianyn1990/qwenwork-magpie](https://github.com/tianyn1990/qwenwork-magpie)（MIT），服务层与看板由 [jianhx](https://github.com/jianhx189) 编写。

本项目只做账号自助接入，请遵守上游服务条款；签名组件不入库，需从官方安装包自行提取。
