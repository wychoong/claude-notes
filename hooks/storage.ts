import type { EngineInterface } from 'claude-code'

import type { Note } from '../types'

// Notes live outside the plugin, in `~/.claude/plugins/notes/` (under
// CLAUDE_CONFIG_DIR when that is set), so updating or moving the plugin never
// touches them:
//
//   notes/<id>.md      one file per note, its name (without .md) the id
//   trash/<id>.md      deleted notes, with a `trashed:` time, until purged
//   groups.json        groups made by hand, kept while empty
//   settings.json      the pane's settings
//
// A note file:
//
//   ---
//   group: my-project
//   created: 2026-11-11T09:53:58.238Z
//   updated: 2026-11-11T10:12:00.000Z   (only once edited)
//   done: 2026-11-11T11:00:00.000Z      (only while checked off)
//   ---
//   # Heading
//   body, with checklist items stamped ➕ added / ✅ done dates

let rootCache: string | undefined

export async function dataRoot($: EngineInterface) {
  if (rootCache) return rootCache
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')
  rootCache = `${config || `${home ?? ''}/.claude`}/plugins/notes`
  return rootCache
}

/** For tests: forget the folder worked out from the environment. */
export const resetDataRoot = () => {
  rootCache = undefined
}

// ---------- frontmatter ----------

const quote = (value: string) =>
  /^[\w .@/+-]*$/.test(value) && value.trim() === value ? value : JSON.stringify(value)

const unquote = (value: string) => {
  const v = value.trim()
  if (v.startsWith('"')) {
    try {
      return String(JSON.parse(v))
    } catch {
      return v.slice(1, -1)
    }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1)
  return v
}

/** Splits `---` frontmatter (simple `key: value` lines) from the body. */
export const parseFrontmatter = (raw: string) => {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const meta: Record<string, string> = {}
  if (!text.startsWith('---\n')) return { meta, body: text }
  const end = text.indexOf('\n---', 4)
  if (end === -1) return { meta, body: text }
  for (const line of text.slice(4, end).split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) meta[line.slice(0, at).trim()] = unquote(line.slice(at + 1))
  }
  const after = text.indexOf('\n', end + 4)
  return { meta, body: after === -1 ? '' : text.slice(after + 1) }
}

export const parseNote = (id: string, raw: string, fallbackDate: string): Note => {
  const { meta, body } = parseFrontmatter(raw)
  const note: Note = {
    id,
    text: body.replace(/^\n+/, '').replace(/\s+$/, ''),
    at: meta.created || fallbackDate,
  }
  if (meta.group) note.group = meta.group
  if (meta.updated) note.updatedAt = meta.updated
  if (meta.done) {
    note.done = true
    note.doneAt = meta.done
  }
  if (meta.trashed) note.trashedAt = meta.trashed
  if (meta.pinned === 'true') note.pinned = true
  if (meta.order !== undefined && /^\d+$/.test(meta.order)) note.order = Number(meta.order)
  return note
}

export const serializeNote = (note: Note) => {
  const lines = ['---']
  if (note.group) lines.push(`group: ${quote(note.group)}`)
  if (note.pinned) lines.push('pinned: true')
  if (note.order !== undefined) lines.push(`order: ${note.order}`)
  lines.push(`created: ${note.at}`)
  if (note.updatedAt) lines.push(`updated: ${note.updatedAt}`)
  if (note.done) lines.push(`done: ${note.doneAt ?? new Date().toISOString()}`)
  if (note.trashedAt) lines.push(`trashed: ${note.trashedAt}`)
  lines.push('---', '', note.text, '')
  return lines.join('\n')
}

// ---------- checklist dates ----------

// A markdown checklist line: `- [ ] task` or `- [x] task` (`*` works too).
export const TASK = /^(\s*)[-*+] \[( |x|X)\] ?(.*)$/
const ADDED = /\s*➕\s*(\d{4}-\d{2}-\d{2})/
const DONE = /\s*✅\s*(\d{4}-\d{2}-\d{2})/

/** Today as `YYYY-MM-DD`, in local time. */
export const today = () => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The text with every checklist item's ➕ / ✅ date marks taken out. */
export const stripTaskDates = (text: string) =>
  text
    .split('\n')
    .map(line => (TASK.test(line) ? line.replace(ADDED, '').replace(DONE, '') : line))
    .join('\n')

/** A checklist item's words without its date marks, and those dates. */
export const taskMarks = (text: string) => ({
  label: text.replace(ADDED, '').replace(DONE, '').trim(),
  added: ADDED.exec(text)?.[1],
  done: DONE.exec(text)?.[1],
})

/**
 * Stamps every checklist item: ➕ on one that has none, ✅ on a checked one
 * that has none, and no ✅ on an unchecked one. Run on every save, so items
 * typed or ticked by hand in the text get their dates too.
 */
export const stampTasks = (text: string, day = today()) =>
  text
    .split('\n')
    .map(line => {
      const m = TASK.exec(line)
      if (!m) return line
      let out = line.replace(/\s+$/, '')
      if (!ADDED.test(out)) out += ` ➕ ${day}`
      const isChecked = m[2] !== ' '
      if (isChecked && !DONE.test(out)) out += ` ✅ ${day}`
      if (!isChecked) out = out.replace(DONE, '')
      return out
    })
    .join('\n')

export const flipTask = (text: string, line: number) =>
  stampTasks(
    text
      .split('\n')
      .map((l, i) =>
        i === line ? l.replace(/\[( |x|X)\]/, m => (m === '[ ]' ? '[x]' : '[ ]')) : l,
      )
      .join('\n'),
  )

// ---------- ids ----------

/** A file name from the heading, plus a time stamp so two never collide. */
export const newId = (text: string) => {
  const slug = (text.split('\n')[0] ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return `${slug || 'note'}-${Date.now().toString(36)}`
}

// ---------- files ----------

async function readFolder($: EngineInterface, dir: string): Promise<Note[]> {
  if (!(await $.fs.exists(dir))) return []
  const out: Note[] = []
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.md') || entry.name.startsWith('.')) {
      continue
    }
    try {
      const raw = await $.fs.read(`${dir}/${entry.name}`)
      const fallback = new Date(entry.mtimeMs || Date.now()).toISOString()
      out.push(parseNote(entry.name.slice(0, -3), String(raw), fallback))
    } catch {
      // A file that can't be read is left alone and not shown.
    }
  }
  return out
}

export async function loadNotes($: EngineInterface): Promise<Note[]> {
  const list = await readFolder($, `${await dataRoot($)}/notes`)
  return list.sort((a, b) => b.at.localeCompare(a.at))
}

export async function loadTrash($: EngineInterface): Promise<Note[]> {
  const list = await readFolder($, `${await dataRoot($)}/trash`)
  return list.sort((a, b) => (b.trashedAt ?? '').localeCompare(a.trashedAt ?? ''))
}

export async function writeNote($: EngineInterface, note: Note) {
  const { trashedAt: _, ...kept } = note
  await $.fs.write(`${await dataRoot($)}/notes/${note.id}.md`, serializeNote(kept))
}

/** Moves a note into the trash folder, stamped with when. */
export async function trashNote($: EngineInterface, note: Note) {
  const root = await dataRoot($)
  const trashed = { ...note, trashedAt: new Date().toISOString() }
  await $.fs.write(`${root}/trash/${note.id}.md`, serializeNote(trashed))
  await $.process.run(['rm', '-f', `${root}/notes/${note.id}.md`])
  return trashed
}

/** Moves a trashed note back among the notes. */
export async function restoreNote($: EngineInterface, note: Note) {
  const root = await dataRoot($)
  const { trashedAt: _, ...restored } = note
  await $.fs.write(`${root}/notes/${note.id}.md`, serializeNote(restored))
  await $.process.run(['rm', '-f', `${root}/trash/${note.id}.md`])
  return restored
}

/** Deletes a trashed note's file for good. */
export async function purgeNote($: EngineInterface, note: Note) {
  await $.process.run(['rm', '-f', `${await dataRoot($)}/trash/${note.id}.md`])
}

export async function loadGroups($: EngineInterface): Promise<string[]> {
  try {
    const raw = String(await $.fs.read(`${await dataRoot($)}/groups.json`))
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : []
  } catch {
    return []
  }
}

export async function saveGroups($: EngineInterface, list: readonly string[]) {
  await $.fs.write(`${await dataRoot($)}/groups.json`, `${JSON.stringify(list, null, 2)}\n`)
}

// ---------- settings ----------

/** Days before a completed note moves to the trash, and before a trashed one is deleted; 0 is never. */
export type Settings = { autoTrashDays: number; purgeDays: number }
export const DEFAULT_SETTINGS: Settings = { autoTrashDays: 0, purgeDays: 0 }

export async function loadSettings($: EngineInterface): Promise<Settings> {
  try {
    const raw: unknown = JSON.parse(String(await $.fs.read(`${await dataRoot($)}/settings.json`)))
    const obj = (raw ?? {}) as Partial<Record<keyof Settings, unknown>>
    const days = (v: unknown) => (typeof v === 'number' && v >= 0 ? Math.floor(v) : 0)
    return { autoTrashDays: days(obj.autoTrashDays), purgeDays: days(obj.purgeDays) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings($: EngineInterface, settings: Settings) {
  await $.fs.write(`${await dataRoot($)}/settings.json`, `${JSON.stringify(settings, null, 2)}\n`)
}
