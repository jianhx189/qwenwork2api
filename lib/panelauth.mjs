// 面板登录：密码 + 会话令牌（不再让用户复制 24 位 admin token）
//
// 存储：data/panel.json = { salt, hash, updatedAt }，scrypt(N=16384,r=8,p=1) 派生 32 字节。
// 会话：进程内存 Map<token, expireAt>，默认 7 天，进程重启失效（要重新输密码）。
// 兼容：原来的 data/admin_token.txt 仍然可用（Bearer 形式），方便脚本和旧链接。
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const N = 16384, R = 8, P = 1, KEYLEN = 32

function derive(password, salt) {
  return scryptSync(String(password), Buffer.from(salt, 'hex'), KEYLEN, { N, r: R, p: P })
}

export class PanelAuth {
  constructor(dataDir, { defaultPassword = '147369qAz', ttlMs = 7 * 24 * 3600 * 1000 } = {}) {
    this.file = path.join(dataDir, 'panel.json')
    this.ttlMs = ttlMs
    this.sessions = new Map()
    this.record = null
    this.load(defaultPassword)
  }

  load(defaultPassword) {
    try {
      if (existsSync(this.file)) {
        const r = JSON.parse(readFileSync(this.file, 'utf8'))
        if (r?.salt && r?.hash) { this.record = r; return }
      }
    } catch {}
    this.setPassword(defaultPassword)
  }

  save() {
    try { writeFileSync(this.file, JSON.stringify(this.record, null, 2), { mode: 0o600 }) } catch {}
  }

  setPassword(password) {
    const salt = randomBytes(16).toString('hex')
    this.record = { salt, hash: derive(password, salt).toString('hex'), updatedAt: Date.now() }
    this.sessions.clear()
    this.save()
    return this.record
  }

  verify(password) {
    if (!this.record || !password) return false
    try {
      const want = Buffer.from(this.record.hash, 'hex')
      const got = derive(password, this.record.salt)
      return want.length === got.length && timingSafeEqual(want, got)
    } catch { return false }
  }

  issue() {
    const token = randomBytes(24).toString('base64url')
    this.sessions.set(token, Date.now() + this.ttlMs)
    return token
  }

  check(token) {
    if (!token) return false
    const exp = this.sessions.get(token)
    if (!exp) return false
    if (exp < Date.now()) { this.sessions.delete(token); return false }
    return true
  }

  revoke(token) { if (token) this.sessions.delete(token) }

  // 定期清理过期会话
  sweep() {
    const now = Date.now()
    for (const [t, exp] of this.sessions) if (exp < now) this.sessions.delete(t)
  }
}
