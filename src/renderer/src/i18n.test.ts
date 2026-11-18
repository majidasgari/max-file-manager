import assert from 'node:assert/strict'
import test from 'node:test'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getLang, hasTranslation, setLang, subscribeLang, t } from './i18n.ts'
import { COLUMNS, colLabel } from './prefs.ts'
import { COMMANDS, GROUP_LABEL } from './commands.ts'

test('English is the default and the catalogue translates both ways', () => {
  setLang('en')
  assert.equal(getLang(), 'en')
  assert.equal(t('زبان'), 'Language')
  assert.equal(t('انگلیسی'), 'English')
  assert.equal(t('فارسی'), 'Persian')
  setLang('fa')
  assert.equal(getLang(), 'fa')
  assert.equal(t('زبان'), 'زبان')
  assert.equal(t('فارسی'), 'فارسی')
  setLang('en')
})

test('a nonsense language falls back to English', () => {
  setLang('de' as never)
  assert.equal(getLang(), 'en')
})

test('the wallpaper label is translated', () => {
  setLang('en')
  assert.equal(t('تنظیم به‌عنوان پس‌زمینهٔ میزکار'), 'Set as desktop background')
  setLang('fa')
  assert.equal(t('تنظیم به‌عنوان پس‌زمینهٔ میزکار'), 'تنظیم به‌عنوان پس‌زمینهٔ میزکار')
  setLang('en')
})

test('all seven wallpaper fill labels are translated', () => {
  const labels: [string, string][] = [
    ['پرکردن کادر (برش لبه‌ها)', 'Fill the frame (crop the edges)'],
    ['کشیده تا پر کند', 'Stretch to fill'],
    ['کامل با حفظ نسبت', 'Fit while keeping the ratio'],
    ['کاشی', 'Tile'],
    ['کاشی عمودی', 'Tile vertically'],
    ['کاشی افقی', 'Tile horizontally'],
    ['وسط‌چین با حاشیه', 'Centered with padding']
  ]
  setLang('en')
  for (const [fa, en] of labels) assert.equal(t(fa), en, fa)
  setLang('fa')
  for (const [fa] of labels) assert.equal(t(fa), fa, fa)
  setLang('en')
})

test('subscribers fire only when the language actually changes', () => {
  let calls = 0
  const off = subscribeLang(() => calls++)
  setLang('fa')
  setLang('fa')
  setLang('en')
  off()
  setLang('fa')
  assert.equal(calls, 2)
  setLang('en')
})

test('column labels are translated at render, not frozen at import', () => {
  assert.equal(COLUMNS.find((c) => c.id === 'type')?.label, 'نوع')
  setLang('en')
  assert.equal(colLabel('type'), 'Type')
  setLang('fa')
  assert.equal(colLabel('type'), 'نوع')
  setLang('en')
})

/**
 * The catalogue falls back to the Persian source, which is the right behaviour at runtime and the
 * wrong outcome in an English UI: a forgotten `t()` key is invisible until someone switches
 * language. This walks the sources and fails on every literal `t('…')` that has no translation.
 */
const ROOT = fileURLToPath(new URL('.', import.meta.url))

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    // the icon pack is linked into the renderer and carries case-only symlinks that point at
    // themselves on a case-insensitive filesystem (APFS): following them recurses until ELOOP
    const st = lstatSync(full)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) out.push(...sources(full))
    else if (/\.tsx?$/.test(name) && !/\.test\.ts$/.test(name) && name !== 'i18n.ts') out.push(full)
  }
  return out
}

test('every literal t() key has an English translation', () => {
  const missing: string[] = []
  for (const file of sources(ROOT)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      const key = m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n')
      if (!hasTranslation(key)) missing.push(`${path.relative(ROOT, file)}: ${key}`)
    }
  }
  assert.deepEqual(missing, [], `these keys would show Persian in the English UI:\n${missing.join('\n')}`)
})

test('no English value is still Persian', () => {
  const src = readFileSync(path.join(ROOT, 'i18n.ts'), 'utf8')
  const persian: string[] = []
  for (const m of src.matchAll(/^\s{2}'((?:[^'\\]|\\.)*)':\s*'((?:[^'\\]|\\.)*)'/gm)) {
    if (/[\u0600-\u06ff]/.test(m[2])) persian.push(m[1])
  }
  assert.deepEqual(persian, [])
})

test('every command label (ribbon, menus, keys page) is translated', () => {
  const missing: string[] = []
  for (const c of COMMANDS) {
    for (const key of [c.label, c.short].filter((x): x is string => typeof x === 'string')) {
      if (!hasTranslation(key)) missing.push(`${c.id}: ${key}`)
    }
  }
  for (const key of Object.values(GROUP_LABEL)) if (!hasTranslation(key)) missing.push(`group: ${key}`)
  assert.deepEqual(missing, [])
})
