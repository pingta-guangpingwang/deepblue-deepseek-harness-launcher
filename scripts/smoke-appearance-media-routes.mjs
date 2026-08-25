#!/usr/bin/env node
/**
 * Proves the appearance plugin can actually serve every skin media kind the
 * catalogs allow, not just answer the config route.
 *
 * The existing cache smoke only checks that config URLs carry a content version.
 * It never requests the media route, so GIF and video delivery was unverified:
 * a wrong Content-Type would make the browser refuse the wallpaper, and missing
 * Range support would break video seeking. Both are asserted here for the
 * animated-image and video kinds carried by the two official Gitee stores.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../bundled-plugins/deepblue-dsh-skin-runtime/lib/index.js'

/** Real magic bytes so the nosniff header the plugin sets stays meaningful. */
const FIXTURES = {
  gif: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
  webp: Buffer.concat([
    Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 '),
    Buffer.from([0x0e, 0, 0, 0]), Buffer.from([0x10, 0, 0, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00])
  ]),
  mp4: Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.from([0, 0, 0x02, 0]), Buffer.from('isomiso2'),
    Buffer.from([0, 0, 0, 0x08]), Buffer.from('free'), Buffer.alloc(64, 0x21)
  ]),
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(48, 0x33)])
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'deepblue-appearance-media-'))
const skinConfig = path.join(temporary, 'skin.json')
const petConfig = path.join(temporary, 'pet.json')
const routes = []

function recorder() {
  const chunks = []
  return {
    status: 0,
    headers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers || {} },
    end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); this.finished = true },
    write(chunk) { chunks.push(Buffer.from(chunk)) },
    on() { return this },
    once() { return this },
    emit() { return true },
    body() { return Buffer.concat(chunks) }
  }
}

/** createReadStream().pipe(res) resolves asynchronously, so wait for the stream. */
async function request(route, headers = {}, method = 'GET') {
  const response = recorder()
  const finished = new Promise((resolve) => {
    const originalEnd = response.end.bind(response)
    response.end = (chunk) => { originalEnd(chunk); resolve() }
  })
  const definition = routes.find(candidate => candidate.kind === 'exact' ? candidate.path === route : route.startsWith(candidate.path))
  assert.ok(definition, `route ${route} is registered`)
  await definition.handler({ method, headers, url: route }, response)
  await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 2000))])
  return response
}

async function writeSkin(kind, filename, extra = {}) {
  await writeFile(skinConfig, JSON.stringify({
    schemaVersion: 1,
    skinId: 'media-route-check',
    mediaKind: kind,
    mediaPath: path.join(temporary, filename),
    presentation: { position: '50% 50%', overlay: 'rgba(0,0,0,.3)', blurPx: 0, surfaceOpacity: 0.7 },
    ...extra
  }))
}

try {
  process.env.DEEPBLUE_DSH_SKIN_CONFIG = skinConfig
  process.env.DEEPBLUE_DSH_PET_CONFIG = petConfig
  apply({
    webServer: { register(definition) { routes.push(definition) } },
    effect(callback) { callback() }
  })

  for (const [name, bytes] of Object.entries(FIXTURES)) {
    await writeFile(path.join(temporary, `asset.${name}`), bytes)
  }

  const cases = [
    { kind: 'animated-image', file: 'asset.gif', mime: 'image/gif', bytes: FIXTURES.gif },
    { kind: 'animated-image', file: 'asset.webp', mime: 'image/webp', bytes: FIXTURES.webp },
    { kind: 'video', file: 'asset.mp4', mime: 'video/mp4', bytes: FIXTURES.mp4 },
    { kind: 'image', file: 'asset.png', mime: 'image/png', bytes: FIXTURES.png }
  ]

  for (const item of cases) {
    await writeSkin(item.kind, item.file)

    const config = await request('/deepblue-skin/config')
    assert.equal(config.status, 200, `${item.file} config route`)
    const parsed = JSON.parse(config.body().toString('utf8'))
    assert.equal(parsed.mediaKind, item.kind, `${item.file} advertises its media kind`)
    assert.equal(parsed.mediaUrl, `/deepblue-skin/media?v=${item.file}`, `${item.file} media URL carries a content version`)

    const media = await request('/deepblue-skin/media')
    assert.equal(media.status, 200, `${item.file} media route status`)
    assert.equal(media.headers['content-type'], item.mime, `${item.file} served as ${item.mime}`)
    assert.equal(media.headers['content-length'], item.bytes.length, `${item.file} full length`)
    assert.equal(media.headers['accept-ranges'], 'bytes', `${item.file} advertises range support`)
    assert.equal(media.headers['x-content-type-options'], 'nosniff', `${item.file} blocks sniffing`)
    assert.ok(media.body().equals(item.bytes), `${item.file} bytes served intact`)

    const head = await request('/deepblue-skin/media', {}, 'HEAD')
    assert.equal(head.status, 200, `${item.file} HEAD status`)
    assert.equal(head.body().length, 0, `${item.file} HEAD sends no body`)

    // Video seeking depends on partial responses being correct.
    const ranged = await request('/deepblue-skin/media', { range: 'bytes=2-5' })
    assert.equal(ranged.status, 206, `${item.file} partial status`)
    assert.equal(ranged.headers['content-range'], `bytes 2-5/${item.bytes.length}`, `${item.file} content range`)
    assert.equal(ranged.headers['content-length'], 4, `${item.file} partial length`)
    assert.ok(ranged.body().equals(item.bytes.subarray(2, 6)), `${item.file} partial bytes`)

    const unsatisfiable = await request('/deepblue-skin/media', { range: `bytes=${item.bytes.length + 10}-` })
    assert.equal(unsatisfiable.status, 416, `${item.file} rejects an out-of-range request`)
  }

  await writeSkin('video', 'asset.mp4', { posterPath: path.join(temporary, 'asset.png') })
  const poster = await request('/deepblue-skin/poster')
  assert.equal(poster.status, 200, 'poster route status')
  assert.equal(poster.headers['content-type'], 'image/png', 'poster served as image/png')

  await writeSkin('animated-image', 'asset.gif')
  const withoutPoster = await request('/deepblue-skin/poster')
  assert.equal(withoutPoster.status, 404, 'animated skins without a poster return 404 rather than a stale file')

  await writeFile(petConfig, JSON.stringify({
    schemaVersion: 1,
    petId: 'media-route-check',
    mediaKind: 'animated',
    mediaPath: path.join(temporary, 'asset.webp'),
    behavior: { widthPx: 180, idleMotion: 'float', clickMotion: 'heart', speechLines: [] }
  }))
  const petMedia = await request('/deepblue-pet/media')
  assert.equal(petMedia.status, 200, 'pet media route status')
  assert.equal(petMedia.headers['content-type'], 'image/webp', 'animated pet served as image/webp')

  await writeFile(petConfig, JSON.stringify({
    schemaVersion: 1,
    petId: 'pixel-route-check',
    mediaKind: 'animated',
    packKind: 'pixel-atlas',
    mediaPath: path.join(temporary, 'asset.webp'),
    behavior: { widthPx: 180, idleMotion: 'none', clickMotion: 'heart', speechLines: [] }
  }))
  const pixelConfig = await request('/deepblue-pet/config')
  assert.equal(pixelConfig.status, 200, 'pixel pet config route status')
  assert.equal(JSON.parse(pixelConfig.body().toString('utf8')).packKind, 'pixel-atlas', 'pixel pet config keeps the atlas contract')

  const rejected = await request('/deepblue-skin/media', {}, 'POST')
  assert.equal(rejected.status, 405, 'media route rejects writes')

  console.log('Appearance media route smoke passed: gif, webp, mp4, png and pixel-atlas routes')
} finally {
  delete process.env.DEEPBLUE_DSH_SKIN_CONFIG
  delete process.env.DEEPBLUE_DSH_PET_CONFIG
  await rm(temporary, { recursive: true, force: true })
}
