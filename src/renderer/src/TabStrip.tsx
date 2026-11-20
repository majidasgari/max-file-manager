import { t } from './i18n.ts'
import { EntryIcon, LockIcon, PinIcon, PlusIcon, XIcon } from './Icons'
import type { PaneState } from './Pane'

type Props = {
  pane: PaneState
  active: boolean
  iconSet?: Record<string, string>
  showTabIcons: boolean
  /** folder path → its own colour/icon for the tab strip */
  tabIcons: Record<string, { color?: string; icon?: string }>
  /** folder path → tab colour chosen in the tab menu */
  tabColors: Record<string, string>
  middleClickClosesTab: boolean
  onTabNew(): void
  onTabClose(idx: number): void
  onTabPick(idx: number): void
  onTabMenu(idx: number, x: number, y: number): void
  onTabMove(from: number, to: number): void
}

/** The pane's tab strip: one file it lives in the pane, vertical it lives in the sidebar. */
export function TabStrip(props: Props) {
  const { pane } = props
  return (
    <div className="tabs">
      {pane.tabs.map((tabPath, i) => {
        const tabId = pane.tabIds?.[i] ?? ('t_' + i)
        const pinned = i < pane.pinCount
        const locked = pane.tabLocks[tabId] === true
        const title = pane.tabNames[tabPath] || tabPath.split(/[\\/]/).filter(Boolean).pop() || tabPath
        const tabColor = props.tabColors[tabPath]
        return (
          <div
            key={tabId}
            className={'tab' + (i === pane.ti ? ' on' : '') + (pinned ? ' pinned' : '')}
            style={
              tabColor && i === pane.ti
                ? { background: `color-mix(in srgb, ${tabColor} 18%, var(--panel))` }
                : undefined
            }
            draggable
            onDragStart={(ev) => {
              ev.dataTransfer.setData('application/x-mfm-tab', String(i))
              ev.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(ev) => {
              if (ev.dataTransfer.types.includes('application/x-mfm-tab')) ev.preventDefault()
            }}
            onDrop={(ev) => {
              const raw = ev.dataTransfer.getData('application/x-mfm-tab')
              if (!raw) return
              ev.preventDefault()
              ev.stopPropagation()
              props.onTabMove(Number(raw), i)
            }}
            onClick={() => props.onTabPick(i)}
            onAuxClick={(ev) => {
              if (ev.button === 1 && props.middleClickClosesTab && !locked) {
                ev.preventDefault()
                props.onTabClose(i)
              }
            }}
            onContextMenu={(ev) => {
              ev.preventDefault()
              ev.stopPropagation()
              props.onTabMenu(i, ev.clientX, ev.clientY)
            }}
            title={tabPath}
          >
            {pinned && <PinIcon filled />}
            {locked && <LockIcon size={11} />}
            {props.showTabIcons && (
              <EntryIcon
                size={14}
                iconSet={props.iconSet}
                entry={{
                  name: tabPath.split(/[\\/]/).filter(Boolean).pop() || tabPath,
                  path: tabPath,
                  dir: true,
                  size: 0,
                  mtime: 0,
                  ext: '',
                  color: props.tabIcons[tabPath]?.color,
                  icon: props.tabIcons[tabPath]?.icon
                }}
              />
            )}
            {tabColor && <span className="tab-dot" style={{ background: tabColor }} />}
            <span className="tab-name" dir="auto">{title}</span>
            {!pinned && !locked && pane.tabs.length > 1 && (
              <button
                className="x"
                title={t(t('بستن تب'))}
                onClick={(e) => {
                  e.stopPropagation()
                  props.onTabClose(i)
                }}
              >
                <XIcon size={11} />
              </button>
            )}
          </div>
        )
      })}
      <button className="tb" title={t(t('تب نو (Ctrl+T)'))} onClick={props.onTabNew}>
        <PlusIcon size={13} />
      </button>
    </div>
  )
}
