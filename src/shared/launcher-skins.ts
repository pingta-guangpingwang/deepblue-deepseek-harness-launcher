export const LAUNCHER_SKINS = [
  { id: 'deepseek', name: '深蓝', description: '清爽浅色与深蓝强调', accent: '#4d6bfe', canvas: '#f7f8fa', bubble: '#d9f2c8' },
  { id: 'jade', name: '竹青', description: '柔和青绿，适合长时间工作', accent: '#18715c', canvas: '#f1f6f3', bubble: '#d6ebdb' },
  { id: 'sand', name: '暖砂', description: '暖灰纸感，减少冷色刺激', accent: '#8a562d', canvas: '#f7f3ec', bubble: '#eadfcb' },
  { id: 'slate', name: '石墨', description: '中性灰蓝，突出项目与内容', accent: '#4b5b75', canvas: '#f0f2f5', bubble: '#dbe4ef' }
] as const
export type LauncherSkin = typeof LAUNCHER_SKINS[number]['id']
export function normalizeLauncherSkin(value: unknown): LauncherSkin { return LAUNCHER_SKINS.some(skin => skin.id === value) ? value as LauncherSkin : 'deepseek' }
