/**
 * A program on Windows, by name. Two things hang on it: Windows has no exec bit, so the extension is
 * the only «can this run?» signal, and Explorer drops it from the name of the shortcut it creates —
 * «notepad - Shortcut», not «notepad.exe - Shortcut» — because Windows shows `.exe` everywhere.
 *
 * `.bat`/`.cmd`/`.ps1`/`.msi` are deliberately not here: their shortcut really is a `.lnk`, and its
 * name is the only remaining clue about what it starts.
 *
 * Pure and node-free, so the renderer labels its menu with the same rule the main process writes by.
 */
const PROGRAM_EXTENSIONS = ['.exe', '.com']

export function isProgramName(name: string): boolean {
  const lower = name.toLowerCase()
  return PROGRAM_EXTENSIONS.some((ext) => lower.length > ext.length && lower.endsWith(ext))
}
