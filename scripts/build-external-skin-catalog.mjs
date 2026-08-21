#!/usr/bin/env node
/**
 * Builds the external skin source catalog.
 *
 * The launcher never redistributes these files: this script only records where
 * each asset lives upstream plus the digest needed to verify it after download.
 * Because delivery goes through third-party GitHub mirrors, pinning SHA-256 here
 * is what keeps a hostile mirror from substituting content at apply time.
 *
 * Sources are declared in scripts/external-skin-sources.json. Every entry must
 * carry an explicit licenseStatus and a notice shown verbatim in the UI, so an
 * unlicensed upstream can never be presented as if it were a first-party skin.
 *
 * Usage:
 *   node scripts/build-external-skin-catalog.mjs [--limit 8] [--out skin-store/external-catalog.payload.json]
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCES_FILE = path.join(ROOT, 'scripts', 'external-skin-sources.json')
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_VIDEO_BYTES = 80 * 1024 * 1024
const MIN_WALLPAPER_WIDTH = 1024
const MIN_WALLPAPER_RATIO = 1.4

const MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

function parseArguments(argv) {
  const options = { limit: 8, reuse: false, out: path.join(ROOT, 'skin-store', 'external-catalog.payload.json') }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--limit') options.limit = Number(argv[index + 1])
    if (argv[index] === '--out') options.out = path.resolve(ROOT, argv[index + 1])
    // Local iteration only. Reusing a digest cannot detect that upstream
    // replaced the file, which would ship a pin that fails for every user.
    if (argv[index] === '--reuse') options.reuse = true
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 20) {
    throw new Error('--limit 必须是 1 到 20 之间的整数，目录固定每页 20 项')
  }
  return options
}

/**
 * All declared sources are public, so the unauthenticated rate limit is enough
 * for a handful of tree reads. A token is only picked up when the environment
 * already provides one, for example in CI.
 */
function githubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined
}

async function api(pathname, token) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`https://api.github.com${pathname}`, {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        accept: 'application/vnd.github+json',
        'user-agent': 'external-skin-catalog'
      }
    })
    if (response.ok) return response.json()
    if (response.status === 403 || response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 4000 * (attempt + 1)))
      continue
    }
    throw new Error(`GitHub API ${response.status} ${pathname}`)
  }
  throw new Error(`GitHub API 速率受限：${pathname}`)
}

function encodePath(filePath) {
  return filePath.split('/').map(encodeURIComponent).join('/')
}

function rawUrl(repo, branch, filePath) {
  return `https://raw.githubusercontent.com/${repo}/${branch}/${encodePath(filePath)}`
}

function previewUrl(repo, branch, filePath) {
  return `https://cdn.statically.io/gh/${repo}/${branch}/${encodePath(filePath)}?w=640&h=360&format=webp`
}

/** Downloads once to pin the exact digest and byte count the launcher will enforce. */
async function digestAsset(url, limit) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'external-skin-catalog' } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const hash = createHash('sha256')
  let size = 0
  let header
  for await (const chunk of response.body) {
    if (!header) header = Buffer.from(chunk.subarray(0, 64))
    size += chunk.length
    if (size > limit) throw new Error(`素材超过 ${Math.round(limit / 1024 / 1024)} MiB 上限`)
    hash.update(chunk)
  }
  if (!size) throw new Error('素材为空')
  return { sha256: hash.digest('hex'), size, header }
}

/**
 * Reads intrinsic dimensions from the leading bytes so the catalog can reject
 * portrait or low-resolution media that would look wrong as a wallpaper.
 */
function intrinsicSize(extension, header) {
  if (!header) return undefined
  if (extension === '.gif' && header.length >= 10) {
    const signature = header.toString('latin1', 0, 6)
    if (signature !== 'GIF87a' && signature !== 'GIF89a') return undefined
    return { width: header.readUInt16LE(6), height: header.readUInt16LE(8) }
  }
  if (extension === '.png' && header.length >= 24 && header.readUInt32BE(0) === 0x89504e47) {
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
  }
  if (extension === '.webp' && header.length >= 30 && header.toString('latin1', 0, 4) === 'RIFF') {
    if (header.toString('latin1', 12, 16) !== 'VP8X') return undefined
    return { width: (header.readUIntLE(24, 3) & 0xffffff) + 1, height: (header.readUIntLE(27, 3) & 0xffffff) + 1 }
  }
  return undefined
}

/**
 * Built from owner, repository and the full file path. The owner matters
 * because `wallpapers` is a very common repository name, and the full path
 * matters because collections reuse one filename across folders; dropping
 * either makes distinct assets collapse onto one id.
 */
function slugFor(repo, filePath) {
  const withoutExtension = filePath.slice(0, filePath.length - path.extname(filePath).length)
  const slug = `${repo.replace('/', '-')}-${withoutExtension}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/, '')
  return `ext-${slug || 'item'}`
}

function spread(list, count) {
  if (list.length <= count) return list
  const step = list.length / count
  return Array.from({ length: count }, (_, index) => list[Math.floor(index * step)])
}

const options = parseArguments(process.argv.slice(2))
const token = githubToken()
const declared = JSON.parse(await readFile(SOURCES_FILE, 'utf8'))

const cachedDigests = new Map()
if (options.reuse) {
  try {
    const previous = JSON.parse(await readFile(options.out, 'utf8'))
    for (const item of previous.items || []) cachedDigests.set(item.media.url, item.media)
    process.stderr.write(`复用上一次目录中的 ${cachedDigests.size} 个摘要（--reuse 仅用于本地迭代）\n`)
  } catch {
    // No previous catalog to reuse.
  }
}

const sources = []
const items = []
const usedIds = new Set()
const skippedSources = []

for (const source of declared.sources) {
  if (!source.notice?.trim()) throw new Error(`来源 ${source.repo} 缺少 notice，必须向用户说明权利状况`)
  process.stderr.write(`\n${source.repo}  ${source.licenseName}  ${source.licenseStatus}\n`)
  try {
  const meta = await api(`/repos/${source.repo}`, token)
  const branch = source.branch || meta.default_branch
  const tree = await api(`/repos/${source.repo}/git/trees/${branch}?recursive=1`, token)
  const include = new RegExp(source.include || '\\.(png|jpe?g|webp|gif|mp4|webm)$', 'i')
  const exclude = source.exclude ? new RegExp(source.exclude, 'i') : undefined
  const candidates = (tree.tree || [])
    .filter((node) => node.type === 'blob' && include.test(node.path) && !(exclude && exclude.test(node.path)))
    .filter((node) => (node.size || 0) > 40_000)
    .sort((left, right) => left.path.localeCompare(right.path))
  let added = 0
  for (const candidate of spread(candidates, options.limit * 3)) {
    if (added >= options.limit) break
    const extension = path.extname(candidate.path).toLowerCase()
    const mime = MIME_BY_EXTENSION[extension]
    if (!mime) continue
    const limit = mime.startsWith('video/') ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
    const url = rawUrl(source.repo, branch, candidate.path)
    const cached = cachedDigests.get(url)
    let digest
    if (cached) {
      digest = { sha256: cached.sha256, size: cached.size, header: undefined }
    } else {
      try {
        digest = await digestAsset(url, limit)
      } catch (error) {
        process.stderr.write(`  skip ${candidate.path} :: ${error.message}\n`)
        continue
      }
    }
    const intrinsic = intrinsicSize(extension, digest.header)
    if (intrinsic && (intrinsic.width < MIN_WALLPAPER_WIDTH || intrinsic.width / intrinsic.height < MIN_WALLPAPER_RATIO)) {
      process.stderr.write(`  skip ${candidate.path} :: ${intrinsic.width}x${intrinsic.height} 不适合作横向壁纸\n`)
      continue
    }
    const id = slugFor(source.repo, candidate.path)
    if (usedIds.has(id)) {
      process.stderr.write(`  skip ${candidate.path} :: 目录 ID 冲突 ${id}\n`)
      continue
    }
    usedIds.add(id)
    items.push({
      id,
      name: source.namePrefix ? `${source.namePrefix} · ${path.basename(candidate.path, extension)}` : path.basename(candidate.path, extension),
      description: source.description,
      mediaKind: mime.startsWith('video/') ? 'video' : extension === '.gif' ? 'animated-image' : 'image',
      styles: source.styles,
      tags: source.tags,
      contentRating: 'everyone',
      thumbnailUrl: previewUrl(source.repo, branch, candidate.path),
      media: { url, sha256: digest.sha256, size: digest.size, mime },
      origin: {
        repo: source.repo,
        repoUrl: `https://github.com/${source.repo}`,
        author: source.author,
        licenseName: source.licenseName,
        licenseStatus: source.licenseStatus,
        notice: source.notice
      },
      presentation: source.presentation
    })
    added += 1
    process.stderr.write(`  ${cached ? 'reuse' : 'ok   '} ${candidate.path}  ${(digest.size / 1024 / 1024).toFixed(2)} MB  ${digest.sha256.slice(0, 12)}…\n`)
  }
  if (!added) {
    process.stderr.write('  没有取到可用素材，跳过该来源\n')
    skippedSources.push(`${source.repo}（无可用素材）`)
    continue
  }
  sources.push({
    repo: source.repo,
    repoUrl: `https://github.com/${source.repo}`,
    author: source.author,
    licenseName: source.licenseName,
    licenseStatus: source.licenseStatus,
    itemCount: added
  })
  } catch (error) {
    // One unreachable or renamed repository must not discard the whole catalog.
    process.stderr.write(`  来源读取失败，已跳过：${error.message}\n`)
    skippedSources.push(`${source.repo}（${error.message}）`)
  }
}

if (!sources.length) throw new Error('没有任何来源产出素材，不写出空目录')

const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  pageSize: 20,
  sources,
  items
}

await writeFile(options.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
const animated = items.filter((item) => item.mediaKind === 'animated-image').length
process.stderr.write(`\n写出 ${path.relative(ROOT, options.out)}：${sources.length} 个来源，${items.length} 个素材（其中 ${animated} 个循环动图）\n`)
if (skippedSources.length) process.stderr.write(`跳过 ${skippedSources.length} 个来源：${skippedSources.join('、')}\n`)
process.stderr.write('下一步用 scripts/sign-store-catalogs.mjs 同款流程签名为 external-catalog.json\n')
