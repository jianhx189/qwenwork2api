// 模型级冷却 + 选号 + 「没有可用账号」归因
//
// 为什么单独成模块（2026-11-19）：
//   线上实测的两次故障都出在「一个模型挂了 → 整站不可用 / 报错误原因」这条链上：
//     ① 上游对 deepseek-flash 回 429，旧逻辑把 `acc.status='quota_exhausted'`，
//        该号随即被 pickAccount 永久排除（直到下一次余额刷新），两个号先后被标记
//        后整站回 503「没有可用的千问办公账号，请先在后台授权」——而同一时刻
//        qwen3.8 档位完全正常，账号余额也充足。**单模型限流不该熔断整个账号。**
//     ② 那句 503 文案把「账号不存在 / 全在冷却 / 额度用尽 / 全都停用」四种完全
//        不同的原因压成了一句「请先在后台授权」，排查时被带偏。
//   这两个都是纯逻辑，抽成无副作用的函数后可以单测；server.mjs 只负责编排。
import { ProviderError } from './errors.mjs'

/** 账号 × 上游模型 的短时冷却表（内存态，进程重启即清空——冷却本就是瞬态）。 */
export function createModelCooldowns({ defaultMs = 60000, now = Date.now } = {}) {
  const map = new Map()
  const key = (accId, model) => `${accId}|${model}`
  return {
    defaultMs,
    /** 记一次冷却。ms 非正数/非法值回落 defaultMs；下限 1 秒（防止 0 变成「等于没冷却」）。 */
    note(accId, model, ms = defaultMs) {
      if (!accId || !model) return 0
      const raw = Number(ms)
      const dur = Number.isFinite(raw) && raw > 0 ? raw : defaultMs
      const until = now() + Math.max(1000, dur)
      map.set(key(accId, model), until)
      return until
    },
    /** 冷却截止时间戳（毫秒）；0 = 从未冷却。 */
    until(accId, model) {
      return map.get(key(accId, model)) || 0
    },
    isCooling(accId, model) {
      return (map.get(key(accId, model)) || 0) > now()
    },
    clear(accId, model) {
      map.delete(key(accId, model))
    },
    size() {
      return map.size
    },
  }
}

/** 可用于聊天的账号：有令牌、非 daily-only、且额度未被判定耗尽。 */
export function chatableAccounts(accounts) {
  return (accounts || []).filter(
    a => a && a.access && !a.claimOnly && a.status !== 'quota_exhausted',
  )
}

/**
 * 选号。与旧版的差异只有一处：**按模型过滤冷却中的账号**。
 *   · 优先选没试过的号；都试过（或只有一个号）时允许同号重试，不能直接放弃；
 *   · 该模型上全部账号都在冷却 → 返回 null，由调用方给出「限流，N 秒后重试」。
 * cooldowns 为 null / model 为空时行为与旧版完全一致（后台体检、试跑等场景）。
 */
export function pickAccount(accounts, { exclude = new Set(), model = '', cooldowns = null } = {}) {
  const usable = chatableAccounts(accounts)
  if (!usable.length) return null
  const warm = model && cooldowns ? usable.filter(a => !cooldowns.isCooling(a.id, model)) : usable
  if (!warm.length) return null
  const fresh = warm.filter(a => !exclude.has(a.id))
  const pool = fresh.length ? fresh : warm
  return pool.slice().sort((a, b) => (b.quota?.remaining ?? 0) - (a.quota?.remaining ?? 0))[0]
}

/** 该模型上的冷却概况；没有任何账号在冷却时返回 null。 */
export function coolingInfo(accounts, model, cooldowns, now = Date.now()) {
  if (!model || !cooldowns) return null
  const alive = chatableAccounts(accounts)
  const cooling = alive.filter(a => cooldowns.isCooling(a.id, model))
  if (!cooling.length) return null
  const waitSec = Math.max(
    1,
    Math.ceil((Math.min(...cooling.map(a => cooldowns.until(a.id, model))) - now) / 1000),
  )
  return { cooling: cooling.length, alive: alive.length, waitSec }
}

/**
 * 「没有可用账号」的精确归因——按原因给不同状态码与文案。
 * 顺序按「越具体越先判」：没有账号 → 没有可用令牌 → 额度全用尽 → 全在冷却 → 兜底。
 */
export function unavailableError(accounts, { model = '', modelLabel = '', cooldowns = null } = {}) {
  const list = accounts || []
  if (!list.length) {
    return new ProviderError('尚未添加任何千问办公账号，请先在后台「添加账号」完成授权', 503, 'no_account')
  }
  const withToken = list.filter(a => a && a.access && !a.claimOnly)
  if (!withToken.length) {
    return new ProviderError('没有可用于聊天的账号（缺令牌，或只有 daily 环境账号），请重新授权', 503, 'no_account')
  }
  const alive = withToken.filter(a => a.status !== 'quota_exhausted')
  if (!alive.length) {
    return new ProviderError('所有千问办公账号的额度均已用尽，请补充账号或等待额度恢复', 429, 'insufficient_quota')
  }
  const info = coolingInfo(alive, model, cooldowns)
  if (info && info.cooling === info.alive) {
    return new ProviderError(
      `模型 ${modelLabel || model} 的全部 ${info.alive} 个账号正在限流冷却，约 ${info.waitSec} 秒后自动恢复（账号未停用、额度未耗尽）`,
      429,
      'insufficient_quota',
    )
  }
  return new ProviderError('暂时没有可用的千问办公账号，请稍后重试', 503, 'no_account')
}

/**
 * 收尾用的错误选择：有上游错误就带上它；若整轮都是 429 且账号已全部进入冷却，
 * 换成「N 秒后重试」的可执行文案（上游原文 All models failed 对使用方毫无指引）。
 */
export function finalError(lastErr, accounts, { model = '', modelLabel = '', cooldowns = null } = {}) {
  const fallback = unavailableError(accounts, { model, modelLabel, cooldowns })
  if (!lastErr) return fallback
  if (lastErr.status !== 429) return lastErr
  const info = coolingInfo(accounts, model, cooldowns)
  if (info && info.cooling === info.alive) {
    return unavailableError(accounts, { model, modelLabel, cooldowns })
  }
  return lastErr
}
