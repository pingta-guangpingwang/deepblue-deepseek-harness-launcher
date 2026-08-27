import { describe, expect, it } from 'vitest'
import type { PluginOperationState } from '../shared/types'
import { cleanPluginOutput, updatePluginProgress } from './plugin-operation'

function operation(): PluginOperationState {
  return { status: 'resolving', progress: 18, message: '解析中', files: [], restartRequired: false }
}

describe('plugin operation progress', () => {
  it('sanitizes terminal control codes and secrets before showing output', () => {
    expect(cleanPluginOutput('\u001b[32mProgress: resolved 4\u001b[0m\nsk-1234567890abcdef')).toEqual([
      'Progress: resolved 4',
      'sk-***'
    ])
  })

  it('maps pnpm download and install output to monotonic progress', () => {
    const downloading = updatePluginProgress(operation(), 'Progress: resolved 20, reused 4, downloaded 10, added 0')
    expect(downloading.status).toBe('downloading')
    expect(downloading.progress).toBeGreaterThan(35)
    const installing = updatePluginProgress(downloading, 'Progress: resolved 20, reused 4, downloaded 16, added 7')
    expect(installing.status).toBe('installing')
    expect(installing.progress).toBeGreaterThanOrEqual(downloading.progress)
    expect(installing.currentFile).toContain('added 7')
  })

  it('keeps only the latest rolling output lines', () => {
    let state = operation()
    for (let index = 0; index < 140; index += 1) state = updatePluginProgress(state, `node_modules/package-${index}/index.js`)
    expect(state.files).toHaveLength(120)
    expect(state.files[0]).toContain('package-20')
    expect(state.files.at(-1)).toContain('package-139')
  })

  it('explains the long-running reviewed cloudflared build', () => {
    const installing = updatePluginProgress(operation(), 'node_modules/cloudflared postinstall: Installing latest version of cloudflared')
    expect(installing.status).toBe('installing')
    expect(installing.message).toContain('首次安装可能需要数分钟')
    expect(installing.progress).toBeGreaterThanOrEqual(94)
  })
})
