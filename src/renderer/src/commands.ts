import { t } from './i18n.ts'
/**
 * One list of commands. The toolbar, the function-key bar and the shortcut editor all read
 * from here, so adding a command means one line and it shows up everywhere.
 */
export type CommandId =
  | 'newItem'
  | 'copy'
  | 'move'
  | 'copyFiles'
  | 'cutFiles'
  | 'paste'
  | 'edit'
  | 'rename'
  | 'batchRename'
  | 'mkdir'
  | 'trash'
  | 'hardDelete'
  | 'size'
  | 'refresh'
  | 'up'
  | 'previewPane'
  | 'music'
  | 'videoWindow'
  | 'gallery'
  | 'flat'
  | 'dupes'
  | 'sync'
  | 'cloud'
  | 'diff'
  | 'undo'
  | 'selectAll'
  | 'filter'
  | 'hidden'
  | 'bookmark'
  | 'newTab'
  | 'closeTab'
  | 'reopenTab'
  | 'nextTab'
  | 'addressBar'
  | 'toggleView'
  | 'toggleLayout'
  | 'terminal'
  | 'reveal'
  | 'checkUpdate'
  | 'indexSizes'
  | 'searchIndex'
  | 'presets'
  | 'saveFormat'
  | 'look'
  | 'properties'
  | 'compress'
  | 'extract'
  | 'prefs'
  | 'remote'
  | 'bookmarkBar'

export type CommandGroup = 'transfer' | 'file' | 'view' | 'tab' | 'window'

export type CommandDef = { id: CommandId; label: string; key: string; group: CommandGroup; /** a shorter label for the ribbon buttons, where 60px is the whole width */ short?: string }

export const COMMANDS: CommandDef[] = [
  { id: 'newItem', label: 'جدید', key: 'Ctrl+N', group: 'file' },
  { id: 'copy', label: 'کپی به مقصد', key: 'F5', group: 'transfer', short: 'کپی' },
  { id: 'copyFiles', label: 'کپی فایل', key: 'Ctrl+C', group: 'file' },
  { id: 'cutFiles', label: 'برش فایل', key: 'Ctrl+X', group: 'file' },
  { id: 'paste', label: 'چسباندن فایل', key: 'Ctrl+V', group: 'file' },
  { id: 'move', label: 'انتقال به مقصد', key: 'F6', group: 'transfer', short: 'انتقال' },
  { id: 'edit', label: 'ویرایش یا گالری', key: 'F4', group: 'file', short: 'ویرایش' },
  { id: 'rename', label: 'تغییر نام', key: 'F2', group: 'file' },
  { id: 'batchRename', label: 'تغییر نام گروهی', key: 'Shift+F2', group: 'file', short: 'تغییر نام گروهی' },
  { id: 'mkdir', label: 'پوشهٔ نو', key: 'F7', group: 'file' },
  { id: 'trash', label: 'به سطل بازیافت', key: 'F8', group: 'file' },
  { id: 'hardDelete', label: 'حذف قطعی', key: 'Shift+Delete', group: 'file', short: 'حذف قطعی' },
  { id: 'size', label: 'محاسبهٔ اندازه', key: 'F9', group: 'file', short: 'اندازه' },
  { id: 'sync', label: 'همگام‌سازی با پنجرهٔ مقابل', key: 'Ctrl+Shift+Y', group: 'transfer', short: 'همگام‌سازی' },
  { id: 'cloud', label: 'ابرها…', key: 'Ctrl+Shift+U', group: 'transfer' },
  { id: 'diff', label: 'مقایسهٔ دو فایل', key: 'Ctrl+Shift+Z', group: 'file' },
  { id: 'undo', label: 'واگرد', key: 'Ctrl+Z', group: 'file' },
  { id: 'selectAll', label: 'انتخاب همه', key: 'Ctrl+A', group: 'file' },
  { id: 'refresh', label: 'تازه‌سازی', key: 'Ctrl+R', group: 'view' },
  { id: 'up', label: 'پوشهٔ بالاتر', key: 'Backspace', group: 'view' },
  { id: 'previewPane', label: 'پیش‌نمایش', key: 'F3', group: 'view', short: 'پیش‌نمایش' },
  { id: 'music', label: 'پخش‌کنندهٔ موسیقی و ویدیو', key: 'Ctrl+M', group: 'view', short: 'موسیقی و ویدیو' },
  { id: 'videoWindow', label: 'پنجرهٔ ویدیو', key: 'Ctrl+Shift+M', group: 'view', short: 'پنجرهٔ ویدیو' },
  { id: 'gallery', label: 'گالری', key: 'Space', group: 'view' },
  { id: 'flat', label: 'فهرست تخت', key: 'Ctrl+Shift+F', group: 'view' },
  { id: 'dupes', label: 'فایل‌های تکراری', key: 'Ctrl+Shift+D', group: 'view' },
  { id: 'compress', label: 'فشرده‌سازی…', key: '', group: 'file', short: 'فشرده‌سازی' },
  { id: 'extract', label: 'استخراج آرشیو…', key: '', group: 'file', short: 'استخراج' },
  { id: 'filter', label: 'فیلتر نام', key: 'Ctrl+F', group: 'view' },
  { id: 'hidden', label: 'فایل‌های مخفی', key: 'Ctrl+H', group: 'view' },
  { id: 'bookmark', label: 'نشان‌کردن', key: 'Ctrl+D', group: 'view' },
  { id: 'toggleView', label: 'تعویض نما', key: 'Ctrl+Shift+V', group: 'view' },
  { id: 'toggleLayout', label: 'یک/دو پنجره', key: 'Ctrl+Shift+L', group: 'window' },
  { id: 'newTab', label: 'تب نو', key: 'Ctrl+T', group: 'tab' },
  { id: 'closeTab', label: 'بستن تب', key: 'Ctrl+W', group: 'tab' },
  { id: 'reopenTab', label: 'تب بسته‌شده', key: 'Ctrl+Shift+T', group: 'tab' },
  { id: 'nextTab', label: 'تب بعدی', key: 'Ctrl+Tab', group: 'tab' },
  { id: 'addressBar', label: 'نوار آدرس', key: 'Ctrl+L', group: 'window' },
  { id: 'terminal', label: 'ترمینال اینجا', key: 'Ctrl+Alt+T', group: 'window', short: 'ترمینال' },
  { id: 'reveal', label: 'نمایش در فایل‌منیجر سیستم', key: '', group: 'window', short: 'در سیستم' },
  { id: 'checkUpdate', label: 'بررسی به‌روزرسانی', key: '', group: 'window', short: 'به‌روزرسانی' },
  { id: 'indexSizes', label: 'اندازه از ایندکس (سریع)', key: '', group: 'file', short: 'اندازهٔ ایندکس' },
  { id: 'searchIndex', label: 'جست‌وجوی گلوبال', key: 'Ctrl+K', group: 'view', short: 'جست‌وجو' },
  { id: 'presets', label: 'چیدمان‌ها و فیلترها', key: 'Ctrl+Shift+P', group: 'window' },
  { id: 'saveFormat', label: 'قالب نمایش این پوشه', key: '', group: 'view' },
  { id: 'look', label: 'آیکون پوشه', key: '', group: 'view' },
  { id: 'properties', label: 'ویژگی‌ها', key: 'Alt+Enter', group: 'file' },
  { id: 'prefs', label: 'تنظیمات', key: 'Ctrl+,', group: 'window' },
  { id: 'remote', label: 'اتصال‌های دور', key: '', group: 'window' },
  { id: 'bookmarkBar', label: 'نوار نشان‌ها', key: 'Ctrl+Shift+B', group: 'view' }
]

export const GROUP_ORDER: CommandGroup[] = ['transfer', 'file', 'view', 'tab', 'window']

export const groupLabelOf = (g: CommandGroup): string => t(GROUP_LABEL[g])

export const labelOf = (c: { label: string } | undefined): string => (c ? t(c.label) : '')

export const COMMAND_BY_ID: Record<string, CommandDef> = Object.fromEntries(
  COMMANDS.map((c) => [c.id, c])
)

export const DEFAULT_SHORTCUTS: Record<string, string> = Object.fromEntries(
  COMMANDS.map((c) => [c.id, c.key])
)

export const GROUP_LABEL: Record<CommandGroup, string> = {
  transfer: 'انتقال',
  file: 'فایل',
  view: 'نمایش',
  tab: 'تب',
  window: 'پنجره'
}
