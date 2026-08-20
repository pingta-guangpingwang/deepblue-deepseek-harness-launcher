import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../bundled-plugins/deepblue-dsh-skin-runtime/lib/index.js'

const temporary = await mkdtemp(path.join(os.tmpdir(), 'deepblue-appearance-cache-'))
const skinConfig = path.join(temporary, 'skin.json')
const petConfig = path.join(temporary, 'pet.json')
const routes = new Map()

function responseRecorder() {
  const chunks = []
  return {
    status: 0,
    writeHead(status) { this.status = status },
    end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)) },
    body() { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  }
}

async function routeJson(route) {
  const response = responseRecorder()
  await routes.get(route)({ method: 'GET' }, response)
  assert.equal(response.status, 200)
  return response.body()
}

try {
  process.env.DEEPBLUE_DSH_SKIN_CONFIG = skinConfig
  process.env.DEEPBLUE_DSH_PET_CONFIG = petConfig
  apply({
    webServer: { register(definition) { routes.set(definition.path, definition.handler) } },
    effect(callback) { callback() }
  })

  await writeFile(skinConfig, JSON.stringify({
    schemaVersion: 1,
    skinId: 'same-skin-id',
    mediaKind: 'video',
    mediaPath: path.join(temporary, 'skin-first-hash.mp4'),
    posterPath: path.join(temporary, 'poster-first-hash.webp'),
    presentation: { position: '50% 50%', overlay: 'rgba(0,0,0,.3)', blurPx: 0, surfaceOpacity: .7 }
  }))
  await writeFile(petConfig, JSON.stringify({
    schemaVersion: 1,
    petId: 'same-pet-id',
    mediaKind: 'animated',
    mediaPath: path.join(temporary, 'pet-first-hash.webp'),
    behavior: { widthPx: 180, idleMotion: 'float', clickMotion: 'heart', speechLines: [] }
  }))

  const firstSkin = await routeJson('/deepblue-skin/config')
  const firstPet = await routeJson('/deepblue-pet/config')
  assert.equal(firstSkin.mediaUrl, '/deepblue-skin/media?v=skin-first-hash.mp4')
  assert.equal(firstSkin.posterUrl, '/deepblue-skin/poster?v=poster-first-hash.webp')
  assert.equal(firstPet.mediaUrl, '/deepblue-pet/media?v=pet-first-hash.webp')

  await writeFile(skinConfig, JSON.stringify({
    schemaVersion: 1,
    skinId: 'same-skin-id',
    mediaKind: 'video',
    mediaPath: path.join(temporary, 'skin-second-hash.mp4'),
    presentation: { position: '50% 50%', overlay: 'rgba(0,0,0,.3)', blurPx: 0, surfaceOpacity: .7 }
  }))
  await writeFile(petConfig, JSON.stringify({
    schemaVersion: 1,
    petId: 'same-pet-id',
    mediaKind: 'animated',
    mediaPath: path.join(temporary, 'pet-second-hash.webp'),
    behavior: { widthPx: 180, idleMotion: 'float', clickMotion: 'heart', speechLines: [] }
  }))

  const secondSkin = await routeJson('/deepblue-skin/config')
  const secondPet = await routeJson('/deepblue-pet/config')
  assert.notEqual(secondSkin.mediaUrl, firstSkin.mediaUrl)
  assert.notEqual(secondPet.mediaUrl, firstPet.mediaUrl)
  console.log('Appearance runtime cache smoke passed: media URLs change with asset hashes')
} finally {
  delete process.env.DEEPBLUE_DSH_SKIN_CONFIG
  delete process.env.DEEPBLUE_DSH_PET_CONFIG
  await rm(temporary, { recursive: true, force: true })
}
