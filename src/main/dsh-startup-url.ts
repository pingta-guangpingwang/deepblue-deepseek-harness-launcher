/** Accept only the launched local listener's URL; keep its process authentication. */
export function parseHarnessStartupUrl(line: string, port: number): string | undefined {
  const match = line.replace(/\u001b\[[0-9;]*m/g, '').match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/[^\s<>"']*)?/i)?.[0]
  if (!match) return undefined
  try {
    const url = new URL(match)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) !== port || url.username || url.password || url.pathname !== '/' || url.hash) return undefined
    if ([...url.searchParams.keys()].some(key => key !== 'token') || url.searchParams.getAll('token').length > 1) return undefined
    return url.href
  } catch { return undefined }
}

export function redactHarnessAuthentication(value: string): string {
  return value.replace(/([?&]token=)[^\s&#"'<>]+/gi, '$1[redacted]')
}
