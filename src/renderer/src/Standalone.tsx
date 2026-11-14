import { t } from './i18n.ts'
import { useEffect, useState } from 'react'
import { api, type Entry } from './api'
import { Gallery } from './Gallery'
import { Editor } from './Editor'
import { applyPrefs } from './apply-prefs'
import { mergePrefs, migrateLegacy, type Prefs } from './prefs'
import { isImage } from './format'
import { WindowButtons } from './WindowButtons'

/** A short-lived message in the corner: these windows have no status bar of the main window. */
function useNote(): { note: string; say(msg: string): void } {
  const [note, setNote] = useState('')
  useEffect(() => {
    if (!note) return
    const timer = setTimeout(() => setNote(''), 3500)
    return () => clearTimeout(timer)
  }, [note])
  return { note, say: setNote }
}

/** Shared bootstrap: preferences, theme and the language of the main window. */
function useStandalonePrefs(): Prefs | null {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  useEffect(() => {
    let live = true
    void api.state.get().then((state) => {
      if (!live) return
      const merged = mergePrefs({ ...migrateLegacy(state), ...(state?.prefs ?? {}) })
      applyPrefs(merged)
      setPrefs(merged)
    })
    // another window may change a preference while this one is open (font, theme, gallery info)
    const off = api.state.onPrefsPatch((patch) => {
      setPrefs((cur) => {
        const next = mergePrefs({ ...(cur ?? {}), ...patch })
        applyPrefs(next)
        return next
      })
    })
    return () => {
      live = false
      off()
    }
  }, [])
  return prefs
}

const isGalleryImage = (e: Entry): boolean => !e.dir && isImage(e.ext)

/** The image viewer in its own window (double-click an image in thumbnail view). */
export function StandaloneGallery({ path }: { path: string }) {
  const prefs = useStandalonePrefs()
  const [images, setImages] = useState<Entry[] | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [reload, setReload] = useState(0)
  const { note, say } = useNote()

  useEffect(() => {
    if (!prefs) return
    const dir = path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '/'
    let live = true
    void api
      .list(dir, prefs.showHidden)
      .then((l) => {
        if (!live) return
        const pics = l.entries.filter(isGalleryImage)
        // the requested file is always first-class, even if the listing is filtered
        setImages(pics.length ? pics : [])
      })
      .catch(() => live && setImages([]))
    return () => {
      live = false
    }
  }, [path, prefs, reload])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && fullscreen) {
        e.preventDefault()
        setFullscreen(false)
        void api.window.setFullscreen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  if (!prefs) return <div className="boot">{t('در حال باز کردن…')}</div>
  if (!images) return <div className="boot">{t('در حال خواندن…')}</div>
  if (!images.length) return <div className="boot">{t('فایلی در این پوشه نیست')}</div>

  return (
    <>
      <Gallery
        images={images}
        startPath={path}
        fullscreen={fullscreen}
        slideshowSec={prefs.slideshowSec}
        loop={prefs.galleryLoop}
        imageFormat={prefs.imageFormat}
        imageQuality={prefs.imageQuality}
        chrome={{ customTitlebar: prefs.titlebar === 'app' }}
        titlebarButtons={prefs.titlebarButtons}
        titlebarSide={prefs.titlebarSide}
        infoOpen={prefs.galleryInfo}
        onInfoToggle={(open) => void api.state.patchPrefs({ galleryInfo: open })}
        onFullscreen={() => {
          const next = !fullscreen
          setFullscreen(next)
          void api.window.setFullscreen(next)
        }}
        onClose={() => void api.window.close()}
        onSaved={say}
        onChanged={() => setReload((n) => n + 1)}
      />
      {note && (
        <div className="standalone-note" dir="auto">
          {note}
        </div>
      )}
    </>
  )
}

/** The text/markdown editor in its own window (double-click a document in thumbnail view). */
export function StandaloneEditor({ path }: { path: string }) {
  const prefs = useStandalonePrefs()
  const { note, say } = useNote()
  if (!prefs) return <div className="boot">{t('در حال باز کردن…')}</div>
  return (
    <div className="standalone-editor">
      <Editor
        path={path}
        theme={prefs.theme === 'system'
          ? window.matchMedia?.('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : prefs.theme}
        hideClose
        onClose={() => void api.window.close()}
        onNote={say}
        onSaved={() => undefined}
      />
      {/* the editor header has no caption buttons; this window needs them to be closable */}
      {prefs.titlebar === 'app' && (
        <div className="standalone-winbtns">
          <WindowButtons
            theme={prefs.titlebarButtons}
            side={prefs.titlebarSide}
            onClose={() => void api.window.close()}
          />
        </div>
      )}
      {note && (
        <div className="standalone-note" dir="auto">
          {note}
        </div>
      )}
    </div>
  )
}
