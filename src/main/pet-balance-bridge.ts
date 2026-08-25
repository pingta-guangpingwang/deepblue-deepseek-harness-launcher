import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { DeepSeekBalanceSummary } from '../shared/types'

function authorized(header: string | undefined, token: string): boolean {
  if (!header) return false
  const actual = Buffer.from(header)
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function safeFailure(): DeepSeekBalanceSummary {
  return { status: 'error', message: 'DeepSeek 余额暂时查询失败，请稍后再点我', checkedAt: new Date().toISOString() }
}

export class PetBalanceBridge {
  private readonly token = randomBytes(32).toString('base64url')
  private server?: Server
  private url?: string

  constructor(private readonly readBalance: () => Promise<DeepSeekBalanceSummary>) {}

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer(async (request, response) => {
      response.setHeader('cache-control', 'no-store')
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('x-content-type-options', 'nosniff')
      if (request.method !== 'GET' || request.url !== '/balance') {
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'not_found' }))
        return
      }
      if (!authorized(request.headers.authorization, this.token)) {
        response.statusCode = 401
        response.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      let result: DeepSeekBalanceSummary
      try {
        result = await this.readBalance()
      } catch {
        result = safeFailure()
      }
      const body = JSON.stringify(result)
      response.statusCode = 200
      response.setHeader('content-length', Buffer.byteLength(body))
      response.end(body)
    })
    server.unref()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('宠物余额本机桥接服务未能绑定端口')
    }
    this.server = server
    this.url = `http://127.0.0.1:${address.port}/balance`
  }

  environment(): NodeJS.ProcessEnv {
    return this.url ? {
      DEEPBLUE_DSH_PET_BALANCE_URL: this.url,
      DEEPBLUE_DSH_PET_BALANCE_TOKEN: this.token
    } : {}
  }

  async dispose(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.url = undefined
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
