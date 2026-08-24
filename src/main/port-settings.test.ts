import { describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { assertHarnessPortAvailable, validateHarnessPort } from './port-settings'

describe('Harness port settings', () => {
  it('accepts only user-selectable TCP ports', () => {
    expect(validateHarnessPort(3080)).toBe(3080)
    expect(validateHarnessPort('43189')).toBe(43189)
    expect(() => validateHarnessPort(0)).toThrow('1024—65535')
    expect(() => validateHarnessPort(65536)).toThrow('1024—65535')
    expect(() => validateHarnessPort(3080.5)).toThrow('1024—65535')
  })

  it('reports an occupied port before Harness is restarted', async () => {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0 }, resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port')
    await expect(assertHarnessPortAvailable(address.port)).rejects.toThrow('已被其他程序占用')
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
})
