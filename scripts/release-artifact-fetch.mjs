import assert from 'node:assert/strict'
import { fetchBoundedBytes } from './bounded-fetch.mjs'

// Large immutable artifacts use bounded byte ranges, so a slow mirror does not
// need to deliver the entire installer within one HTTP request's deadline.
export async function fetchReleaseArtifact(url, options) {
  const total = options.maxBytes
  const chunkSize = options.chunkSize ?? 4 * 1024 * 1024
  assert.ok(Number.isSafeInteger(total) && total > 0 && total <= 2_000_000_000)
  assert.ok(Number.isSafeInteger(chunkSize) && chunkSize >= 1024 && chunkSize <= 4 * 1024 * 1024)
  if (total <= chunkSize) return fetchBoundedBytes(url, options)
  const deadline = Date.now() + 20 * 60_000
  const count = Math.ceil(total / chunkSize)
  const chunks = new Array(count)
  let firstResponse, validator, completed = 0
  const read = async index => {
    const start = index * chunkSize, end = Math.min(total, start + chunkSize) - 1
    const remaining = deadline - Date.now()
    if (remaining < 1000) throw new Error('Artifact readback deadline exceeded')
    const result = await fetchBoundedBytes(url, {
      ...options, maxBytes: end - start + 1, timeoutMs: Math.min(120_000, remaining),
      headers: { ...(options.headers || {}), Range: `bytes=${start}-${end}`, ...(validator ? { 'If-Match': validator } : {}) }
    })
    if (index === 0 && result.response.status === 404) return result
    assert.equal(result.response.status, 206, 'Large artifact mirror must support bounded byte ranges')
    assert.equal(result.response.headers.get('content-range'), `bytes ${start}-${end}/${total}`, 'Artifact range or size changed')
    assert.equal(result.bytes.length, end - start + 1, 'Truncated artifact range')
    const etag = result.response.headers.get('etag')
    if (index === 0) { firstResponse = result.response; validator = etag }
    else if (validator) assert.equal(etag, validator, 'Artifact changed during readback')
    chunks[index] = result.bytes
    completed += result.bytes.length
    options.onProgress?.(completed, total)
    return result
  }
  const first = await read(0)
  if (first.response.status === 404) return first
  let next = 1, failure
  await Promise.all(Array.from({ length: Math.min(4, count - 1) }, async () => {
    try { while (!failure && next < count) await read(next++) }
    catch (error) { failure ||= error }
  }))
  if (failure) throw failure
  return { response: firstResponse, bytes: Buffer.concat(chunks, total) }
}
