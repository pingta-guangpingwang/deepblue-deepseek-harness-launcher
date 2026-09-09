export async function fetchBoundedBytes(url, options = {}) {
  const maxBytes = Number(options.maxBytes)
  const timeoutMs = Number(options.timeoutMs || 30_000)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error('Bounded fetch limits are invalid')
  }
  const allowedRedirectHosts = Array.isArray(options.allowedRedirectHosts) ? options.allowedRedirectHosts : []
  const maxRedirects = Number(options.maxRedirects || 0)
  let currentUrl = new URL(url)
  let redirects = 0
  let response
  const deadline = Date.now() + timeoutMs
  while (true) {
    const remainingMs = deadline - Date.now()
    if (remainingMs < 1) throw new Error('Bounded fetch timed out')
    response = await fetch(currentUrl, {
      redirect: allowedRedirectHosts.length ? 'manual' : (options.redirect || 'error'),
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache', ...(options.headers || {}) },
      signal: AbortSignal.timeout(remainingMs)
    })
    if (!allowedRedirectHosts.length || response.status < 300 || response.status >= 400) break
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || redirects >= maxRedirects) throw new Error('Bounded fetch redirect limit exceeded')
    const nextUrl = new URL(location, currentUrl)
    const allowed = allowedRedirectHosts.some((host) => host.startsWith('.') ? nextUrl.hostname.endsWith(host) : nextUrl.hostname === host)
    if (nextUrl.protocol !== 'https:' || nextUrl.username || nextUrl.password || !allowed) throw new Error('Bounded fetch redirected outside the fixed HTTPS host allowlist')
    currentUrl = nextUrl
    redirects += 1
  }
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel()
    throw new Error(`Bounded fetch exceeded ${maxBytes} bytes`)
  }
  const chunks = []
  let total = 0
  if (response.body) {
    for await (const chunk of response.body) {
      total += chunk.length
      if (total > maxBytes) {
        await response.body.cancel().catch(() => {})
        throw new Error(`Bounded fetch exceeded ${maxBytes} bytes`)
      }
      chunks.push(Buffer.from(chunk))
    }
  }
  return { response, bytes: Buffer.concat(chunks, total) }
}
