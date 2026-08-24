import { createServer } from 'node:net'

export const MIN_HARNESS_PORT = 1024
export const MAX_HARNESS_PORT = 65535

export function validateHarnessPort(value: unknown): number {
  const port = typeof value === 'string' && value.trim() ? Number(value) : value
  if (!Number.isSafeInteger(port) || Number(port) < MIN_HARNESS_PORT || Number(port) > MAX_HARNESS_PORT) {
    throw new Error(`Harness 端口必须是 ${MIN_HARNESS_PORT}—${MAX_HARNESS_PORT} 之间的整数`)
  }
  return Number(port)
}

export async function assertHarnessPortAvailable(port: number, host = '127.0.0.1'): Promise<void> {
  validateHarnessPort(port)
  const server = createServer()
  server.unref()
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeAllListeners()
      reject(new Error(error.code === 'EADDRINUSE'
        ? `端口 ${port} 已被其他程序占用，请换一个端口`
        : `无法使用端口 ${port}：${error.message}`))
    }
    server.once('error', onError)
    server.listen({ host, port, exclusive: true }, () => {
      server.removeListener('error', onError)
      server.close((error) => error ? reject(error) : resolve())
    })
  })
}
