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
  const options = { limit: 8, out: path.join(ROOT, 'skin-store', 'external-catalog.payload.json') }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--limit') options.limit = Number(argv[index + 1])
    if (argv[index] === '--out') options.out = path.resolve(ROOT, argv[index + 1])
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
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > limit) throw new Error(`素材超过 ${Math.round(limit / 1024 / 1024)} MiB 上限`)
    hash.update(chunk)
  }
  if (!size) throw new Error('素材为空')
  return { sha256: hash.digest('hex'), size }
}

function slugFor(repo, filePath) {
  const base = `${repo.split('/')[1]}-${path.basename(filePath, path.extname(filePath))}`
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
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

const sources = []
const items = []
const usedIds = new Set()

for (const source of declared.sources) {
  if (!source.notice?.trim()) throw new Error(`来源 ${source.repo} 缺少 notice，必须向用户说明权利状况`)
  process.stderr.write(`\n${source.repo}  ${source.licenseName}  ${source.licenseStatus}\n`)
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
    let digest
    try {
      digest = await digestAsset(url, limit)
    } catch (error) {
      process.stderr.write(`  skip ${candidate.path} :: ${error.message}\n`)
      continue
    }
    const id = slugFor(source.repo, candidate.path)
    if (usedIds.has(id)) continue
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
    process.stderr.write(`  ok   ${candidate.path}  ${(digest.size / 1024 / 1024).toFixed(2)} MB  ${digest.sha256.slice(0, 12)}…\n`)
  }
  if (!added) {
    process.stderr.write('  没有取到可用素材，跳过该来源\n')
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
process.stderr.write(`\n写出 ${path.relative(ROOT, options.out)}：${sources.length} 个来源，${items.length} 个素材\n`)
process.stderr.write('下一步用 scripts/sign-store-catalogs.mjs 同款流程签名为 external-catalog.json\n')
