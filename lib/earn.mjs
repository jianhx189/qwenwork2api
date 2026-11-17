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

// ⚠️ user/* 这一族接口只在 daily.gateway.qwenwork.cn 上存在：
//    gateway.qwenwork.cn 会 404 page not found，qwenwork.cn 也 404；
//    daily.gateway 上同样的路径返回 401 INVALID_TOKEN（= 路由对了，只差有效 token）。
const API_BASE = process.env.QWENWORK_API_BASE || 'https://daily.gateway.qwenwork.cn'
export const CLAIM_PATH = '/api/v1/adapter/user/daily-credit-notice/claim'
export const REDEEM_PATH = '/api/v1/adapter/user/redeem'
export const BALANCE_PATH = '/api/v1/adapter/user/balance'

const timeout = signal => signal || AbortSignal.timeout(20000)

function headers(acc, { json = true } = {}) {
  return {
    ...clientHeaders(acc.device || {}),
    Accept: 'application/json',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${acc.access}`,
    'Cosy-MachineId': acc.machineId || '',
    'Cosy-MachineToken': acc.machineId || '',
    'Cosy-Version': (acc.device && acc.device.version) || '',
    'Cosy-ClientType': '6',
    'Cosy-MachineOS': (acc.device && acc.device.machineOS) || '',
    'Cosy-MachineType': (acc.device && acc.device.machineType) || '5',
    'Login-Version': 'v2',
  }
}

async function post(acc, path, body, { fetchImpl = fetch, signal } = {}) {
  // 客户端 DailyCreditNoticeClient.claim() 只发 { method:'POST', path }，**不带 body**
  // （带 body 会被上游拒：claim accepts no query or request body）
  const hasBody = body !== undefined
  const response = await fetchImpl(API_BASE + path, {
    method: 'POST',
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
  const r = await post(acc, CLAIM_PATH, undefined, opts)
  const credits = pickCredit(r.data)
  // 上游对「今天已领」通常回 200 + 空/提示，或 4xx + 已领取文案
  const message = r.data?.message || r.data?.msg || r.data?.error || (r.ok ? '已提交' : r.text)
  const raw = String(message)
  const friendly = /INVALID_TOKEN|token is invalid|登录|未授权/i.test(raw) ? '登录已失效，需要重新添加账号'
    : /already|已领|重复/i.test(raw) ? '今天已领过'
    : raw
  return { ok: r.ok, status: r.status, credits, message: friendly.slice(0, 120), data: r.data }
}

export async function redeem(acc, code, opts = {}) {
  if (!acc?.access) return { ok: false, message: '账号没有 access token' }
  const r = await post(acc, REDEEM_PATH, { code }, opts)  // body 形状未实测：账号 token 失效前拿不到 200
  return { ok: r.ok, status: r.status, data: r.data, message: String(r.data?.message || r.data?.msg || r.text).slice(0, 160) }
}

export async function fetchBalance(acc, { fetchImpl = fetch, signal } = {}) {
  if (!acc?.access) return null
  try {
    const response = await fetchImpl(API_BASE + BALANCE_PATH, { headers: headers(acc), signal: timeout(signal), redirect: 'error' })
    if (!response.ok) return null
    const data = await response.json().catch(() => null)
    return data
  } catch { return null }
}

export const today = (now = Date.now()) => new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10)
export { GATEWAY }
