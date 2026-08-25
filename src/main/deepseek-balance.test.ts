import { describe, expect, it, vi } from 'vitest'
import { queryDeepSeekBalance } from './deepseek-balance'

describe('DeepSeek balance API', () => {
  it('uses the official endpoint and prefers the CNY balance', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: '1.25', granted_balance: '0.00', topped_up_balance: '1.25' },
        { currency: 'CNY', total_balance: '12.340000', granted_balance: '2.00', topped_up_balance: '10.34' }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

    const result = await queryDeepSeekBalance('sk-test-only', request)

    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('https://api.deepseek.com/user/balance', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ authorization: 'Bearer sk-test-only' })
    }))
    expect(result).toMatchObject({ status: 'available', isAvailable: true, currency: 'CNY', totalBalance: '12.340000' })
    expect(result.message).toBe('DeepSeek 余额：¥12.34')
  })

  it('marks an account unavailable and never echoes a rejected key', async () => {
    const unavailable = vi.fn(async () => new Response(JSON.stringify({
      is_available: false,
      balance_infos: [{ currency: 'USD', total_balance: '0.00' }]
    }), { status: 200 })) as unknown as typeof fetch
    expect((await queryDeepSeekBalance('sk-hidden', unavailable)).message).toBe('DeepSeek 余额：$0.00（当前不可调用）')

    const rejected = vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch
    await expect(queryDeepSeekBalance('sk-must-not-leak', rejected)).rejects.toThrow('DeepSeek API Key 无效或无权查询余额')
    await expect(queryDeepSeekBalance('sk-must-not-leak', rejected)).rejects.not.toThrow('sk-must-not-leak')
  })
})
