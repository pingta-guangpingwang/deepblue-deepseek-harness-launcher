import { useEffect, useState } from 'react'
import type { LauncherSettings } from '../../shared/types'
import { normalizeLauncherSkin } from '../../shared/launcher-skins'
import './launcher-appearance.css'
export function useLauncherAppearance(settings: LauncherSettings): 'light' | 'dark' {
  const [resolved, setResolved] = useState<'light' | 'dark'>('light')
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => { const theme = settings.theme === 'system' ? media.matches ? 'dark' : 'light' : settings.theme || 'light'; document.documentElement.dataset.theme = theme; document.documentElement.dataset.launcherSkin = normalizeLauncherSkin(settings.launcherSkin); setResolved(theme) }
    apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply)
  }, [settings.theme, settings.launcherSkin])
  return resolved
}
