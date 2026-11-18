export const PROVIDER_ID = 'qwenwork-community'
export const GATEWAY = 'https://gateway.qwenwork.cn'
export const CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'
export const REDIRECT_URI = 'qwenwork-cn://'
export const ACCOUNT_PATH = '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing'
export const REFRESH_PATH = '/api/v1/deviceToken/refresh'
export const FALLBACK_VERSION = '2.1.0'
export const FALLBACK_RELEASE = '2.1.0-26111315'
// 档位名来自官方客户端 1.3.x 的 modelSelector 枚举：
//   LITE qwork-lite · STANDARD qwork-auto · ADVANCED qwork-advanced · PREMIUM qwork-ultimate
//   SAFETY safety · PITAYA q35model_preview · QWEN qmodel · QWEN_LATEST qmodel_latest
// display 名取自客户端 resources/dynamic-text/qwenwork.json，换版本要按同一位置复核。
const T = { input: ['text', 'image'], output: ['text'] }
const L = { context: 131072, output: 8192 }
export const MODELS = Object.freeze({
  'qwork-lite': { name: '千问办公 · 轻量', display: '轻量', reasoning: true, tool_call: true, modalities: T, limit: L },
  'qwork-auto': { name: '千问办公 · 标准', display: '标准', reasoning: true, tool_call: true, modalities: T, limit: L },
  'qwork-advanced': { name: '千问办公 · 高级', display: '高级', reasoning: true, tool_call: true, modalities: T, limit: L },
  'qwork-ultimate': { name: '千问办公 · 旗舰', display: '旗舰', reasoning: true, tool_call: true, modalities: T, limit: L },
  'safety': { name: '千问办公 · 企业专属', display: '企业专属', reasoning: true, tool_call: true, modalities: T, limit: L },
  'qmodel_latest': { name: 'Qwen3.8-Max', display: 'Qwen3.8-Max', reasoning: true, tool_call: true, modalities: T, limit: L },
  'qwen3.8-max-preview': { name: 'Qwen3.8-Max (预览)', display: 'Qwen3.8-Max 预览', reasoning: true, tool_call: true, modalities: T, limit: L },
  'dmodel_latest': { name: 'DeepSeek V4 Pro', display: 'DeepSeek V4 Pro', reasoning: true, tool_call: true, modalities: T, limit: L },
  'gmodel_latest': { name: 'GLM-5.3', display: 'GLM-5.3', reasoning: true, tool_call: true, modalities: T, limit: L },
  'q35model_preview': { name: 'Qwen3.6-Plus-DogFooding', display: 'Qwen3.6-Plus-DogFooding', reasoning: true, tool_call: true, modalities: T, limit: L },
  'vivo-auto': { name: '【M4安全】vivo企业专属模型', display: 'vivo 企业专属', reasoning: true, tool_call: true, modalities: T, limit: L },
  // 2026-11 实机实测：客户端真正可选的键是这些短名，qwork-* / dmodel_latest / gmodel_latest 多被套餐挡
  'lite': { name: '千问办公 · 经济', display: '经济', reasoning: true, tool_call: true, modalities: T, limit: L },
  'flash': { name: '千问办公 · 标准', display: '标准', reasoning: true, tool_call: true, modalities: T, limit: L },
  'pro': { name: '千问办公 · 高级', display: '高级', reasoning: true, tool_call: true, modalities: T, limit: L },
  'flagship': { name: '千问办公 · 旗舰', display: '旗舰', reasoning: true, tool_call: true, modalities: T, limit: L },
  'economy': { name: '千问办公 · 经济(别名)', display: '经济', reasoning: true, tool_call: true, modalities: T, limit: L },
  'advanced': { name: '千问办公 · 高级(别名)', display: '高级', reasoning: true, tool_call: true, modalities: T, limit: L },
  'standard': { name: '千问办公 · 标准(别名)', display: '标准', reasoning: true, tool_call: true, modalities: T, limit: L },
  'premium': { name: '千问办公 · 旗舰(别名)', display: '旗舰', reasoning: true, tool_call: true, modalities: T, limit: L },
  'deepseek-flash': { name: 'DeepSeek V4 Flash', display: 'DeepSeek V4 Flash', reasoning: true, tool_call: true, modalities: T, limit: L },
  'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', display: 'DeepSeek V4 Pro', reasoning: true, tool_call: true, modalities: T, limit: L },
  'glm-5.3': { name: 'GLM-5.3', display: 'GLM-5.3', reasoning: true, tool_call: true, modalities: T, limit: L },
  'glm-5.3-flash': { name: 'GLM-5.3-Flash', display: 'GLM-5.3-Flash', reasoning: true, tool_call: true, modalities: T, limit: L },
  'kimi-k3.1-pro': { name: 'Kimi-K3.1-Pro', display: 'Kimi-K3.1-Pro', reasoning: true, tool_call: true, modalities: T, limit: L },
  'minimax-m3.1-flash': { name: 'MiniMax-M3.1-Flash', display: 'MiniMax-M3.1-Flash', reasoning: true, tool_call: true, modalities: T, limit: L },
  'step-5-preview': { name: 'Step-5-Preview', display: 'Step-5-Preview', reasoning: true, tool_call: true, modalities: T, limit: L },
  'qwen4-max': { name: 'Qwen4-Max', display: 'Qwen4-Max', reasoning: true, tool_call: true, modalities: T, limit: L },
})

export function clientHeaders(runtime = {}) {
  const version = runtime.version || FALLBACK_VERSION
  const release = runtime.releaseVersion || FALLBACK_RELEASE
  return {
    Accept: 'application/json',
    'User-Agent': `QwenWork/${version}`,
    'X-QwenWork-Version': version,
    'X-QwenWork-Release-Version': release,
    'X-QwenWork-Build': release.split('-').at(-1),
    'X-QwenWork-Platform': process.platform,
    'X-QwenWork-Arch': process.arch,
    'X-QwenWork-Channel': 'stable',
    'X-QwenWork-App-Mode': 'standard',
  }
}
