// 设备指纹派生 —— 参考 WorkBuddy 反代的 wb_fingerprint.py 思路：
// 一个账号 = 一台固定设备。machineId 由 uid + 每账号盐值稳定派生，
// 换盐值就等于换了一台设备（面板上的「换指纹」），账号之间互不关联。
import { createHash } from 'node:crypto'

// 官方客户端的 machineId 是「带连字符的 UUID」，版本位/变体位固定成 v4 的样子
export function deriveMachineId(uid, salt) {
  const h = createHash('md5').update(`${salt || 'machine'}:${uid || 'anonymous'}`).digest('hex')
  const s = h.slice(0, 12) + '4' + h.slice(13, 16) + 'a' + h.slice(17)
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

export function deriveSessionId(uid) {
  return deriveMachineId(uid, 'session')
}

// 客户端画像：同一账号恒定，账号之间可以不同（等价于「每账号一台机器」）
const PLATFORMS = [
  { platform: 'win32', arch: 'x64', machineType: '5', machineOS: 'x64_win32' },
  { platform: 'darwin', arch: 'arm64', machineType: '5', machineOS: 'arm64_darwin' },
  { platform: 'linux', arch: 'x64', machineType: '5', machineOS: 'x64_linux' },
]

export function deviceProfile(uid, versions) {
  const h = createHash('md5').update(`device:${uid || 'anonymous'}`).digest()
  const p = PLATFORMS[h[0] % PLATFORMS.length]
  return {
    ...p,
    version: versions?.version || '',
    releaseVersion: versions?.releaseVersion || '',
    build: (versions?.releaseVersion || '').split('-').at(-1) || '',
  }
}

// 生成一个可写进 state 的新盐值
export function newSalt() {
  return createHash('sha256').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 16)
}
