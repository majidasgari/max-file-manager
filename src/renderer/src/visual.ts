/**
 * Visual markdown editor — the same Milkdown/Crepe setup the Secure Vault web UI uses: a WYSIWYG
 * surface whose document is markdown, per-block direction decided by node decorations, and code
 * blocks that never flip to RTL.
 */
import { t } from './i18n.ts'
import { Crepe, CrepeFeature } from '@milkdown/crepe'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'
import { $prose, replaceAll } from '@milkdown/utils'
import { resolveMdAsset } from './md-asset.ts'
import { EditorView as CmView } from '@codemirror/view'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'

const RTL_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/
const CONTAINER_NODES = new Set(['blockquote', 'bullet_list', 'ordered_list', 'table'])

/** Each block carries its own dir; code blocks are always LTR. */
const autoDirection = $prose(
  () =>
    new Plugin({
      key: new PluginKey('mfm-auto-direction'),
      props: {
        decorations: (state) => {
          const decorations: Decoration[] = []
          state.doc.descendants((node, pos) => {
            if (node.type.name === 'code_block') {
              decorations.push(Decoration.node(pos, pos + node.nodeSize, { dir: 'ltr' }))
              return
            }
            if (!node.isTextblock && !CONTAINER_NODES.has(node.type.name)) return
            decorations.push(
              Decoration.node(pos, pos + node.nodeSize, {
                dir: RTL_RE.test(node.textContent) ? 'rtl' : 'ltr'
              })
            )
          })
          return DecorationSet.create(state.doc, decorations)
        }
      }
    })
)

/**
 * `docs/screenshot.png` means "next to the markdown file". Crepe's image node view draws its own
 * `<img>` and ignores node decorations, so the rendered element is fixed up instead: the document
 * keeps the relative path and saving writes the file back exactly as it was.
 */
const BLOCKED_SCHEME = /^(?!(?:https?|mfm):|data:image\/)[a-z][a-z0-9+.-]*:/i

function resolveRenderedImages(root: HTMLElement, baseDir: string): () => void {
  const fix = (): void => {
    root.querySelectorAll('img').forEach((img) => {
      const raw = img.dataset.mdmSrc ?? img.getAttribute('src') ?? ''
      if (!img.dataset.mdmSrc) img.dataset.mdmSrc = raw
      // the rendered surface gets the same scheme guard the sanitised preview has
      const want = BLOCKED_SCHEME.test(raw) ? '' : resolveMdAsset(raw, baseDir)
      if (raw && img.getAttribute('src') !== want) img.setAttribute('src', want)
    })
  }
  fix()
  const observer = new MutationObserver(fix)
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
  return () => observer.disconnect()
}

const labels = () => ({
  placeholder: t('بنویس… «/» برای منو'),
  groupText: t('متن'),
  text: t('پاراگراف'),
  h1: t('سرتیتر ۱'),
  h2: t('سرتیتر ۲'),
  h3: t('سرتیتر ۳'),
  h4: t('سرتیتر ۴'),
  h5: t('سرتیتر ۵'),
  h6: t('سرتیتر ۶'),
  quote: t('نقل‌قول'),
  divider: t('خط جداکننده'),
  groupList: t('فهرست'),
  bulletList: t('فهرست نقطه‌ای'),
  orderedList: t('فهرست شماره‌دار'),
  taskList: t('فهرست کار'),
  groupAdvanced: t('پیشرفته'),
  image: t('تصویر'),
  codeBlock: t('بلوک کد'),
  table: t('جدول'),
  math: t('فرمول'),
  upload: t('بارگذاری'),
  confirm: t('تأیید'),
  caption: t('زیرنویس'),
  url: t('نشانی'),
  linkEdit: t('ویرایش پیوند'),
  linkRemove: t('حذف پیوند'),
  linkConfirm: t('تأیید'),
  linkPlaceholder: t('نشانی پیوند…'),
  previewToggle: t('نمایش کد'),
  editCode: t('ویرایش کد'),
  searchLanguage: t('جست‌وجوی زبان…'),
  copyCode: t('رونوشت'),
  noResult: t('چیزی پیدا نشد'),
  bold: t('توپر'),
  italic: t('ایتالیک'),
  strikethrough: t('خط‌خورده'),
  code: t('کد'),
  latex: t('فرمول'),
  link: t('پیوند')
})

const item = (label: string) => (label ? { label } : undefined)

export type VisualEditor = {
  getMarkdown(): string
  setMarkdown(md: string): void
  focus(): void
  destroy(): void
}

export async function createVisualEditor(
  root: HTMLElement,
  value: string,
  onChange: (md: string) => void,
  /** folder of the markdown file, for images written as a relative path */
  baseDir?: string
): Promise<VisualEditor> {
  root.dir = 'rtl'
  root.classList.add('visual-editor')

  // built per editor so the menu follows the language chosen in settings
  const LABELS = labels()

  const crepe = new Crepe({
    root,
    defaultValue: value,
    features: {
      [CrepeFeature.AI]: false,
      [CrepeFeature.TopBar]: false,
      // no KaTeX fonts offline → `$…$` stays plain text
      [CrepeFeature.Latex]: false
    },
    featureConfigs: {
      [CrepeFeature.Placeholder]: { text: LABELS.placeholder },
      [CrepeFeature.BlockEdit]: {
        textGroup: {
          label: LABELS.groupText,
          text: item(LABELS.text),
          h1: item(LABELS.h1),
          h2: item(LABELS.h2),
          h3: item(LABELS.h3),
          h4: item(LABELS.h4),
          h5: item(LABELS.h5),
          h6: item(LABELS.h6),
          quote: item(LABELS.quote),
          divider: item(LABELS.divider)
        },
        listGroup: {
          label: LABELS.groupList,
          bulletList: item(LABELS.bulletList),
          orderedList: item(LABELS.orderedList),
          taskList: item(LABELS.taskList)
        },
        advancedGroup: {
          label: LABELS.groupAdvanced,
          image: item(LABELS.image),
          codeBlock: item(LABELS.codeBlock),
          table: item(LABELS.table),
          math: item(LABELS.math)
        }
      },
      [CrepeFeature.ImageBlock]: {
        blockUploadButton: LABELS.upload,
        inlineUploadButton: LABELS.upload,
        blockConfirmButton: LABELS.confirm,
        inlineConfirmButton: LABELS.confirm,
        blockUploadPlaceholderText: LABELS.url,
        inlineUploadPlaceholderText: LABELS.url,
        blockCaptionPlaceholderText: LABELS.caption
      },
      [CrepeFeature.LinkTooltip]: {
        editButton: LABELS.linkEdit,
        removeButton: LABELS.linkRemove,
        confirmButton: LABELS.linkConfirm,
        inputPlaceholder: LABELS.linkPlaceholder
      },
      [CrepeFeature.CodeMirror]: {
        // line wrapping in the code blocks, otherwise a long line forces the whole pane to scroll
        extensions: [CmView.lineWrapping],
        previewToggleText: (previewOnly: boolean) =>
          previewOnly ? LABELS.editCode : LABELS.previewToggle,
        searchPlaceholder: LABELS.searchLanguage,
        copyText: LABELS.copyCode,
        noResultText: LABELS.noResult
      },
      [CrepeFeature.Toolbar]: {
        boldLabel: LABELS.bold,
        italicLabel: LABELS.italic,
        strikethroughLabel: LABELS.strikethrough,
        codeLabel: LABELS.code,
        latexLabel: LABELS.latex,
        linkLabel: LABELS.link
      }
    }
  })

  crepe.editor.use(autoDirection)

  // registered before create(): a listener added afterwards never fires
  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, markdown, previous) => {
      if (markdown !== previous) onChange(markdown)
    })
  })

  await crepe.create()
  const stopImageFix = baseDir ? resolveRenderedImages(root, baseDir) : null

  return {
    getMarkdown: () => crepe.getMarkdown(),
    setMarkdown: (md: string) => {
      // replaceAll dispatches without history, so the markdown listener stays quiet
      crepe.editor.action(replaceAll(md, true))
    },
    focus: () => root.querySelector<HTMLElement>('.ProseMirror')?.focus(),
    destroy: () => {
      stopImageFix?.()
      root.querySelector('.milkdown')?.remove()
      void crepe.destroy()
    }
  }
}
