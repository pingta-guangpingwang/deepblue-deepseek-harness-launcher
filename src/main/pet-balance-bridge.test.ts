import { describe, expect, it } from 'vitest'
import { PetBalanceBridge } from './pet-balance-bridge'

describe('pet balance loopback bridge', () => {
  it('binds only to loopback and requires an unguessable bearer token', async () => {
    const bridge = new PetBalanceBridge(async () => ({
      status: 'available',
      message: 'DeepSeek 余额：¥8.88',
      checkedAt: '2026-08-25T00:00:00.000Z',
      currency: 'CNY',
      totalBalance: '8.88',
      isAvailable: true
    }))
    try {
      await bridge.start()
      const environment = bridge.environment()
      expect(environment.DEEPBLUE_DSH_PET_BALANCE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/balance$/)
      expect(environment.DEEPBLUE_DSH_PET_BALANCE_TOKEN?.length).toBeGreaterThan(30)

      const rejected = await fetch(environment.DEEPBLUE_DSH_PET_BALANCE_URL!)
      expect(rejected.status).toBe(401)

      const accepted = await fetch(environment.DEEPBLUE_DSH_PET_BALANCE_URL!, {
        headers: { authorization: `Bearer ${environment.DEEPBLUE_DSH_PET_BALANCE_TOKEN}` }
      })
      expect(accepted.status).toBe(200)
      expect(await accepted.json()).toMatchObject({ status: 'available', message: 'DeepSeek 余额：¥8.88' })
      expect(accepted.headers.get('cache-control')).toBe('no-store')
    } finally {
      await bridge.dispose()
    }
  })
})
