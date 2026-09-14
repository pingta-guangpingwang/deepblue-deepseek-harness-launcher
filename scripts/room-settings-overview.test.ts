import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (name: string): string => readFileSync(new URL(`../src/renderer/src/${name}`, import.meta.url), 'utf8')

describe('room settings overview', () => {
  it('shows room-wide rules and the effective member count', () => {
    const source = read('RoomSettingsOverview.tsx')

    expect(source).toContain('公共规则')
    expect(source).toContain('对当前 {members.length} 位成员统一生效')
    expect(source).toContain('成员参数')
    for (const label of ['智能体', '授权项目', '独立会话', '职责', '执行能力']) expect(source).toContain(`<dt>${label}</dt>`)
  })

  it('exposes the same overview in local and cloud rooms', () => {
    const local = read('LocalRoomWorkspace.tsx')
    const cloud = read('AgentSessionGroups.tsx')

    expect(local).toContain("useState<'tasks' | 'rules'>('tasks')")
    expect(local).toContain('查看房间设置与规则')
    expect(local).toContain('<RoomSettingsOverview rules={roomRules} members={roomMembers}')
    expect(local).toContain("label: '审批级别'")
    expect(local).toContain("label: '单轮上限'")
    expect(local).toContain('`${descriptor.name} · ${descriptor.adapter}`')

    expect(cloud).toContain('成员与规则')
    expect(cloud).toContain('房间成员与公共规则')
    expect(cloud).toContain('<RoomSettingsOverview rules={cloudRules} members={cloudMembers}')
    expect(cloud).toContain("label: '执行权限'")
    expect(cloud).toContain("label: '消息路由'")
  })
})
