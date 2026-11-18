// QwenWork Gateway — 千问办公 → OpenAI 兼容网关
// 基于 tianyn1990/qwenwork-magpie (MIT) 的 lib/ 实现，去掉 Magpie 宿主依赖，改为独立服务 + 管理后台。
import http from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync } from 'node:fs'
import { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { GATEWAY, MODELS, FALLBACK_VERSION, FALLBACK_RELEASE } from './lib/constants.mjs'
import { startLogin, pollLogin, finishLogin, getAccount, renewAuth, quotaForMagpie } from './lib/account.mjs'
import { chatResponse } from './lib/chat.mjs'
import { prepareQwenworkInfer } from './lib/wasm.mjs'
import { deriveMachineId, deviceProfile, newSalt } from './lib/fingerprint.mjs'
import { claimDaily, fetchBalance, fetchWallets, today } from './lib/earn.mjs'
import { ProviderError, errorResponse, redact } from './lib/errors.mjs'
import { PanelAuth } from './lib/panelauth.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(ROOT, 'data')
const STATE_FILE = path.join(DATA, 'state.json')
const LOG_FILE = path.join(DATA, 'logs.jsonl')
const WASM_FILE = process.env.QWENWORK_WASM_PATH || path.join(ROOT, 'qoder_auth_wasm_bg.wasm')
const PORT = Number(process.env.PORT || 4021)

// 对外模型名 → 千问办公档位。档位键取自官方客户端 2.1.0 的
// resources/dynamic-text/qwenwork.json（model.* 键）+ app.asar 的 tier 枚举。
// ⚠️ 上游档位名以「客户端里真正可选的 key」为准（2026-11 实测）：
//   lite / flash / pro / flagship / economy / advanced 可用；
//   `standard`、`premium`、`qwork-lite`、`qmodel_latest`、`dmodel_latest`、`gmodel_latest` 被套餐挡（403 Model is not available for this user）。
//   DeepSeek 的真实键是 `deepseek-flash` / `deepseek-v4-pro`，GLM 是 `glm-5.3`。
const PUBLIC_MODELS = {
  'qwen3.8max': 'qwork-advanced',        // 兼容旧调用（实测 200）
  'qwen3.8': 'qwork-advanced',
  'qwen3.8-max': 'qwen3.8-max-preview',  // qmodel_latest 被套餐挡，用能跑的预览档承接
  'qwen3.8-max-preview': 'qwen3.8-max-preview',
  'qwen3.6-plus': 'q35model_preview',    // 套餐不含时上游回 403
  'deepseek-v4.1-flash': 'deepseek-flash', // ★ 中转站侧通用名（fast-router/WB 一致），含 .1
  'deepseek-v4-flash': 'deepseek-flash', // ★ DeepSeek V4 Flash（客户端可选）
  'deepseek-flash': 'deepseek-flash',    // 别名
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'glm-5.3': 'glm-5.3',
  // 2026-11-18 客户端选择器新增第三方档位（客户端 2.1.0 的「指定模型」列表）
  'glm-5.3-flash': 'glm-5.3-flash',
  'kimi-k3.1-pro': 'kimi-k3.1-pro',
  'minimax-m3.1-flash': 'minimax-m3.1-flash',
  'step-5-preview': 'step-5-preview',
  'qwen4-max': 'qwen4-max',              // 上游没有 qwen4-max-preview 这个键，落到 qwen4-max
  'qwen4-max-preview': 'qwen4-max',
  'qwenwork-lite': 'lite',               // 经济
  'qwenwork-standard': 'flash',          // 标准 = flash（`standard` 这个键被挡）
  'qwenwork-advanced': 'pro',            // 高级 = pro
  'qwenwork-ultimate': 'flagship',        // 旗舰 = flagship
  'qwenwork-enterprise': 'safety',       // 企业专属（套餐不含时 403）
}
// 大小写不敏感解析：上游调用常用 Qwen3.8-Max 这种写法
const PUBLIC_LOWER = new Map(Object.keys(PUBLIC_MODELS).map(k => [k.toLowerCase(), k]))
function resolveModel(name) {
  if (!name || typeof name !== 'string') return null
  if (PUBLIC_MODELS[name]) return { publicModel: name, upstream: PUBLIC_MODELS[name] }
  const hit = PUBLIC_LOWER.get(name.trim().toLowerCase())
  return hit ? { publicModel: hit, upstream: PUBLIC_MODELS[hit] } : null
}

mkdirSync(DATA, { recursive: true })

// ---------- 存储 ----------
function loadState() {
  if (!existsSync(STATE_FILE)) return { accounts: [], keys: [], settings: {} }
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return { accounts: s.accounts ?? [], keys: s.keys ?? [], settings: s.settings ?? {} }
  } catch { return { accounts: [], keys: [], settings: {} } }
}
let state = loadState()
function saveState() {
  const tmp = STATE_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  writeFileSync(STATE_FILE, readFileSync(tmp))
}
function log(entry) {
  try { appendFileSync(LOG_FILE, JSON.stringify({ ts: Date.now(), ...entry }) + '\n') } catch {}
}

// ---------- 管理令牌 ----------
const ADMIN_FILE = path.join(DATA, 'admin_token.txt')
let ADMIN_TOKEN = process.env.ADMIN_TOKEN || (existsSync(ADMIN_FILE) ? readFileSync(ADMIN_FILE, 'utf8').trim() : '')
const panelAuth = new PanelAuth(DATA, { defaultPassword: process.env.PANEL_PASSWORD || '147369qAz' })
setInterval(() => panelAuth.sweep(), 3600 * 1000).unref()
if (!ADMIN_TOKEN) {
  ADMIN_TOKEN = randomBytes(18).toString('base64url')
  writeFileSync(ADMIN_FILE, ADMIN_TOKEN, { mode: 0o600 })
}

// ---------- 签名组件 ----------
function runtimeInfo() {
  if (!existsSync(WASM_FILE)) return { ok: false, error: `未找到签名组件：${WASM_FILE}` }
  const st = statSync(WASM_FILE)
  const bytes = readFileSync(WASM_FILE)
  return {
    ok: true,
    wasmPath: WASM_FILE,
    version: process.env.QWENWORK_CLIENT_VERSION || FALLBACK_VERSION,
    releaseVersion: process.env.QWENWORK_RELEASE_VERSION || FALLBACK_RELEASE,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: st.size,
  }
}

// ---------- 工具 ----------
const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' })
  res.end(buf)
}
const text = (res, code, body, type = 'text/plain; charset=utf-8') => {
  const buf = Buffer.from(body)
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' })
  res.end(buf)
}
async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new ProviderError('请求体过大', 413)
    chunks.push(c)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { throw new ProviderError('请求体不是有效 JSON', 400) }
}
const publicAccount = a => ({
  id: a.id, email: a.email, name: a.name, uid: a.uid, plan: a.plan,
  organizationId: a.organizationId, status: a.status, quota: a.quota ?? null,
  createdAt: a.createdAt, lastRefresh: a.lastRefresh, accessExpires: a.accessExpires,
  refreshExpires: a.refreshExpires, hasRefresh: !!a.refresh,
  claim: a.claim ?? null, balance: a.balance ?? null, wallets: a.wallets ?? null,
  fingerprint: {
    machineId: a.machineId ? `${a.machineId.slice(0, 8)}…${a.machineId.slice(-4)}` : '',
    platform: a.device?.platform ?? '', arch: a.device?.arch ?? '',
    version: a.device?.version ?? '', release: a.device?.releaseVersion ?? '',
    saltRot: a.fpRotated ?? 0,
  },
})

// ---------- 设备指纹（参考 WB 反代：一账号一台固定设备，可换指纹） ----------
function ensureDevice(acc) {
  const rt = runtimeInfo()
  if (!acc.fpSalt) acc.fpSalt = newSalt()
  const base = acc.device && acc.device.platform ? acc.device : deviceProfile(acc.uid)
  // 平台/架构一期固定（等于「这台机器没变」），客户端版本永远跟运行时一致
  acc.device = { ...base, version: rt.version, releaseVersion: rt.releaseVersion }
  const derived = deriveMachineId(acc.uid, acc.fpSalt)
  // 登录时拿到的 machineId 不动（可能已绑在 refresh token 上），只补缺失的
  if (!acc.machineId) acc.machineId = derived
  return acc
}
function rotateFingerprint(acc) {
  acc.fpSalt = newSalt()
  acc.fpRotated = (acc.fpRotated ?? 0) + 1
  acc.device = null
  ensureDevice(acc)
  acc.machineId = deriveMachineId(acc.uid, acc.fpSalt)
  return acc
}

// ---------- 每日免费积分（千问办公的「签到」） ----------
async function claimAccount(acc, { force = false } = {}) {
  const day = today()
  if (!force && acc.claim?.date === day && acc.claim?.ok) return acc.claim
  // 已知这个环境没有领取接口：别每小时白打一次上游，只在手动点（force）时再试
  if (!force && acc.claim?.unsupported) return acc.claim

  const r = await claimDaily(acc)
  acc.claim = {
    date: day, ok: r.ok, credits: r.credits ?? null,
    message: r.message, unsupported: r.unsupported === true || (force ? false : acc.claim?.unsupported === true && r.unsupported === true),
    at: Date.now(),
  }
  if (r.unsupported) acc.claim.unsupported = true
  if (r.ok) {
    const bal = await fetchBalance(acc).catch(() => null)
    if (bal) acc.balance = bal
  }
  log({ type: 'claim', account: acc.email || acc.uid, ok: r.ok, credits: r.credits ?? null, message: r.message })
  return acc.claim
}

// ---------- 账号刷新 ----------
async function refreshAccount(acc, { force = false } = {}) {
  const rt = runtimeInfo()
  if (!rt.ok) throw new ProviderError(rt.error, 503)
  const now = Date.now()
  if (acc.accessExpires && acc.accessExpires - now < 5 * 60 * 1000 && acc.refresh) {
    const next = await renewAuth(acc, rt)
    Object.assign(acc, next)
  }
  const ctx = await getAccount(acc, rt)
  const q = ctx.quota ?? {}
  acc.quota = {
    remaining: typeof q.remaining === 'number' ? q.remaining : null,
    total: typeof q.total === 'number' ? q.total : null,
    used: typeof q.used === 'number' ? q.used : null,
    exceeded: q.exceeded === true || (typeof q.remaining === 'number' && q.remaining <= 0),
  }
  acc.plan = ctx.plan?.name ?? acc.plan ?? ''
  acc.status = acc.quota.exceeded ? 'quota_exhausted' : 'ok'
  // 余额与钱包：prod adapter 可用（/user/balance、/user/wallets），失败不影响刷新结果
  const bal = await fetchBalance(acc).catch(() => null)
  if (bal) acc.balance = bal
  const ws = await fetchWallets(acc).catch(() => null)
  if (ws) acc.wallets = ws
  acc.lastRefresh = now
  saveState()
  return acc
}

// ---------- 授权流程（内存态） ----------
const flows = new Map()

// ---------- 令牌 ----------
function checkKey(authHeader) {
  const raw = (authHeader || '').replace(/^Bearer\s+/i, '').trim()
  if (!raw) return null
  const k = state.keys.find(x => x.key === raw)
  if (!k) return null
  if (k.disabled) return null
  k.lastUsed = Date.now()
  k.requests = (k.requests ?? 0) + 1
  return k
}

// ---------- 业务：OpenAI 端点 ----------
// ---------- 重试策略（类比 WB：换号重试 + 首字节超时 + 流式空闲超时） ----------
const MAX_RETRIES = Number(process.env.QW_MAX_RETRIES || 2)               // 首次之外的额外尝试次数
const HEADER_TIMEOUT = Number(process.env.QW_HEADER_TIMEOUT_MS || 45000)  // 首字节超时
const STREAM_IDLE = Number(process.env.QW_STREAM_IDLE_MS || 60000)        // 流式空闲超时
const sleep = ms => new Promise(r => setTimeout(r, ms))

function pickAccount(exclude = new Set()) {
  // claimOnly：daily 环境授权的号只能拿来领取，不能进聊天轮转（它的 token 在 prod 上无效）
  const all = state.accounts.filter(a => a.status !== 'quota_exhausted' && a.access && !a.claimOnly)
  if (!all.length) return null
  // 优先选没试过的号；都试过（或只有一个号）时允许同号重试，不能直接放弃
  const fresh = all.filter(a => !exclude.has(a.id))
  const pool = fresh.length ? fresh : all
  return pool.sort((a, b) => (b.quota?.remaining ?? 0) - (a.quota?.remaining ?? 0))[0]
}

// 首字节超时：真正中断底层 fetch，而不是只在表面 reject
async function upstreamWithTimeout(body, acc, rt) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('header timeout')), HEADER_TIMEOUT)
  try {
    return await chatResponse(body, acc, rt, { signer: prepareQwenworkInfer, signal: ctrl.signal })
  } catch (e) {
    if (ctrl.signal.aborted) throw new ProviderError(`千问办公 ${Math.round(HEADER_TIMEOUT / 1000)}s 未返回首字节`, 504, 'upstream_timeout')
    throw e
  } finally { clearTimeout(timer) }
}

// 流式读一帧，带空闲超时（对应 WB 的 stream idle timeout）
async function readWithTimeout(reader) {
  let timer
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new ProviderError(`千问办公流式 ${Math.round(STREAM_IDLE / 1000)}s 无数据`, 504, 'stream_idle_timeout')), STREAM_IDLE) })
    ])
  } finally { clearTimeout(timer) }
}

// 单次尝试：拿到响应就转发；开始写字节后置标，供上层判断能否重试
async function serveOnce(res, key, body, rt, acc, publicModel, upstreamModel, started) {
  if (!acc.quota || Date.now() - (acc.lastRefresh ?? 0) > 10 * 60 * 1000) {
    await refreshAccount(acc).catch(() => {})
  }
  const upstream = await upstreamWithTimeout(body, acc, rt)
  const headers = Object.fromEntries(upstream.headers.entries())
  headers['X-Gateway-Account'] = acc.email || acc.uid
  headers['X-Gateway-Attempts'] = String(res._qwAttempts || 1)
  delete headers['content-length']
  const rename = (buf) => Buffer.from(
    buf.toString('utf8')
      .replaceAll(`"model":"${upstreamModel}"`, `"model":"${publicModel}"`)
      .replaceAll(`"model": "${upstreamModel}"`, `"model": "${publicModel}"`)
  )
  res.writeHead(upstream.status, headers)
  res._qwStarted = true
  if (upstream.body) {
    const reader = upstream.body.getReader()
    try {
      while (true) {
        const { value, done } = await readWithTimeout(reader)
        if (done) break
        res.write(rename(Buffer.from(value)))
      }
    } finally { res.end() }
  } else res.end()
  log({ type: 'chat', key: key.name, account: acc.email || acc.uid, model: publicModel, stream: !!body.stream, ms: Date.now() - started, status: upstream.status, attempts: res._qwAttempts || 1 })
}

async function handleChat(req, res, key) {
  let body = await readBody(req)
  const hit = resolveModel(body?.model)
  if (!hit) {
    return json(res, 400, { error: { message: `模型 ${body?.model} 不存在，可用模型：${Object.keys(PUBLIC_MODELS).join(', ')}`, type: 'invalid_request_error' } })
  }
  const { publicModel, upstream: upstreamModel } = hit
  body = { ...body, model: upstreamModel }
  const rt = runtimeInfo()
  if (!rt.ok) return json(res, 503, { error: { message: rt.error, type: 'provider_unavailable' } })

  const started = Date.now()
  const tried = new Set()
  let lastErr = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const acc = body?.accountId
      ? state.accounts.find(a => a.id === body.accountId)
      : pickAccount(tried)
    if (!acc) break
    tried.add(acc.id)
    res._qwAttempts = attempt + 1
    res._qwStarted = false
    try {
      await serveOnce(res, key, body, rt, acc, publicModel, upstreamModel, started)
      return
    } catch (error) {
      const e = error instanceof ProviderError ? error : new ProviderError(redact(error.message || '千问办公连接失败'), 503)
      lastErr = e
      // 已经向客户端吐过内容，再重试会重复输出，直接收尾
      if (res._qwStarted || res.headersSent) { res.end(); return }
      const retryable = e.status >= 500 || e.status === 429 || e.status === 401
      if (!retryable || attempt >= MAX_RETRIES) break
      log({ type: 'retry', key: key.name, account: acc.email || acc.uid, model: publicModel, attempt: attempt + 1, error: e.message })
      // 401：先续期再试；429/限流：标记该账号，下一轮换号
      if (e.status === 401) { await refreshAccount(acc, { force: true }).catch(() => {}) }
      if (e.status === 429) { acc.status = 'quota_exhausted' }
      await sleep(Math.min(2000, 500 * (attempt + 1)))
    }
  }

  const e = lastErr ?? new ProviderError('没有可用的千问办公账号，请先在后台授权', 503)
  log({ type: 'chat_error', key: key.name, model: publicModel, ms: Date.now() - started, error: e.message })
  if (!res.headersSent) {
    const r = errorResponse(e)
    json(res, e.status, await r.json())
  } else res.end()
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname
  try {
    // 管理页
    if (p === '/admin' || p === '/admin/') {
      const fresh = path.join(ROOT, 'panel.html')
      const html = readFileSync(existsSync(fresh) ? fresh : path.join(ROOT, 'admin.html'))
      return text(res, 200, html, 'text/html; charset=utf-8')
    }
    // 旧版面板保留一份入口
    if (p === '/admin/legacy') {
      const html = readFileSync(path.join(ROOT, 'admin.html'))
      return text(res, 200, html, 'text/html; charset=utf-8')
    }

    // 管理 API
    if (p.startsWith('/admin/api/')) {
      const action = p.slice('/admin/api/'.length)
      const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || ''

      // ---- 无需登录的三个端点 ----
      if (action === 'login' && req.method === 'POST') {
        const { password } = await readBody(req)
        if (!panelAuth.verify(password)) { await sleep(300); return json(res, 401, { error: '密码不正确' }) }
        return json(res, 200, { ok: true, token: panelAuth.issue(), expiresIn: Math.floor(panelAuth.ttlMs / 1000) })
      }
      if (action === 'session' && req.method === 'GET') {
        const ok = bearer === ADMIN_TOKEN || panelAuth.check(bearer)
        return json(res, 200, { ok })
      }

      if (!(bearer === ADMIN_TOKEN || panelAuth.check(bearer))) return json(res, 401, { error: '未登录或会话已过期' })

      if (action === 'logout' && req.method === 'POST') {
        panelAuth.revoke(bearer)
        return json(res, 200, { ok: true })
      }
      if (action === 'password' && req.method === 'POST') {
        const { current, next } = await readBody(req)
        if (!panelAuth.verify(current)) return json(res, 400, { error: '当前密码不正确' })
        if (!next || String(next).length < 6) return json(res, 400, { error: '新密码至少 6 位' })
        panelAuth.setPassword(String(next))
        return json(res, 200, { ok: true, token: panelAuth.issue() })
      }

      if (action === 'state' && req.method === 'GET') {
        const rt = runtimeInfo()
        return json(res, 200, {
          runtime: { ok: rt.ok, error: rt.error, version: rt.version, releaseVersion: rt.releaseVersion, sha256: rt.sha256, bytes: rt.bytes, wasmPath: rt.wasmPath },
          accounts: state.accounts.map(publicAccount),
          keys: state.keys.map(k => ({ ...k, key: k.key.slice(0, 8) + '…' + k.key.slice(-4) })),
          models: Object.entries(PUBLIC_MODELS).map(([id, upstream]) => ({ id, name: MODELS[upstream]?.name ?? id, limit: MODELS[upstream]?.limit })),
          stats: {
            accounts: state.accounts.length,
            usable: state.accounts.filter(a => a.status === 'ok').length,
            remaining: state.accounts.reduce((s, a) => s + (a.quota?.remaining ?? 0), 0),
            requests: state.keys.reduce((s, k) => s + (k.requests ?? 0), 0),
          },
        })
      }

      if (action === 'login/start' && req.method === 'POST') {
        const rt = runtimeInfo()
        if (!rt.ok) return json(res, 400, { error: rt.error })
        // origin 可选：'daily' 走 daily.gateway.qwenwork.cn（那个环境有每日领取接口）
        const body = await readBody(req).catch(() => ({}))
        const origin = body?.origin === 'daily'
          ? (process.env.QWENWORK_DAILY_ORIGIN || 'https://daily.gateway.qwenwork.cn')
          : undefined
        const flow = startLogin(rt, origin)
        const id = randomUUID()
        flows.set(id, { flow, createdAt: Date.now() })
        return json(res, 200, { flowId: id, url: flow.url, origin: flow.origin || null, expiresIn: 300 })
      }

      if (action === 'login/poll' && req.method === 'GET') {
        const id = url.searchParams.get('flowId')
        const item = flows.get(id)
        if (!item) return json(res, 404, { error: '授权流程不存在或已过期' })
        if (Date.now() - item.createdAt > 10 * 60 * 1000) { flows.delete(id); return json(res, 408, { error: '授权超时，请重新生成链接' }) }
        const tokens = await pollLogin(item.flow)
        if (!tokens) return json(res, 200, { status: 'pending' })
        const auth = await finishLogin(item.flow, tokens)
        flows.delete(id)
        let acc = state.accounts.find(a => a.uid === auth.uid)
        if (!acc) {
          acc = { id: randomUUID(), createdAt: Date.now() }
          state.accounts.push(acc)
        }
        Object.assign(acc, auth, { status: 'ok' })
        // daily 环境授权的号：领取要回 daily 打（prod 没有那条路由）
        if (item.flow.origin && item.flow.origin !== 'https://gateway.qwenwork.cn') {
          acc.claimOrigin = item.flow.origin
          acc.claimOnly = true
        }
        ensureDevice(acc)
        saveState()
        await refreshAccount(acc, { force: true }).catch(() => {})
        log({ type: 'login', account: acc.email || acc.uid })
        return json(res, 200, { status: 'ok', account: publicAccount(acc) })
      }

      if (action === 'account/refresh' && req.method === 'POST') {
        const { id } = await readBody(req)
        const acc = state.accounts.find(a => a.id === id)
        if (!acc) return json(res, 404, { error: '账号不存在' })
        await refreshAccount(acc, { force: true })
        return json(res, 200, { account: publicAccount(acc) })
      }

      if (action === 'account/claim' && req.method === 'POST') {
        const { id } = await readBody(req)
        const acc = state.accounts.find(a => a.id === id)
        if (!acc) return json(res, 404, { error: '账号不存在' })
        const r = await claimAccount(acc, { force: true })
        saveState()
        return json(res, 200, { ok: r.ok, claim: r, account: publicAccount(acc) })
      }

      if (action === 'account/fingerprint' && req.method === 'POST') {
        const { id } = await readBody(req)
        const acc = state.accounts.find(a => a.id === id)
        if (!acc) return json(res, 404, { error: '账号不存在' })
        rotateFingerprint(acc)
        saveState()
        log({ type: 'fingerprint', account: acc.email || acc.uid, rot: acc.fpRotated })
        return json(res, 200, { ok: true, account: publicAccount(acc) })
      }

      if (action === 'account/delete' && req.method === 'POST') {
        const { id } = await readBody(req)
        state.accounts = state.accounts.filter(a => a.id !== id)
        saveState()
        return json(res, 200, { ok: true })
      }

      if (action === 'keys' && req.method === 'POST') {
        const { name, disabled, id } = await readBody(req)
        if (id) {
          const k = state.keys.find(x => x.id === id)
          if (!k) return json(res, 404, { error: '令牌不存在' })
          if (typeof disabled === 'boolean') k.disabled = disabled
          if (typeof name === 'string' && name) k.name = name
          saveState()
          return json(res, 200, { ok: true })
        }
        const key = 'sk-qw-' + randomBytes(24).toString('hex')
        const item = { id: randomUUID(), name: name || '默认令牌', key, createdAt: Date.now(), requests: 0, disabled: false }
        state.keys.push(item)
        saveState()
        return json(res, 200, { key, item: { ...item, key: item.key } })
      }

      if (action === 'keys/full' && req.method === 'GET') {
        const k = state.keys.find(x => x.id === url.searchParams.get('id'))
        if (!k) return json(res, 404, { error: '令牌不存在' })
        return json(res, 200, { key: k.key })
      }

      if (action === 'keys/delete' && req.method === 'POST') {
        const { id } = await readBody(req)
        state.keys = state.keys.filter(k => k.id !== id)
        saveState()
        return json(res, 200, { ok: true })
      }

      if (action === 'logs' && req.method === 'GET') {
        const n = Math.min(Number(url.searchParams.get('n') || 100), 1000)
        if (!existsSync(LOG_FILE)) return json(res, 200, { logs: [] })
        const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-n).reverse()
        return json(res, 200, { logs: lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) })
      }

      if (action === 'stats' && req.method === 'GET') {
        // 用量统计：近 24h 按小时、按模型、按账号、今日汇总
        const now = Date.now()
        const hourStart = now - (now % 3600000)
        const buckets = new Map()
        for (let i = 23; i >= 0; i--) {
          const t = hourStart - i * 3600000
          buckets.set(t, { t, n: 0, err: 0, ms: 0 })
        }
        const byModel = new Map(), byAccount = new Map(), byModelToday = new Map()
        let total = 0, errors = 0, today = 0, todayErr = 0, msSum = 0, msN = 0
        const lat = []
        const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
        if (existsSync(LOG_FILE)) {
          for (const line of readFileSync(LOG_FILE, 'utf8').split('\n')) {
            if (!line.trim()) continue
            let l; try { l = JSON.parse(line) } catch { continue }
            if (l.type !== 'chat' && l.type !== 'chat_error') continue
            total++
            const isErr = l.type === 'chat_error'
            if (isErr) errors++
            if (l.ms) { msSum += l.ms; msN++; lat.push(l.ms) }
            if (l.ts >= dayStart.getTime()) { today++; if (isErr) todayErr++ }
            const b = buckets.get(l.ts - (l.ts % 3600000))
            if (b) { b.n++; if (isErr) b.err++; if (l.ms) b.ms += l.ms }
            const mk = l.model || 'unknown'
            const cur = byModel.get(mk) || { model: mk, n: 0, err: 0, msSum: 0, msN: 0 }
            cur.n++; if (isErr) cur.err++
            if (l.ms) { cur.msSum += l.ms; cur.msN++ }
            byModel.set(mk, cur)
            if (l.ts >= dayStart.getTime()) {
              const tc = byModelToday.get(mk) || { model: mk, n: 0, err: 0 }
              tc.n++; if (isErr) tc.err++
              byModelToday.set(mk, tc)
            }
            const ak = l.account || 'unknown'
            const ac = byAccount.get(ak) || { account: ak, n: 0, err: 0 }
            ac.n++; if (isErr) ac.err++
            byAccount.set(ak, ac)
          }
        }
        lat.sort((a, b) => a - b)
        const p95 = lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : 0
        return json(res, 200, {
          hourly: [...buckets.values()].sort((a, b) => a.t - b.t).map(b => ({ ...b, avgMs: b.n ? Math.round(b.ms / b.n) : 0 })),
          byModel: [...byModel.values()].sort((a, b) => b.n - a.n).map(m => ({ model: m.model, n: m.n, err: m.err, avgMs: m.msN ? Math.round(m.msSum / m.msN) : 0 })),
          byModelToday: [...byModelToday.values()].sort((a, b) => b.n - a.n),
          byAccount: [...byAccount.values()].sort((a, b) => b.n - a.n),
          total, errors, today, todayErr,
          avgMs: msN ? Math.round(msSum / msN) : 0,
          p95Ms: p95,
          successRate: total ? Number(((total - errors) / total).toFixed(4)) : 1,
        })
      }

      if (action === 'bulk' && req.method === 'POST') {
        // 批量：全部刷新余额 / 全部领取每日积分（面板不要为每个号发一次请求）
        const { op } = await readBody(req)
        if (!['refresh', 'claim'].includes(op)) return json(res, 400, { error: '未知操作' })
        const out = []
        for (const acc of state.accounts) {
          try {
            if (op === 'refresh') await refreshAccount(acc, { force: true })
            else await claimAccount(acc, { force: true })
            out.push({ id: acc.id, email: acc.email || acc.uid, ok: true })
          } catch (e) {
            out.push({ id: acc.id, email: acc.email || acc.uid, ok: false, error: redact(e.message) })
          }
        }
        saveState()
        return json(res, 200, { ok: true, results: out })
      }

      if (action === 'usage' && req.method === 'GET') {
        // 近 N 天用量：按日 + 按模型聚合（面板「用量」页）
        const days = Math.min(Math.max(Number(url.searchParams.get('days') || 7), 1), 30)
        const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - (days - 1))
        const byDay = new Map(), byModel = new Map(), byKey = new Map()
        let total = 0, errs = 0, msSum = 0, msN = 0, tokens = 0
        if (existsSync(LOG_FILE)) {
          for (const line of readFileSync(LOG_FILE, 'utf8').split('\n')) {
            if (!line.trim()) continue
            let l; try { l = JSON.parse(line) } catch { continue }
            if (l.type !== 'chat' && l.type !== 'chat_error') continue
            if (l.ts < since.getTime()) continue
            const day = new Date(l.ts + 8 * 3600 * 1000).toISOString().slice(0, 10)
            const isErr = l.type === 'chat_error'
            total++; if (isErr) errs++
            if (l.ms) { msSum += l.ms; msN++ }
            if (l.tokens) tokens += l.tokens
            const d = byDay.get(day) || { day, n: 0, err: 0, tokens: 0, msSum: 0, msN: 0 }
            d.n++; if (isErr) d.err++; if (l.tokens) d.tokens += l.tokens; if (l.ms) { d.msSum += l.ms; d.msN++ }
            byDay.set(day, d)
            const mk = l.model || 'unknown'
            const m = byModel.get(mk) || { model: mk, n: 0, err: 0, tokens: 0 }
            m.n++; if (isErr) m.err++; if (l.tokens) m.tokens += l.tokens
            byModel.set(mk, m)
            const kk = l.key || '—'
            const k = byKey.get(kk) || { key: kk, n: 0, err: 0 }
            k.n++; if (isErr) k.err++
            byKey.set(kk, k)
          }
        }
        return json(res, 200, {
          days,
          total, errors: errs, tokens,
          avgMs: msN ? Math.round(msSum / msN) : 0,
          byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map(d => ({ ...d, avgMs: d.msN ? Math.round(d.msSum / d.msN) : 0 })),
          byModel: [...byModel.values()].sort((a, b) => b.n - a.n),
          byKey: [...byKey.values()].sort((a, b) => b.n - a.n),
        })
      }

      if (action === 'settings' && req.method === 'GET') {
        return json(res, 200, {
          settings: { claimEnabled: state.settings?.claimEnabled !== false },
          runtime: { version: runtimeInfo().version, releaseVersion: runtimeInfo().releaseVersion, port: PORT },
        })
      }
      if (action === 'settings' && req.method === 'POST') {
        const body = await readBody(req)
        state.settings = { ...(state.settings || {}) }
        if (typeof body.claimEnabled === 'boolean') state.settings.claimEnabled = body.claimEnabled
        saveState()
        return json(res, 200, { ok: true, settings: { claimEnabled: state.settings.claimEnabled !== false } })
      }

      if (action === 'models/health' && req.method === 'GET') {
        return json(res, 200, { health: state.modelHealth || {} })
      }
      if (action === 'models/health' && req.method === 'POST') {
        // 逐个模型真实打一条，记录可用性与耗时（套餐不含的会回 Model is not available for this user）
        const rt = runtimeInfo()
        if (!rt.ok) return json(res, 400, { error: rt.error })
        const names = Object.keys(PUBLIC_MODELS)
        const health = { ...(state.modelHealth || {}) }
        const out = []
        for (const name of names) {
          const hit = resolveModel(name)
          const acc = pickAccount()
          if (!hit || !acc) { out.push({ model: name, ok: false, error: 'no account' }); continue }
          const t0 = Date.now()
          try {
            const up = await chatResponse(
              { model: hit.upstream, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, stream: false },
              acc, rt, { signer: prepareQwenworkInfer })
            const raw = await up.text()
            let msg = raw
            try { const j = JSON.parse(raw); msg = j?.choices?.[0]?.message?.content ?? j?.error?.message ?? raw } catch {}
            const ok = up.status === 200
            health[name] = { ok, upstream: hit.upstream, status: up.status, ms: Date.now() - t0, at: Date.now(), error: ok ? '' : String(msg).slice(0, 120) }
          } catch (e) {
            health[name] = { ok: false, status: 0, ms: Date.now() - t0, at: Date.now(), error: redact(e.message || String(e)).slice(0, 120) }
          }
          out.push({ model: name, ...health[name] })
        }
        state.modelHealth = health
        saveState()
        return json(res, 200, { ok: true, results: out })
      }

      if (action === 'import' && req.method === 'POST') {
        // 从本机客户端 / 手工粘贴导入账号：只要 access(+refresh) 就够，自带 uid/email 可选
        const body = await readBody(req)
        const access = String(body.access || '').trim()
        if (!access) return json(res, 400, { error: '缺少 access token' })
        let uid = String(body.uid || '').trim()
        if (!uid) {
          try {
            const payload = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString('utf8'))
            uid = payload.user_id || payload.sub || ''
          } catch {}
        }
        if (!uid) return json(res, 400, { error: '无法确定 uid（token 不是 JWT？）' })
        const rt = runtimeInfo()
        if (!rt.ok) return json(res, 400, { error: rt.error })
        const existing = state.accounts.find(a => a.uid === uid)
        const acc = existing || {
          id: randomUUID(), uid,
          email: body.email || `phone_${uid}@phone.local`,
          name: body.name || '', plan: body.plan || '',
          createdAt: Date.now(), quota: {}, status: 'ok',
        }
        acc.access = access
        if (body.refresh) acc.refresh = String(body.refresh)
        try {
          const payload = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString('utf8'))
          if (payload.exp) acc.accessExpires = payload.exp * 1000
        } catch {}
        if (!existing) state.accounts.push(acc)
        ensureDevice(acc)
        await refreshAccount(acc, { force: true }).catch(() => null)
        saveState()
        log({ type: 'import', account: acc.email, ok: true })
        return json(res, 200, { ok: true, account: publicAccount(acc) })
      }

      if (action === 'test' && req.method === 'POST') {
        // 后台「试跑」：非流式打一条，回耗时与正文，用来验证新档位能否出字
        const { model = 'qwen3.8max', prompt = '用一句话介绍你自己', upstream } = await readBody(req)
        // upstream 直传：用来试还没收录的上游档位名（排障/挖新模型）
        const hit = upstream
          ? { publicModel: String(upstream), upstream: String(upstream) }
          : resolveModel(model)
        if (!hit) return json(res, 400, { error: '模型不存在' })
        const rt = runtimeInfo()
        if (!rt.ok) return json(res, 400, { error: rt.error })
        const acc = pickAccount()
        if (!acc) return json(res, 400, { error: '没有可用账号，请先授权' })
        const t0 = Date.now()
        try {
          const up = await chatResponse(
            { model: hit.upstream, allowUnknown: !!upstream, messages: [{ role: 'user', content: String(prompt).slice(0, 2000) }], max_tokens: 128, stream: false },
            acc, rt, { signer: prepareQwenworkInfer })
          const raw = await up.text()
          let out = raw
          try {
            const j = JSON.parse(raw)
            out = j?.choices?.[0]?.message?.content ?? j?.error?.message ?? raw
          } catch {}
          return json(res, 200, { ok: up.status === 200, status: up.status, model: hit.publicModel, upstream: hit.upstream, ms: Date.now() - t0, text: String(out).slice(0, 600) })
        } catch (e) {
          return json(res, 200, { ok: false, model: hit.publicModel, upstream: hit.upstream, ms: Date.now() - t0, error: redact(e.message || String(e)) })
        }
      }

      return json(res, 404, { error: 'not found' })
    }

    // OpenAI 兼容
    if (p === '/v1/models') {
      const k = checkKey(req.headers.authorization)
      if (!k) return json(res, 401, { error: { message: 'invalid api key', type: 'authentication_error' } })
      return json(res, 200, {
        object: 'list',
        data: Object.entries(PUBLIC_MODELS).map(([id, upstream]) => ({
          id, object: 'model', created: 0, owned_by: 'qwenwork',
          name: MODELS[upstream]?.name ?? id,
          context_length: MODELS[upstream]?.limit?.context ?? null,
          max_output_tokens: MODELS[upstream]?.limit?.output ?? null,
        })),
      })
    }

    if (p === '/v1/chat/completions' && req.method === 'POST') {
      const k = checkKey(req.headers.authorization)
      if (!k) return json(res, 401, { error: { message: 'invalid api key', type: 'authentication_error' } })
      return await handleChat(req, res, k)
    }

    if (p === '/health') {
      const rt = runtimeInfo()
      return json(res, 200, { ok: true, wasm: rt.ok, accounts: state.accounts.length, models: Object.keys(MODELS) })
    }

    return json(res, 404, { error: 'not found' })
  } catch (error) {
    const e = error instanceof ProviderError ? error : new ProviderError(redact(error.message || 'internal error'), 500)
    if (!res.headersSent) json(res, e.status ?? 500, { error: { message: e.message, type: e.code } })
    else res.end()
  }
})

const HOST = process.env.HOST || '0.0.0.0'
server.listen(PORT, HOST, () => {
  const rt = runtimeInfo()
  console.log(`[qwenwork2api] listening :${PORT}`)
  console.log(`[qwenwork2api] admin  http://127.0.0.1:${PORT}/admin?token=${ADMIN_TOKEN}`)
  console.log(`[qwenwork2api] wasm   ${rt.ok ? 'OK ' + rt.sha256.slice(0, 16) + ' ' + rt.bytes + 'B' : 'MISSING ' + rt.error}`)
})

// 启动时补齐设备画像与指纹盐值（老账号没有这两个字段）
for (const acc of state.accounts) { try { ensureDevice(acc) } catch {} }
saveState()

// 启动后 45 秒补一次当日领取（错峰，别跟首屏请求抢），之后每小时检查一次
setTimeout(() => { (async () => {
  if (state.settings?.claimEnabled === false) return
  for (const acc of state.accounts) {
    try { await claimAccount(acc) } catch (e) { log({ type: 'claim_error', account: acc.email || acc.uid, error: redact(e.message) }) }
  }
  saveState()
})() }, 45 * 1000).unref()
setInterval(async () => {
  if (state.settings?.claimEnabled === false) return
  for (const acc of state.accounts) {
    if (acc.claim?.date === today() && acc.claim?.ok) continue
    try { await claimAccount(acc) } catch (e) { log({ type: 'claim_error', account: acc.email || acc.uid, error: redact(e.message) }) }
  }
  saveState()
}, 60 * 60 * 1000).unref()

// 定时刷新余额（默认 10 分钟）
const REFRESH_MS = Number(process.env.REFRESH_MS || 10 * 60 * 1000)
setInterval(async () => {
  for (const acc of state.accounts) {
    try { await refreshAccount(acc) } catch (e) { log({ type: 'refresh_error', account: acc.email || acc.uid, error: redact(e.message) }) }
  }
}, REFRESH_MS).unref()
