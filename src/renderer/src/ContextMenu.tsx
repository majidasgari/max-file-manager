import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { submenuLeft } from './menu-position.ts'

export type MenuItem =
  | { sep: true }
  | { head: true; label: string }
  | {
      id: string
      label: string
      icon?: ReactNode
      key?: string
      danger?: boolean
      disabled?: boolean
      /** a toggle item: a check mark in the icon slot */
      checked?: boolean
      /** a grouped item: hovering (or clicking) opens a nested panel */
      children?: MenuItem[]
      sep?: false
    }

export type MenuAction = {
  id: string
  label: string
  icon: ReactNode
  disabled?: boolean
  danger?: boolean
}

type Props = {
  x: number
  y: number
  items: MenuItem[]
  /** icon-only quick actions pinned under the list (cut/copy/paste/delete) */
  actions?: MenuAction[]
  /** folder-colour dots under the quick actions; click applies the colour ('' clears it) */
  swatches?: { value: string; label: string; active?: boolean }[]
  onSwatch?(value: string): void
  /** one extra circle beside the colours — the folder's icon picker */
  swatchAction?: { title: string; icon: React.ReactNode; onClick(): void }
  onPick(id: string): void
  onClose(): void
}

type SubLevel = {
  key: string
  items: MenuItem[]
  anchor: { left: number; right: number; top: number }
}

function CheckMark() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M5 12.5l4.2 4.2L19 7" />
    </svg>
  )
}

/** Keep a panel inside the content area, below the header and above the window edge. */
function clampPanel(el: HTMLElement, x: number, y: number): void {
  const bodyTop = document.querySelector('.app .body')?.getBoundingClientRect().top ?? 8
  const minTop = Math.max(8, Math.round(bodyTop + 4))
  const maxHeight = Math.max(120, window.innerHeight - minTop - 8)
  el.style.maxHeight = `${maxHeight}px`
  const height = Math.min(el.scrollHeight, maxHeight)
  el.style.top = `${Math.max(minTop, Math.min(y, window.innerHeight - height - 8))}px`
  el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8))}px`
}

function renderMenuRows(
  list: MenuItem[],
  depth: number,
  activeChildKey: string | undefined,
  onOpenSub: (ev: React.MouseEvent, child: MenuItem[], key: string, depth: number) => void,
  onHoverPlain: (depth: number) => void,
  onPick: (id: string) => void,
  onClose: () => void,
  cancelClose: () => void
) {
  const cleaned: MenuItem[] = []
  for (const it of list) {
    if ('sep' in it && it.sep) {
      if (!cleaned.length || ('sep' in cleaned[cleaned.length - 1] && (cleaned[cleaned.length - 1] as any).sep)) {
        continue
      }
    }
    cleaned.push(it)
  }
  while (cleaned.length && 'sep' in cleaned[cleaned.length - 1] && (cleaned[cleaned.length - 1] as any).sep) {
    cleaned.pop()
  }
  return cleaned.map((it, i) => {
    if ('sep' in it && it.sep) return <div key={'s' + i} className="ctx-sep" />
    if ('head' in it && it.head) return <div key={'h' + i} className="ctx-head">{it.label}</div>
    const item = it as Extract<MenuItem, { id: string }>
    const child = item.children
    const isOpen = Boolean(child && activeChildKey === item.id)
    return (
      <button
        key={item.id + i}
        className={
          'ctx-item' +
          (item.danger ? ' danger' : '') +
          (isOpen ? ' is-open' : '')
        }
        disabled={item.disabled}
        onMouseEnter={(ev) => {
          cancelClose()
          if (child) onOpenSub(ev, child, item.id, depth)
          else onHoverPlain(depth)
        }}
        onClick={(ev) => {
          if (child) {
            onOpenSub(ev, child, item.id, depth)
            return
          }
          onPick(item.id)
          onClose()
        }}
      >
        <span className="ctx-icon">{item.checked ? <CheckMark /> : item.icon}</span>
        <span className="ctx-label">{item.label}</span>
        {child ? (
          <span className="ctx-caret" aria-hidden="true">
            {document.documentElement.dir === 'rtl' ? '‹' : '›'}
          </span>
        ) : null}
        {!child && item.key && <span className="ctx-key">{item.key}</span>}
      </button>
    )
  })
}

function SubmenuPanel({
  sub,
  depth,
  activeChildKey,
  onOpenSub,
  onHoverPlain,
  onPick,
  onClose,
  cancelClose,
  scheduleClose
}: {
  sub: SubLevel
  depth: number
  activeChildKey?: string
  onOpenSub(ev: React.MouseEvent, child: MenuItem[], key: string, depth: number): void
  onHoverPlain(depth: number): void
  onPick(id: string): void
  onClose(): void
  cancelClose(): void
  scheduleClose(): void
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    const rtl = document.documentElement.dir === 'rtl'
    const left = submenuLeft(sub.anchor, el.offsetWidth, window.innerWidth, rtl)
    clampPanel(el, left, sub.anchor.top - 4)
  }, [sub])

  return (
    <div
      className="ctx ctx-nested"
      ref={panelRef}
      role="menu"
      style={{
        left: sub.anchor.left,
        top: sub.anchor.top,
        minWidth: 248,
        maxWidth: 'min(440px, 92vw)',
        zIndex: 1000 + depth
      }}
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
    >
      {renderMenuRows(
        sub.items,
        depth,
        activeChildKey,
        onOpenSub,
        onHoverPlain,
        onPick,
        onClose,
        cancelClose
      )}
    </div>
  )
}

export function ContextMenu({
  x,
  y,
  items,
  actions,
  swatches,
  onSwatch,
  swatchAction,
  onPick,
  onClose
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [subs, setSubs] = useState<SubLevel[]>([])
  const closeTimer = useRef<number | null>(null)

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  /** Moving to the nested panel must not close it, so closing waits for a beat. */
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setSubs([]), 160)
  }

  useEffect(() => () => cancelClose(), [])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement
        if (target.closest?.('.ctx')) return
        onClose()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  useLayoutEffect(() => {
    if (ref.current) clampPanel(ref.current, x, y)
  }, [x, y, items.length, actions?.length, swatches?.length])

  const openSub = (ev: React.MouseEvent, child: MenuItem[], key: string, depth: number) => {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
    setSubs((prev) => [
      ...prev.slice(0, depth),
      { key, items: child, anchor: { left: rect.left, right: rect.right, top: rect.top } }
    ])
  }

  const hoverPlain = (depth: number) => {
    setSubs((prev) => prev.slice(0, depth))
  }

  return (
    <div
      className="ctx"
      ref={ref}
      style={{ left: x, top: y, minWidth: 248, maxWidth: 'min(440px, 92vw)', maxHeight: 'calc(100vh - 16px)' }}
      role="menu"
      tabIndex={-1}
      onMouseLeave={scheduleClose}
    >
      {renderMenuRows(
        items,
        0,
        subs[0]?.key,
        openSub,
        hoverPlain,
        onPick,
        onClose,
        cancelClose
      )}
      {actions && actions.length > 0 && (
        <>
          <div className="ctx-sep" />
          <div className="ctx-quick">
            {actions.map((a) => (
              <button
                key={a.id}
                className={'ctx-quick-btn' + (a.danger ? ' danger' : '')}
                title={a.label}
                aria-label={a.label}
                disabled={a.disabled}
                onClick={() => {
                  onPick(a.id)
                  onClose()
                }}
              >
                {a.icon}
              </button>
            ))}
          </div>
        </>
      )}
      {((swatches && swatches.length > 0) || swatchAction) && (
        <div className="ctx-colors">
          {(swatches ?? []).map((s) => (
            <button
              key={s.value || 'none'}
              className={
                'ctx-color' + (s.value ? '' : ' none') + (s.active ? ' on' : '')
              }
              style={s.value ? { background: s.value } : undefined}
              title={s.label}
              aria-label={s.label}
              onClick={() => {
                onSwatch?.(s.value)
                onClose()
              }}
            >
              {s.value ? '' : '×'}
            </button>
          ))}
          {swatchAction && (
            <button
              className="ctx-color action"
              title={swatchAction.title}
              aria-label={swatchAction.title}
              onClick={() => {
                swatchAction.onClick()
                onClose()
              }}
            >
              {swatchAction.icon}
            </button>
          )}
        </div>
      )}
      {subs.map((s, idx) => (
        <SubmenuPanel
          key={s.key + ':' + idx}
          sub={s}
          depth={idx + 1}
          activeChildKey={subs[idx + 1]?.key}
          onOpenSub={openSub}
          onHoverPlain={hoverPlain}
          onPick={onPick}
          onClose={onClose}
          cancelClose={cancelClose}
          scheduleClose={scheduleClose}
        />
      ))}
    </div>
  )
}
