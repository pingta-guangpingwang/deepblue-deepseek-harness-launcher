import { describe, expect, it, vi } from 'vitest'
import { ProjectDirectoryPicker } from './project-directory-picker'
describe('native project picker lifecycle', () => {
  it('rejects overlapping windows without sharing the first caller grant', async () => {
    const picker = new ProjectDirectoryPicker()
    let complete!: (value: string | undefined) => void
    const first = picker.choose(() => new Promise(resolve => { complete = resolve }))
    const second = vi.fn(async () => 'different-project')
    await expect(picker.choose(second)).rejects.toThrow('已有项目目录选择窗口')
    expect(second).not.toHaveBeenCalled()
    complete('selected-project'); await expect(first).resolves.toBe('selected-project')
  })
  it('permits reopening after cancellation and after failure', async () => {
    const picker = new ProjectDirectoryPicker()
    await expect(picker.choose(async () => undefined)).resolves.toBeUndefined()
    await expect(picker.choose(async () => { throw new Error('native failure') })).rejects.toThrow('native failure')
    await expect(picker.choose(async () => 'selected-project')).resolves.toBe('selected-project')
  })
})
