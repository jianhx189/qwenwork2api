// 模型级冷却 / 选号 / 归因文案 的回归测试（node --test）
// 覆盖 2026-11-19 线上两个缺陷：
//   ① 单模型 429 不得熔断整个账号（旧行为：acc.status='quota_exhausted'）
//   ② 「没有可用账号」必须按原因区分文案（旧行为：一律「请先在后台授权」）
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createModelCooldowns, pickAccount, coolingInfo, unavailableError, finalError,
} from '../lib/cooldown.mjs'
import { ProviderError } from '../lib/errors.mjs'

const acc = (id, over = {}) => ({
  id, access: `tok-${id}`, email: `${id}@x`, status: 'ok',
  quota: { remaining: 100 }, ...over,
})

test('冷却只作用于「账号 × 模型」，不影响同账号的其它模型', () => {
  const cooldowns = createModelCooldowns({ defaultMs: 60000 })
  const a = acc('a')
  cooldowns.note('a', 'deepseek-flash')

  // 同一模型：被冷却 → 没得选
  assert.equal(pickAccount([a], { model: 'deepseek-flash', cooldowns }), null)
  // 另一个模型：同一个号照常可用（旧实现会因 status=quota_exhausted 一并封杀）
  assert.equal(pickAccount([a], { model: 'qwork-advanced', cooldowns })?.id, 'a')
  // 不传 model（体检/试跑路径）视为忽略冷却
  assert.equal(pickAccount([a], { cooldowns })?.id, 'a')
})

test('多数账号被冷却时仍能选出未冷却的那个', () => {
  const cooldowns = createModelCooldowns()
  const a = acc('a', { quota: { remaining: 900 } })
  const b = acc('b', { quota: { remaining: 100 } })
  cooldowns.note('a', 'deepseek-flash')
  assert.equal(pickAccount([a, b], { model: 'deepseek-flash', cooldowns })?.id, 'b')
})

test('冷却过期后自动恢复，成功出字会提前清除冷却', () => {
  let now = 1000
  const cooldowns = createModelCooldowns({ defaultMs: 5000, now: () => now })
  const a = acc('a')
  cooldowns.note('a', 'deepseek-flash')
  assert.equal(cooldowns.isCooling('a', 'deepseek-flash'), true)

  now += 5001
  assert.equal(cooldowns.isCooling('a', 'deepseek-flash'), false)
  assert.equal(pickAccount([a], { model: 'deepseek-flash', cooldowns })?.id, 'a')

  cooldowns.note('a', 'deepseek-flash')
  cooldowns.clear('a', 'deepseek-flash')
  assert.equal(cooldowns.isCooling('a', 'deepseek-flash'), false)
})

test('冷却时长有下限 1 秒，0/负数回落默认值（不会变成「无冷却」）', () => {
  let now = 0
  const cooldowns = createModelCooldowns({ defaultMs: 60000, now: () => now })
  cooldowns.note('a', 'm', 0)          // 0 → 回落 defaultMs
  assert.equal(cooldowns.isCooling('a', 'm'), true)
  now = 59999
  assert.equal(cooldowns.isCooling('a', 'm'), true)
  now = 60001
  assert.equal(cooldowns.isCooling('a', 'm'), false)

  // 显式给一个很小的正数 → 抬到 1 秒下限
  now = 0
  cooldowns.note('b', 'm', 5)
  assert.equal(cooldowns.isCooling('b', 'm'), true)
  now = 1001
  assert.equal(cooldowns.isCooling('b', 'm'), false)
})

test('429 后账号不被标成额度耗尽：仍可服务其它模型（旧缺陷 ① 直接复现）', () => {
  const cooldowns = createModelCooldowns()
  const a = acc('a'), b = acc('b')
  cooldowns.note(a.id, 'deepseek-flash')
  cooldowns.note(b.id, 'deepseek-flash')
  // deepseek 全冷却 → 该模型无号
  assert.equal(pickAccount([a, b], { model: 'deepseek-flash', cooldowns }), null)
  // 但账号本身仍是 ok，qwen 档位照常
  assert.equal(a.status, 'ok')
  assert.ok(pickAccount([a, b], { model: 'qwork-advanced', cooldowns }))
})

test('冷却概况：只在全部账号都冷却时才算「整档不可用」', () => {
  const cooldowns = createModelCooldowns()
  const a = acc('a'), b = acc('b')
  cooldowns.note('a', 'deepseek-flash')
  const half = coolingInfo([a, b], 'deepseek-flash', cooldowns)
  assert.deepEqual({ cooling: half.cooling, alive: half.alive }, { cooling: 1, alive: 2 })
  cooldowns.note('b', 'deepseek-flash')
  const all = coolingInfo([a, b], 'deepseek-flash', cooldowns)
  assert.deepEqual({ cooling: all.cooling, alive: all.alive }, { cooling: 2, alive: 2 })
})

test('归因文案：没有账号 / 无令牌 / 额度用尽 / 全在冷却 各不相同（旧缺陷 ②）', () => {
  const cooldowns = createModelCooldowns()

  const none = unavailableError([], { model: 'deepseek-flash', modelLabel: 'deepseek-v4.1-flash', cooldowns })
  assert.match(none.message, /尚未添加任何/)
  assert.equal(none.status, 503)

  const noToken = unavailableError([acc('a', { access: '' })], { model: 'deepseek-flash', cooldowns })
  assert.match(noToken.message, /没有可用于聊天|令牌/)
  assert.doesNotMatch(noToken.message, /尚未添加/)

  const exhausted = unavailableError([acc('a', { status: 'quota_exhausted' })], { model: 'deepseek-flash', cooldowns })
  assert.equal(exhausted.status, 429)
  assert.match(exhausted.message, /额度均已用尽/)

  const a = acc('a'), b = acc('b')
  cooldowns.note('a', 'deepseek-flash')
  cooldowns.note('b', 'deepseek-flash')
  const cooling = unavailableError([a, b], { model: 'deepseek-flash', modelLabel: 'deepseek-v4.1-flash', cooldowns })
  assert.equal(cooling.status, 429)
  assert.match(cooling.message, /限流冷却/)
  assert.match(cooling.message, /秒后自动恢复/)
  // 关键：不能再说「请先在后台授权」——账号明明在
  assert.doesNotMatch(cooling.message, /授权/)
})

test('finalError：上游 429 且整档冷却时替换成可执行文案，其它错误原样保留', () => {
  const cooldowns = createModelCooldowns()
  const a = acc('a')
  cooldowns.note('a', 'deepseek-flash')

  const upstream429 = new ProviderError('All models failed', 429, 'insufficient_quota')
  const replaced = finalError(upstream429, [a], { model: 'deepseek-flash', modelLabel: 'deepseek-v4.1-flash', cooldowns })
  assert.match(replaced.message, /限流冷却/)
  assert.equal(replaced.status, 429)

  const bad5xx = new ProviderError('千问办公返回 HTTP 502', 502)
  assert.equal(finalError(bad5xx, [a], { model: 'deepseek-flash', cooldowns }), bad5xx)

  // 没有上游错误 → 走归因
  const noneAcc = finalError(null, [], { model: 'deepseek-flash', cooldowns })
  assert.match(noneAcc.message, /尚未添加任何/)
})
