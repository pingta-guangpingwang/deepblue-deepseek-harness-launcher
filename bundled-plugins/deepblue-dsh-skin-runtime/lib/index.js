import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const CONFIG_PATH = '/deepblue-skin/config'
const MEDIA_PATH = '/deepblue-skin/media'
const POSTER_PATH = '/deepblue-skin/poster'
const PET_CONFIG_PATH = '/deepblue-pet/config'
const PET_MEDIA_PATH = '/deepblue-pet/media'

function versionedMediaUrl(route, filename) {
  return `${route}?v=${encodeURIComponent(path.basename(filename))}`
}

export const inject = ['webServer']

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(body)
}

async function readConfig() {
  const filename = process.env.DEEPBLUE_DSH_SKIN_CONFIG
  if (!filename) return undefined
  try {
    const value = JSON.parse(await readFile(filename, 'utf8'))
    if (value?.schemaVersion !== 1 || typeof value.skinId !== 'string' || !['image', 'animated-image', 'video'].includes(value.mediaKind) || typeof value.mediaPath !== 'string') return undefined
    return value
  } catch {
    return undefined
  }
}

async function readPetConfig() {
  const filename = process.env.DEEPBLUE_DSH_PET_CONFIG
  if (!filename) return undefined
  try {
    const value = JSON.parse(await readFile(filename, 'utf8'))
    if (value?.schemaVersion !== 1 || typeof value.petId !== 'string' || !['static', 'animated'].includes(value.mediaKind) || typeof value.mediaPath !== 'string') return undefined
    return value
  } catch {
    return undefined
  }
}

function mimeFor(filename) {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.webm')) return 'video/webm'
  return 'application/octet-stream'
}

async function serveFile(req, res, filename) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  let info
  try {
    info = await stat(filename)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }
  const common = {
    'content-type': mimeFor(filename),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff'
  }
  const range = req.headers.range
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range)
    if (!match) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` })
      res.end()
      return
    }
    const start = Number(match[1])
    const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` })
      res.end()
      return
    }
    res.writeHead(206, { ...common, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 })
    if (req.method === 'HEAD') res.end()
    else createReadStream(filename, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...common, 'content-length': info.size })
  if (req.method === 'HEAD') res.end()
  else createReadStream(filename).pipe(res)
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      const config = await readConfig()
      if (!config) {
        res.writeHead(204, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      json(res, 200, {
        schemaVersion: 1,
        skinId: config.skinId,
        mediaKind: config.mediaKind,
        mediaUrl: versionedMediaUrl(MEDIA_PATH, config.mediaPath),
        ...(config.posterPath ? { posterUrl: versionedMediaUrl(POSTER_PATH, config.posterPath) } : {}),
        presentation: config.presentation
      })
    }
  }), 'deepblue skin config route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MEDIA_PATH,
    handler: async (req, res) => {
      const config = await readConfig()
      if (!config) {
        res.writeHead(404)
        res.end()
        return
      }
      await serveFile(req, res, config.mediaPath)
    }
  }), 'deepblue skin media route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: POSTER_PATH,
    handler: async (req, res) => {
      const config = await readConfig()
      if (!config?.posterPath) {
        res.writeHead(404)
        res.end()
        return
      }
      await serveFile(req, res, config.posterPath)
    }
  }), 'deepblue skin poster route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PET_CONFIG_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      const config = await readPetConfig()
      if (!config) {
        res.writeHead(204, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      json(res, 200, {
        schemaVersion: 1,
        petId: config.petId,
        mediaKind: config.mediaKind,
        mediaUrl: versionedMediaUrl(PET_MEDIA_PATH, config.mediaPath),
        behavior: config.behavior
      })
    }
  }), 'deepblue pet config route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PET_MEDIA_PATH,
    handler: async (req, res) => {
      const config = await readPetConfig()
      if (!config) {
        res.writeHead(404)
        res.end()
        return
      }
      await serveFile(req, res, config.mediaPath)
    }
  }), 'deepblue pet media route')
}
