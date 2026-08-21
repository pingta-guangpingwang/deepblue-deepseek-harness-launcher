#!/usr/bin/env node
/**
 * Release gate for the external skin source catalog.
 *
 * Unlike verify-skin-catalog.mjs this catalog has no local assets by design:
 * bytes stay on the upstream repository and the launcher only stores addresses
 * plus pinned digests. So the structural half of this check enforces exactly
 * that, and `--live` re-downloads every asset to confirm the pins still match.
 *
 * A live mismatch means upstream replaced the file. Publishing that catalog
 * would make the item fail for every user, so regenerate before releasing.
 *
 * Usage:
 *   node scripts/verify-external-skin-catalog.mjs           # signature + structure
 *   node scripts/verify-external-skin-catalog.mjs --live    # also re-download and compare digests
 */

import { createHash, verify } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const SIGNED = path.resolve('skin-store', 'external-catalog.json')
const PAYLOAD = path.resolve('skin-store', 'external-catalog.payload.json')
const PUBLIC_KEY = path.resolve('resources', 'skin-catalog-public-key.pem')
const LICENSE_STATUS = new Set(['redistributable', 'copyleft', 'undeclared'])
const PREVIEW_HOSTS = new Set(['cdn.statically.io', 'cdn.jsdelivr.net', 'raw.githubusercontent.com'])
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_VIDEO_BYTES = 80 * 1024 * 1024

const live = process.argv.includes('--live')

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function loadPayload() {
  if (await exists(SIGNED)) {
    const manifest = JSON.parse(await readFile(SIGNED, 'utf8'))
    if (manifest.algorithm !== 'ed25519') throw new Error('外部目录信封算法不是 ed25519')
    if (!(await exists(PUBLIC_KEY))) {
      process.stderr.write('注意：缺少 resources/skin-catalog-public-key.pem，跳过签名校验，仅做结构校验\n')
      return manifest.payload
    }
    const publicKey = await readFile(PUBLIC_KEY, 'utf8')
    if (!verify(null, Buffer.from(JSON.stringify(manifest.payload)), publicKey, Buffer.from(manifest.signature, 'base64'))) {
      throw new Error('外部目录签名校验失败')
    }
    process.stderr.write(`签名校验通过，keyId=${manifest.keyId}\n`)
    return manifest.payload
  }
  if (!(await exists(PAYLOAD))) throw new Error('未找到 external-catalog.json 或 external-catalog.payload.json')
  process.stderr.write('注意：只找到未签名的 payload，尚未签名发布，仅做结构校验\n')
  return JSON.parse(await readFile(PAYLOAD, 'utf8'))
}

function assertStructure(payload) {
  if (payload.schemaVersion !== 1 || payload.pageSize !== 20) throw new Error('外部目录 schema 或分页不兼容')
  if (!Array.isArray(payload.sources) || !Array.isArray(payload.items)) throw new Error('外部目录缺少 sources 或 items')
  const repos = new Map()
  for (const source of payload.sources) {
    if (!/^[\w.-]{1,39}\/[\w.-]{1,100}$/.test(source.repo)) throw new Error(`来源名无效：${source.repo}`)
    if (repos.has(source.repo)) throw new Error(`来源重复：${source.repo}`)
    const repoUrl = new URL(source.repoUrl)
    if (repoUrl.protocol !== 'https:' || repoUrl.hostname !== 'github.com') throw new Error(`来源地址无效：${source.repo}`)
    if (!LICENSE_STATUS.has(source.licenseStatus)) throw new Error(`来源许可证状态无效：${source.repo}`)
    if (!source.notice && source.licenseStatus === 'undeclared' && !source.licenseName) {
      throw new Error(`未声明许可证的来源必须写明状态：${source.repo}`)
    }
    repos.set(source.repo, 0)
  }
  const ids = new Set()
  for (const item of payload.items) {
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(item.id)) throw new Error(`素材 ID 无效：${item.id}`)
    if (ids.has(item.id)) throw new Error(`素材 ID 重复：${item.id}`)
    ids.add(item.id)
    if (item.contentRating !== 'everyone') throw new Error(`${item.id} 内容分级不受支持`)
    if (!repos.has(item.origin?.repo)) throw new Error(`${item.id} 的来源未在 sources 中声明`)
    repos.set(item.origin.repo, repos.get(item.origin.repo) + 1)
    if (!LICENSE_STATUS.has(item.origin.licenseStatus)) throw new Error(`${item.id} 许可证状态无效`)
    if (!item.origin.notice?.trim()) throw new Error(`${item.id} 缺少权利说明`)
    if (item.origin.licenseStatus === 'undeclared' && !item.origin.notice.includes('没有 LICENSE')) {
      throw new Error(`${item.id} 未声明许可证，但权利说明没有讲清这一点`)
    }
    const preview = new URL(item.thumbnailUrl)
    if (preview.protocol !== 'https:' || !PREVIEW_HOSTS.has(preview.hostname)) throw new Error(`${item.id} 预览地址不受支持`)
    for (const [kind, asset] of [['media', item.media], ...(item.poster ? [['poster', item.poster]] : [])]) {
      const url = new URL(asset.url)
      // The whole point of this catalog is that we link rather than redistribute.
      if (url.hostname !== 'raw.githubusercontent.com') throw new Error(`${item.id} 的 ${kind} 必须由上游仓库提供`)
      if (!url.pathname.startsWith(`/${item.origin.repo}/`)) throw new Error(`${item.id} 的 ${kind} 不属于声明的上游仓库`)
      if (!/^[a-f0-9]{64}$/i.test(asset.sha256)) throw new Error(`${item.id} 的 ${kind} SHA-256 无效`)
      const limit = asset.mime.startsWith('video/') ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
      if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > limit) throw new Error(`${item.id} 的 ${kind} 体积超限`)
    }
  }
  for (const source of payload.sources) {
    if (repos.get(source.repo) !== source.itemCount) {
      throw new Error(`${source.repo} 声明 ${source.itemCount} 项，实际 ${repos.get(source.repo)} 项`)
    }
  }
}

async function checkLive(payload) {
  const drifted = []
  let index = 0
  for (const item of payload.items) {
    index += 1
    const response = await fetch(item.media.url, { redirect: 'follow', headers: { 'user-agent': 'verify-external-skin-catalog' } })
    if (!response.ok) {
      drifted.push(`${item.id}：HTTP ${response.status}`)
      process.stderr.write(`  [${index}/${payload.items.length}] FAIL ${item.id} HTTP ${response.status}\n`)
      continue
    }
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      hash.update(chunk)
    }
    const digest = hash.digest('hex')
    if (digest !== item.media.sha256.toLowerCase() || size !== item.media.size) {
      drifted.push(`${item.id}：上游已变更（${size} 字节 / ${digest.slice(0, 12)}…）`)
      process.stderr.write(`  [${index}/${payload.items.length}] DRIFT ${item.id}\n`)
      continue
    }
    process.stderr.write(`  [${index}/${payload.items.length}] ok ${item.id}\n`)
  }
  return drifted
}

const payload = await loadPayload()
assertStructure(payload)
const animated = payload.items.filter((item) => item.mediaKind === 'animated-image').length
process.stderr.write(`结构校验通过：${payload.sources.length} 个来源，${payload.items.length} 个素材（${animated} 个循环动图）\n`)

const undeclared = payload.sources.filter((source) => source.licenseStatus === 'undeclared')
if (undeclared.length) {
  process.stderr.write(`其中 ${undeclared.length} 个来源未声明许可证，只允许链接展示，不得转存或再分发：${undeclared.map((source) => source.repo).join('、')}\n`)
}

if (!live) {
  process.stderr.write('未加 --live，跳过上游摘要复核。正式发布前请执行一次 --live。\n')
  process.exit(0)
}

process.stderr.write('\n开始复核上游摘要\n')
const drifted = await checkLive(payload)
if (drifted.length) {
  process.stderr.write(`\n${drifted.length} 项与上游不一致，必须重新生成目录后再发布：\n`)
  for (const entry of drifted) process.stderr.write(`  ${entry}\n`)
  process.exit(1)
}
process.stderr.write('\n全部素材与上游摘要一致\n')
