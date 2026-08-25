import type { DeepSeekBalanceSummary } from '../shared/types'

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

interface DeepSeekBalancePayload {
  is_available?: unknown
  balance_infos?: unknown
}

interface DeepSeekBalanceInfo {
  currency: 'CNY' | 'USD'
  total_balance: string
}

function validBalanceInfo(value: unknown): value is DeepSeekBalanceInfo {
  if (!value || typeof value !== 'object') return false
  const info = value as Record<string, unknown>
  return (info.currency === 'CNY' || info.currency === 'USD')
    && typeof info.total_balance === 'string'
    && /^\d+(?:\.\d+)?$/.test(info.total_balance)
}

function displayAmount(info: DeepSeekBalanceInfo): string {
  const amount = Number(info.total_balance)
  const normalized = Number.isFinite(amount)
    ? amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
    : info.total_balance
  return `${info.currency === 'CNY' ? '¥' : '$'}${normalized}`
}

export async function queryDeepSeekBalance(
  apiKey: string,
  request: typeof fetch = fetch
): Promise<DeepSeekBalanceSummary> {
  if (!apiKey.trim()) {
    return { status: 'unconfigured', message: '请先在模型连接中设置 DeepSeek API Key', checkedAt: new Date().toISOString() }
  }
  const response = await request(DEEPSEEK_BALANCE_URL, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
      'user-agent': 'DeepBlue-DeepSeek-Harness-Launcher'
    }
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('DeepSeek API Key 无效或无权查询余额')
    if (response.status === 429) throw new Error('DeepSeek 余额查询过于频繁，请稍后再试')
    throw new Error(`DeepSeek 余额接口暂不可用（HTTP ${response.status}）`)
  }
  const payload = await response.json() as DeepSeekBalancePayload
  if (typeof payload.is_available !== 'boolean' || !Array.isArray(payload.balance_infos)) {
    throw new Error('DeepSeek 余额接口返回格式异常')
  }
  const infos = payload.balance_infos.filter(validBalanceInfo)
  const preferred = infos.find(info => info.currency === 'CNY') || infos[0]
  if (!preferred) throw new Error('DeepSeek 账户暂未返回可显示的余额')
  const isAvailable = payload.is_available
  return {
    status: isAvailable ? 'available' : 'unavailable',
    message: `DeepSeek 余额：${displayAmount(preferred)}${isAvailable ? '' : '（当前不可调用）'}`,
    checkedAt: new Date().toISOString(),
    isAvailable,
    currency: preferred.currency,
    totalBalance: preferred.total_balance
  }
}
