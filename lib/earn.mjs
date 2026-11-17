// 千问办公「赚积分」相关接口 —— 逆向自官方客户端 2.1.0（app.asar）
//
// 客户端里能拿积分的动作只有两个，都由 /api/v1/adapter/user/* 提供（上游真实路径 /user/v2/*）：
//   ① 每日免费积分：POST /api/v1/adapter/user/daily-credit-notice/claim
//      客户端文案：dailyCreditNotice「今日已获得 {{credits}} 免费积分」、
//                  creditsGrowthCard.checkinFailed「签到失败，请稍后重试」
//   ② 兑换码：      POST /api/v1/adapter/user/redeem
//
// 客户端里**没有**任务列表/任务领奖接口（grep 不到 task/reward 类 user 端点），
// 所谓「成长任务」是服务端下发的 creditsGrowthCard 动态卡片（还挂了 qwenwork-growth.dingtalk.com），
// 属于 H5 运营活动，无法像 WB 的 TASK_SPECS 那样在网关里逐条点灯。所以这里只做①，②留手动。
import { GATEWAY, clientHeaders } from './constants.mjs'

// ⚠️ 2026-11 实机复核（旧笔记是错的，别再照抄）：
//   prod 主栈 gateway.qwenwork.cn 的 adapter **没有** daily-credit-notice 路由：
//     POST /api/v1/adapter/user/daily-credit-notice/claim → 404 page not found
//   daily 栈（daily.gateway.qwenwork.cn）有这个路由，但它是另一套账号体系：
//     prod 签发的 access token 打过去 = 401 INVALID_TOKEN；
//     它的 /user/v2/* 还要网页会话 cookie + x-csrf-token（首页下发 qoder_csrf_token）。
//   prod adapter 上真正能用的是 account-context / balance / wallets / v2/quota。
const API_BASE = process.env.QWENWORK_API_BASE || GATEWAY
export const CLAIM_PATH = '/api/v1/adapter/user/daily-credit-notice/claim'
export const REDEEM_PATH = '/api/v1/adapter/user/redeem'
export const BALANCE_PATH = '/api/v1/adapter/user/balance'
export const WALLETS_PATH = '/api/v1/adapter/user/wallets'

const timeout = signal => signal || AbortSignal.timeout(20000)

function headers(acc, { json = true } = {}) {
  return {
    ...clientHeaders(acc.device || {}),
    Accept: 'application/json',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${acc.access}`,
  }
}

async function call(acc, path, { method = 'GET', body, fetchImpl = fetch, signal, base } = {}) {
  const hasBody = body !== undefined
  const response = await fetchImpl((base || API_BASE) + path, {
    method,
    headers: headers(acc, { json: hasBody }),
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
    signal: timeout(signal),
    redirect: 'error',
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 200) } }
  return { status: response.status, ok: response.ok, data, text: text.slice(0, 400) }
}

// 客户端 DailyCreditNoticeClient.claim() 只发 { method:'POST', path }，**不带 body**
// （带 body 会被上游拒：claim accepts no query or request body）
const post = (acc, path, body, opts = {}) => call(acc, path, { method: 'POST', body, ...opts })

// 从各种可能的响应形状里挖出「本次到账多少分」
export function pickCredit(data) {
  if (!data || typeof data !== 'object') return null
  const direct = ['credits', 'credit', 'amount', 'reward', 'daily_credit', 'dailyCredit', 'value']
  for (const key of direct) {
    const v = data[key]
    if (typeof v === 'number') return v
    if (v && typeof v === 'object') {
      for (const k2 of ['amount', 'credits', 'value', 'remain']) if (typeof v[k2] === 'number') return v[k2]
    }
  }
  for (const k of ['data', 'result', 'payload']) {
    const got = pickCredit(data[k])
    if (got !== null) return got
  }
  return null
}

export async function claimDaily(acc, opts = {}) {
  if (!acc?.access) return { ok: false, skipped: true, message: '账号没有 access token' }
  const r = await post(acc, CLAIM_PATH, undefined, { ...opts, base: acc.claimOrigin })
  const credits = pickCredit(r.data)
  // 上游对「今天已领」通常回 200 + 空/提示，或 4xx + 已领取文案
  // 路由根本不存在 → 环境不支持，不是账号失效，别谎报「登录已失效」
  if (r.status === 404 && /page not found/i.test(r.text)) {
    return { ok: false, unsupported: true, status: 404, message: '该账号所在环境没有每日领取接口' }
  }
  const message = r.data?.message || r.data?.msg || r.data?.error || r.data?.errorMessage || (r.ok ? '已提交' : r.text)
  const raw = String(message)
  const friendly = /INVALID_TOKEN|token is invalid/i.test(raw) ? '登录已失效，需要重新添加账号'
    : /Unauthorized|not authenticated/i.test(raw) ? '该环境要网页登录，OAuth 令牌不可用'
    : /already|已领|重复/i.test(raw) ? '今天已领过'
    : raw
  return { ok: r.ok, status: r.status, credits, message: friendly.slice(0, 120), data: r.data }
}

export async function redeem(acc, code, opts = {}) {
  if (!acc?.access) return { ok: false, message: '账号没有 access token' }
  const r = await post(acc, REDEEM_PATH, { code }, opts)  // body 形状未实测：账号 token 失效前拿不到 200
  return { ok: r.ok, status: r.status, data: r.data, message: String(r.data?.message || r.data?.msg || r.text).slice(0, 160) }
}

// 余额：prod adapter 返回 { code:'ok', data:{ balance, freeze_credit, admission:{...} } }
export async function fetchBalance(acc, { fetchImpl = fetch, signal } = {}) {
  if (!acc?.access) return null
  try {
    const r = await call(acc, BALANCE_PATH, { fetchImpl, signal })
    if (!r.ok) return null
    const d = r.data?.data ?? r.data ?? null
    if (!d || typeof d !== 'object') return null
    return {
      balance: typeof d.balance === 'number' ? d.balance : null,
      freeze: typeof d.freeze_credit === 'number' ? d.freeze_credit : null,
      raw: d,
    }
  } catch { return null }
}

// 钱包：各钱包余额 + 有效期（月度额度 / 赠送额度分开列）
export async function fetchWallets(acc, { fetchImpl = fetch, signal } = {}) {
  if (!acc?.access) return null
  try {
    const r = await call(acc, WALLETS_PATH, { fetchImpl, signal })
    if (!r.ok) return null
    const list = r.data?.data?.active_wallets?.wallets || r.data?.active_wallets?.wallets || []
    return list.map(w => ({ balance: w.balance ?? null, validTo: w.valid_to || null, kind: w.wallet_type || w.type || null }))
  } catch { return null }
}

export const today = (now = Date.now()) => new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10)
export { GATEWAY }
