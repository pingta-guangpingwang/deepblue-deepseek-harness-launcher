import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fetchReleaseArtifact } from './release-artifact-fetch.mjs'

async function server(handler, body) {
  const app = createServer(handler)
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  try { await body(`http://127.0.0.1:${app.address().port}/artifact`) }
  finally { await new Promise(resolve => app.close(resolve)) }
}
test('range assembly preserves every byte and enforces the mirror validator', async () => {
  const bytes = Buffer.from(Array.from({ length: 9701 }, (_, index) => index % 251))
  let requests = 0
  await server((request, response) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range)
    if (Number(start)) assert.equal(request.headers['if-match'], '"fixed"')
    requests++
    response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${bytes.length}`, etag: '"fixed"' })
    response.end(bytes.subarray(Number(start), Number(end) + 1))
  }, async url => {
    const result = await fetchReleaseArtifact(url, { maxBytes: bytes.length, chunkSize: 2048 })
    assert.deepEqual(result.bytes, bytes)
    assert.equal(requests, 5)
  })
})
test('wrong total size is rejected before any later ranges', async () => {
  let requests = 0
  await server((request, response) => {
    requests++
    response.writeHead(206, { 'content-range': 'bytes 0-2047/6000' })
    response.end(Buffer.alloc(2048))
  }, async url => {
    await assert.rejects(fetchReleaseArtifact(url, { maxBytes: 5000, chunkSize: 2048 }), /range or size changed/)
    assert.equal(requests, 1)
  })
})
test('a server ignoring Range cannot bypass the per-request byte bound', async () => {
  await server((request, response) => {
    response.writeHead(200, { 'content-length': 5000 })
    response.end(Buffer.alloc(5000))
  }, async url => {
    await assert.rejects(fetchReleaseArtifact(url, { maxBytes: 5000, chunkSize: 2048 }), /exceeded 2048 bytes/)
  })
})
test('missing immutable object is a bounded 404', async () => {
  await server((request, response) => { response.writeHead(404); response.end('missing') }, async url => {
    const result = await fetchReleaseArtifact(url, { maxBytes: 5000, chunkSize: 2048 })
    assert.equal(result.response.status, 404)
    assert.equal(result.bytes.toString(), 'missing')
  })
})
