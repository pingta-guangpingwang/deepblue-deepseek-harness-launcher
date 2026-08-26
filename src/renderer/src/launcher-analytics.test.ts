import { describe, expect, it } from 'vitest'
import { classifyLauncherFeature } from './launcher-analytics'

describe('launcher analytics feature classifier', () => {
  it('maps dynamic card labels to stable, content-free feature names', () => {
    expect(classifyLauncherFeature('查看 Claude Code Skill 详情')).toEqual({ id: 'view_detail', label: '查看内容详情' })
    expect(classifyLauncherFeature('应用到电脑桌面')).toEqual({ id: 'apply_desktop', label: '应用到电脑桌面' })
    expect(classifyLauncherFeature('同步网站目录')).toEqual({ id: 'refresh_catalog', label: '刷新在线目录' })
  })

  it('ignores pagination and unknown labels instead of sending raw copy', () => {
    expect(classifyLauncherFeature('12')).toBeUndefined()
    expect(classifyLauncherFeature('王小明的私有工作区')).toBeUndefined()
  })

  it('keeps remove and install actions separate', () => {
    expect(classifyLauncherFeature('安装到 web profile')?.id).toBe('install_item')
    expect(classifyLauncherFeature('卸载插件')?.id).toBe('uninstall_item')
  })
})
