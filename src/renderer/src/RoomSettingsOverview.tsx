import { Bot, ShieldCheck } from 'lucide-react'
import './room-settings-overview.css'

export interface RoomRuleView { label: string; value: string; detail?: string }
export interface RoomMemberView {
  id: string
  name: string
  handle: string
  role: string
  adapter: string
  project: string
  session: string
  responsibility: string
  status: string
  capability?: string
}

export function RoomSettingsOverview({ rules, members, boundary }: { rules: RoomRuleView[]; members: RoomMemberView[]; boundary: string }): React.JSX.Element {
  return <div className="room-settings-overview">
    <section className="rso-rules" aria-labelledby="rso-rules-title">
      <header><span className="rso-icon" aria-hidden="true"><ShieldCheck size={16} /></span><div><h3 id="rso-rules-title">公共规则</h3><p>对当前 {members.length} 位成员统一生效</p></div></header>
      <dl>{rules.map(rule => <div key={rule.label}><dt>{rule.label}</dt><dd><strong>{rule.value}</strong>{rule.detail && <small>{rule.detail}</small>}</dd></div>)}</dl>
      <p className="rso-boundary">{boundary}</p>
    </section>
    <section className="rso-members" aria-labelledby="rso-members-title">
      <header><h3 id="rso-members-title">成员参数</h3><span>{members.length} 个独立执行身份</span></header>
      <div>{members.map(member => <article className="rso-member" key={member.id}>
        <header><span className="rso-avatar" aria-hidden="true"><Bot size={15} /></span><div><strong>{member.name}</strong><small>@{member.handle} · {member.role}</small></div><span className="rso-status">{member.status}</span></header>
        <dl><div><dt>智能体</dt><dd>{member.adapter}</dd></div><div><dt>授权项目</dt><dd>{member.project}</dd></div><div><dt>独立会话</dt><dd>{member.session}</dd></div><div><dt>职责</dt><dd>{member.responsibility || '尚未填写'}</dd></div>{member.capability && <div><dt>执行能力</dt><dd>{member.capability}</dd></div>}</dl>
      </article>)}</div>
    </section>
  </div>
}
