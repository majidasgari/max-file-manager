import { setLang } from './i18n.ts'
import { fontStack, type Prefs } from './prefs.ts'

/** The theme/font/language half of the app shell, for windows that are not the main window. */
export function applyPrefs(prefs: Prefs): void {
  setLang(prefs.lang)
  const dark =
    prefs.theme === 'system'
      ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true)
      : prefs.theme !== 'light'
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.dataset.colorTheme = prefs.colorTheme
  document.documentElement.style.setProperty('--ui-font', fontStack(prefs.fontFamily))
}
