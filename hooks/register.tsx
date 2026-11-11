import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Note } from '../types'
import {
  DEFAULT_SETTINGS,
  TASK,
  flipTask,
  loadGroups,
  loadNotes,
  loadSettings,
  loadTrash,
  newId,
  purgeNote,
  restoreNote,
  saveGroups,
  saveSettings,
  stampTasks,
  stripTaskDates,
  taskMarks,
  trashNote,
  writeNote,
} from './storage'
import type { Settings } from './storage'

const PANE = 'notes'
// Where versions before the markdown files kept notes; read once to move them.
const OLD_STORE_KEY = 'notes'
const OLD_GROUPS_KEY = 'groups'
const MIGRATED_KEY = 'migrated-to-md'
const FALLBACK_GROUP = 'General'
const NEW_GROUP = '__notes_new_group__'
const SHOW_ALL = '__notes_show_all__'
const SHOW_SUMMARY = '__notes_show_summary__'

const notes = atom({ plugin: 'notes', key: 'list' } as const, [], {
  shape: 'notes-2',
})
const groups = atom({ plugin: 'notes', key: 'groups' } as const, [], {
  shape: 'groups-1',
})
const project = atom({ plugin: 'notes', key: 'project' } as const, null)
const current = atom({ plugin: 'notes', key: 'current' } as const, null)
const filter = atom({ plugin: 'notes', key: 'filter' } as const, [])
const isCreating = atom({ plugin: 'notes', key: 'isCreating' } as const, false)
// Ids of the notes whose cards are open, showing the whole body.
const expanded = atom({ plugin: 'notes', key: 'expanded' } as const, [])
const trash = atom({ plugin: 'notes', key: 'trash' } as const, [], { shape: 'trash-1' })
const view = atom({ plugin: 'notes', key: 'view' } as const, 'notes')
const settings = atom({ plugin: 'notes', key: 'settings' } as const, DEFAULT_SETTINGS)
// The id of the note being edited in place, or null.
const editing = atom({ plugin: 'notes', key: 'editing' } as const, null)

const when = (iso: string) => {
  const d = new Date(iso)
  const now = new Date()
  const time = d.toTimeString().slice(0, 5)
  return d.toDateString() === now.toDateString()
    ? time
    : `${d.toLocaleDateString('en', { month: 'short', day: 'numeric' })} ${time}`
}

const day = (ymd: string) => {
  const [y = 0, m = 1, d = 1] = ymd.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toDateString() === new Date().toDateString()
    ? 'today'
    : date.toLocaleDateString('en', { month: 'short', day: 'numeric' })
}

// Markdown marks dropped for one-line display: heading hashes, bold and
// italics, inline code, quotes; checklist and list items get a glyph.
const plain = (line: string) =>
  line
    .trim()
    .replace(TASK, (_m, _i, mark: string, rest: string) =>
      `${mark === ' ' ? '☐' : '☑'} ${taskMarks(rest).label}`,
    )
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^[-*+]\s+/, '• ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')

// First line is the heading; the rest is the body, shown whole as markdown
// when the card is open and as a one-line preview when it is closed.
const split = (text: string) => {
  const [first = '', ...rest] = text.split('\n')
  const tasks = rest.map(line => TASK.exec(line)).filter(m => m !== null)
  return {
    heading: plain(first),
    content: rest.map(plain).filter(Boolean).join('  '),
    hasBody: rest.some(line => line.trim() !== ''),
    taskCount: tasks.length,
    taskDone: tasks.filter(m => m[2] !== ' ').length,
  }
}

// The body cut into runs: plain markdown, or one checklist item with the
// index of its line in the whole text (so a press can flip that line).
type Block =
  | { kind: 'md'; text: string }
  | { kind: 'task'; line: number; isChecked: boolean; text: string; indent: number }

const blocks = (text: string): Block[] => {
  const out: Block[] = []
  let md: string[] = []
  const flush = () => {
    const joined = md.join('\n').trim()
    if (joined) out.push({ kind: 'md', text: joined })
    md = []
  }
  text.split('\n').forEach((line, i) => {
    if (i === 0) return
    const m = TASK.exec(line)
    if (!m) {
      md.push(line)
      return
    }
    flush()
    out.push({
      kind: 'task',
      line: i,
      isChecked: m[2] !== ' ',
      text: m[3] ?? '',
      indent: Math.floor((m[1] ?? '').replace(/\t/g, '  ').length / 2),
    })
  })
  flush()
  return out
}

const stamps = (note: Note, taskDone: number, taskCount: number) =>
  [
    taskCount > 0 && `${taskDone}/${taskCount} ✓`,
    // One time for the text: the last edit, else when it was written.
    `Updated ${when(note.updatedAt ?? note.at)}`,
    note.done && note.doneAt && `Done ${when(note.doneAt)}`,
  ]
    .filter(Boolean)
    .join(' · ')

const groupOf = (note: Note) => note.group ?? FALLBACK_GROUP

const basename = (path: string) =>
  path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || FALLBACK_GROUP

// The group new notes go to: the one picked this session, else the project's.
const currentGroup = async ($: EngineInterface) =>
  (await read($, current)) ?? (await read($, project)) ?? FALLBACK_GROUP

// Writes one note's file, then puts it in the list the pane draws.
const putNote = async ($: EngineInterface, note: Note) => {
  await writeNote($, note)
  await update($, notes, l =>
    l.some(n => n.id === note.id) ? l.map(n => (n.id === note.id ? note : n)) : [note, ...l],
  )
}

const patchNote = async ($: EngineInterface, id: string, fn: (n: Note) => Note) => {
  const note = (await read($, notes)).find(n => n.id === id)
  if (note) await putNote($, fn(note))
}

// Moves the notes' files to the trash folder and drops them from the list.
const dropNotes = async ($: EngineInterface, ids: readonly string[]) => {
  const moved: Note[] = []
  for (const note of (await read($, notes)).filter(n => ids.includes(n.id))) {
    moved.push(await trashNote($, note))
  }
  await update($, notes, l => l.filter(n => !ids.includes(n.id)))
  await update($, trash, l => [...moved, ...l.filter(n => !ids.includes(n.id))])
}

const restoreNotes = async ($: EngineInterface, ids: readonly string[]) => {
  const back: Note[] = []
  for (const note of (await read($, trash)).filter(n => ids.includes(n.id))) {
    back.push(await restoreNote($, note))
  }
  await update($, trash, l => l.filter(n => !ids.includes(n.id)))
  await update($, notes, l =>
    [...back, ...l.filter(n => !ids.includes(n.id))].sort((a, b) => b.at.localeCompare(a.at)),
  )
}

// Deletes trashed notes' files for good.
const purgeNotes = async ($: EngineInterface, ids: readonly string[]) => {
  for (const note of (await read($, trash)).filter(n => ids.includes(n.id))) {
    await purgeNote($, note)
  }
  await update($, trash, l => l.filter(n => !ids.includes(n.id)))
}

const DAY_MS = 24 * 60 * 60 * 1000
const isOlderThan = (iso: string | undefined, days: number) =>
  days > 0 && iso !== undefined && Date.now() - new Date(iso).getTime() >= days * DAY_MS

// What the settings ask for: completed notes to the trash after so many
// days, trashed notes deleted after so many. Runs at each reload.
const cleanUp = async ($: EngineInterface) => {
  const { autoTrashDays, purgeDays } = await read($, settings)
  const stale = (await read($, notes)).filter(n => n.done && isOlderThan(n.doneAt, autoTrashDays))
  if (stale.length > 0) await dropNotes($, stale.map(n => n.id))
  const old = (await read($, trash)).filter(n => isOlderThan(n.trashedAt, purgeDays))
  if (old.length > 0) await purgeNotes($, old.map(n => n.id))
}

const reload = async ($: EngineInterface) => {
  const [list, made, trashed, prefs] = await Promise.all([
    loadNotes($),
    loadGroups($),
    loadTrash($),
    loadSettings($),
  ])
  await update($, notes, () => list)
  await update($, groups, () => made)
  await update($, trash, () => trashed)
  await update($, settings, () => prefs)
  await cleanUp($)
}

const changeSettings = async ($: EngineInterface, change: Partial<Settings>) => {
  await update($, settings, s => ({ ...s, ...change }))
  await saveSettings($, await read($, settings))
  await cleanUp($)
}

const addGroup = async ($: EngineInterface, name: string) => {
  await update($, groups, l => (l.includes(name) ? l : [...l, name]))
  await saveGroups($, await read($, groups))
}

const addNote = async ($: EngineInterface, raw: string) => {
  const text = stampTasks(raw)
  const group = await currentGroup($)
  await putNote($, { id: newId(text), text, at: new Date().toISOString(), group })
}

// Notes kept by the version before the markdown files move into them once.
const migrate = async ($: EngineInterface) => {
  if (await $.store.get(MIGRATED_KEY)) return
  const old = await $.store.get(OLD_STORE_KEY)
  for (const n of Array.isArray(old) ? (old as Note[]) : []) {
    await writeNote($, { ...n, id: newId(n.text), text: stampTasks(n.text) })
  }
  const oldGroups = await $.store.get(OLD_GROUPS_KEY)
  if (Array.isArray(oldGroups) && oldGroups.length > 0) {
    await saveGroups($, [...new Set([...(await loadGroups($)), ...(oldGroups as string[])])])
  }
  await $.store.set(MIGRATED_KEY, true)
}

// Puts a note's text into the message box at the cursor. Where the surface
// can't take a draft, copies it instead so the person can paste it.
const sendToChat = async ($: EngineInterface, note: Note, surface: RenderSurface) => {
  const text = stripTaskDates(note.text)
  const filled = await $.prompt.fill({ text: `${text}\n`, mode: 'insert' })
  if (filled.isFilled) {
    $.ui.toast('Added to your message')
    return
  }
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? 'Copied: paste it into the message box' : "Couldn't add the note to the chat")
}

// Adds what the person highlighted in the chat; false when nothing is.
const addSelection = async ($: EngineInterface) => {
  const text = (await $.ui.selection())?.text.trim()
  if (!text) return false
  await addNote($, text)
  return true
}

type RenderInput = Parameters<EngineInterface['ui']['resolve']>[0]

const dayOptions = (days: readonly number[]) => [
  { value: '0', label: 'Never' },
  ...days.map(d => ({ value: String(d), label: d === 1 ? 'After 1 day' : `After ${d} days` })),
]

const backRow = ($: EngineInterface, e: RenderInput, title: string) => {
  const { Box, Text, Button } = $.ui.resolve(e)
  return (
    <Box flexDirection="row" gap="sm" alignItems="center">
      <Button
        key="back"
        label="← Back"
        plain
        dimColor
        onPress={() => void update($, view, () => 'notes')}
      />
      <Text weight="semibold">{title}</Text>
    </Box>
  )
}

// The trash: each deleted note, to restore or delete for good.
const trashScreen = ($: EngineInterface, e: RenderInput, list: readonly Note[]) => {
  const { Box, Text, Button } = $.ui.resolve(e)
  return (
    <Box flexDirection="column" gap="sm" paddingTop="sm">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        {backRow($, e, `Trash · ${list.length}`)}
        {list.length > 0 && (
          <Button
            key="empty-trash"
            label="Empty trash"
            plain
            dimColor
            onPress={() => void purgeNotes($, list.map(n => n.id))}
          />
        )}
      </Box>
      {list.length === 0 && <Text dimColor>The trash is empty.</Text>}
      {list.map(note => (
        <Box
          key={`trash-${note.id}`}
          flexDirection="row"
          alignItems="center"
          gap="sm"
          paddingX="sm"
          paddingY="xs"
          borderStyle="round"
          borderDimColor
          overflow="hidden"
        >
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Text weight="semibold" wrap="truncate-end">
              {split(note.text).heading || '(empty)'}
            </Text>
            <Text size="caption" dimColor wrap="truncate-end">
              {groupOf(note)}
              {note.trashedAt ? ` · deleted ${when(note.trashedAt)}` : ''}
            </Text>
          </Box>
          <Box flexShrink={0} flexDirection="row" gap="sm">
            <Button
              key={`restore-${note.id}`}
              label="Restore"
              onPress={() => void restoreNotes($, [note.id])}
            />
            <Button
              key={`purge-${note.id}`}
              label="Delete forever"
              plain
              dimColor
              onPress={() => void purgeNotes($, [note.id])}
            />
          </Box>
        </Box>
      ))}
    </Box>
  )
}

const settingsScreen = ($: EngineInterface, e: RenderInput, prefs: Settings) => {
  const { Box, Text, Select } = $.ui.resolve(e)
  return (
    <Box flexDirection="column" gap="md" paddingTop="sm">
      {backRow($, e, 'Settings')}
      <Box flexDirection="column" gap="xs">
        <Text>Move completed notes to the trash</Text>
        <Select
          key="auto-trash"
          options={dayOptions([1, 3, 7, 14, 30])}
          value={String(prefs.autoTrashDays)}
          onSelect={v => void changeSettings($, { autoTrashDays: Number(v) })}
        />
        <Text size="caption" dimColor>
          Counted from when the note was checked off.
        </Text>
      </Box>
      <Box flexDirection="column" gap="xs">
        <Text>Delete trashed notes for good</Text>
        <Select
          key="purge"
          options={dayOptions([7, 30, 90])}
          value={String(prefs.purgeDays)}
          onSelect={v => void changeSettings($, { purgeDays: Number(v) })}
        />
        <Text size="caption" dimColor>
          Counted from when the note went to the trash. This can't be undone.
        </Text>
      </Box>
      <Text size="caption" dimColor>
        Applied when the pane loads, on ↻, and when you change a setting.
      </Text>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await migrate($)
    await reload($)
    const folder = basename(await $.session.cwd())
    await update($, project, () => folder)
    await $.command.register({
      name: 'notes',
      description: 'Open the notes pane',
    })
    await $.command.register({
      name: 'note-this',
      description: 'Save the highlighted chat text (or the text you type) as a note',
    })
    void $.ui.open({ id: PANE, title: 'Notes' })

    return next(e)
  })

  on('command.run', { command: 'notes' }, async $ => {
    await reload($)
    await $.ui.open({ id: PANE, title: 'Notes' })

    return {}
  })

  on('command.run', { command: 'note-this' }, async ($, e) => {
    const typed = e.args.trim()
    const isAdded = typed ? (await addNote($, typed), true) : await addSelection($)
    if (isAdded) {
      $.ui.toast(`Saved to notes · ${await currentGroup($)}`)
      await $.ui.open({ id: PANE, title: 'Notes' })
    } else {
      $.ui.toast('Highlight some chat text first, or type /note-this <text>')
    }

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Select, Markdown } = $.ui.resolve(e)
    const list = await read($, notes)
    const editingId = await read($, editing)
    const openIds = await read($, expanded)
    const made = await read($, groups)
    const shown = await read($, filter)
    const creating = await read($, isCreating)
    const screen = await read($, view)
    if (screen === 'trash') return trashScreen($, e, await read($, trash))
    if (screen === 'settings') return settingsScreen($, e, await read($, settings))
    const trashCount = (await read($, trash)).length
    const projectName = (await read($, project)) ?? FALLBACK_GROUP
    const target = await currentGroup($)

    // Every group: the project's, the picked one, those made by hand, then
    // any a note names; first seen wins the order.
    const allGroups = [
      ...new Set([projectName, target, ...made, ...list.map(groupOf)]),
    ]
    const groupOptions = allGroups.map(g => ({ value: g, label: g }))

    const patch = (id: string, fn: (n: Note) => Note) => patchNote($, id, fn)

    const editor = (note: Note) => (
      <Box key={`row-${note.id}`} flexDirection="column" gap="xs">
        <Input
          key={`edit-${note.id}`}
          value={note.text}
          rows={4}
          autoFocus
          submitLabel="save"
          onSubmit={value => {
            const text = stampTasks(value.trim())
            void (async () => {
              if (text && text !== note.text) {
                await patch(note.id, n => ({
                  ...n,
                  text,
                  updatedAt: new Date().toISOString(),
                }))
              }
              await update($, editing, () => null)
            })()
          }}
        />
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Select
            key={`move-${note.id}`}
            label="Group"
            options={groupOptions}
            value={groupOf(note)}
            onSelect={group => void patch(note.id, n => ({ ...n, group }))}
          />
          <Button
            key={`cancel-${note.id}`}
            label="Done"
            plain
            dimColor
            onPress={() => void update($, editing, () => null)}
          />
        </Box>
      </Box>
    )

    const row = (note: Note) => {
      if (note.id === editingId) return editor(note)
      const { heading, content, hasBody, taskCount, taskDone } = split(note.text)
      const isOpen = hasBody && openIds.includes(note.id)

      return (
        <Box
          key={`row-${note.id}`}
          flexDirection="row"
          alignItems="flex-start"
          gap="sm"
          paddingX="sm"
          paddingY="xs"
          borderStyle="round"
          borderDimColor
          hover={{ borderDimColor: false }}
          overflow="hidden"
        >
          <Button
            key={`chk-${note.id}`}
            label={note.done ? '☑' : '☐'}
            plain
            dimColor={note.done}
            onPress={() =>
              void patch(note.id, n =>
                n.done
                  ? { ...n, done: false, doneAt: undefined }
                  : { ...n, done: true, doneAt: new Date().toISOString() },
              )
            }
          />
          <Box
            flexDirection="column"
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            overflow="hidden"
          >
            <Box flexDirection="row" gap="sm" alignItems="center" minWidth={0}>
              {hasBody && (
                <Box flexShrink={0}>
                  <Button
                    key={`open-${note.id}`}
                    label={isOpen ? '▼\uFE0E' : '▶\uFE0E'}
                    plain
                    onPress={() =>
                      void update($, expanded, l =>
                        l.includes(note.id) ? l.filter(x => x !== note.id) : [...l, note.id],
                      )
                    }
                  />
                </Box>
              )}
              <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                <Text
                  weight="semibold"
                  wrap="truncate-end"
                  strikethrough={note.done}
                  dimColor={note.done}
                >
                  {heading}
                </Text>
              </Box>
              {/* Revealed while the card is hovered; the terminal has no
                  pointer, so it always shows there. */}
              <Box
                flexShrink={0}
                display={e.surface === 'terminal' ? 'flex' : 'none'}
                hover={e.surface === 'terminal' ? undefined : { display: 'flex' }}
              >
                <Button
                  key={`del-${note.id}`}
                  label="✕"
                  plain
                  dimColor
                  onPress={() => void dropNotes($, [note.id])}
                />
              </Box>
              {/* On hover too, like ✕. */}
              <Box
                flexShrink={0}
                display={e.surface === 'terminal' ? 'flex' : 'none'}
                hover={e.surface === 'terminal' ? undefined : { display: 'flex' }}
              >
                <Button
                  key={`chat-${note.id}`}
                  label="💬"
                  plain
                  dimColor
                  onPress={press => void sendToChat($, note, press.surface)}
                />
              </Box>
              {/* Pin: open notes only. Shown while pinned; else on hover
                  (always in the terminal, which has no pointer). */}
              {!note.done && (
                <Box
                  flexShrink={0}
                  display={note.pinned || e.surface === 'terminal' ? 'flex' : 'none'}
                  hover={note.pinned || e.surface === 'terminal' ? undefined : { display: 'flex' }}
                >
                  <Button
                    key={`pin-${note.id}`}
                    label="📌"
                    plain
                    dimColor={!note.pinned}
                    onPress={() => void patch(note.id, n => ({ ...n, pinned: !n.pinned }))}
                  />
                </Box>
              )}
              <Box flexShrink={0}>
                <Button
                  key={`edit-btn-${note.id}`}
                  label="✏️"
                  plain
                  dimColor
                  onPress={() => void update($, editing, () => note.id)}
                />
              </Box>
            </Box>
            {isOpen && (
              <Box flexDirection="column" gap="xs" marginY="xs" minWidth={0}>
                {blocks(note.text).map((b, i) =>
                  b.kind === 'md' ? (
                    <Markdown key={`md-${note.id}-${i}`} text={b.text} dimColor={note.done} />
                  ) : (
                    <Box
                      key={`task-${note.id}-${b.line}`}
                      flexDirection="row"
                      gap="xs"
                      alignItems="flex-start"
                      paddingLeft={b.indent * 2}
                      minWidth={0}
                    >
                      <Button
                        key={`task-chk-${note.id}-${b.line}`}
                        label={b.isChecked ? '☑' : '☐'}
                        plain
                        dimColor={b.isChecked}
                        onPress={() =>
                          void patch(note.id, n => ({
                            ...n,
                            text: flipTask(n.text, b.line),
                            updatedAt: new Date().toISOString(),
                          }))
                        }
                      />
                      <Box flexGrow={1} flexShrink={1} minWidth={0}>
                        <Text strikethrough={b.isChecked} dimColor={b.isChecked}>
                          {plain(taskMarks(b.text).label)}
                        </Text>
                      </Box>
                      {(() => {
                        const { added, done } = taskMarks(b.text)
                        const label = b.isChecked && done ? `✅ ${day(done)}` : added ? `➕ ${day(added)}` : ''
                        return label === '' ? null : (
                          <Box flexShrink={0}>
                            <Text size="caption" dimColor>
                              {label}
                            </Text>
                          </Box>
                        )
                      })()}
                    </Box>
                  ),
                )}
              </Box>
            )}
            {!isOpen && content !== '' && (
              <Box minWidth={0} overflow="hidden">
                <Text size="footnote" dimColor wrap="truncate-end">
                  {content}
                </Text>
              </Box>
            )}
            <Text size="caption" dimColor wrap="truncate-end">
              {stamps(note, taskDone, taskCount)}
            </Text>
          </Box>
        </Box>
      )
    }

    // Sections: all groups that hold notes, or exactly the ones picked.
    const isAll = shown.length === 0
    const sections = (isAll ? allGroups : allGroups.filter(g => shown.includes(g)))
      .map(g => {
        const items = list.filter(n => groupOf(n) === g)
        // Pinned notes first among the open ones; the sort keeps the rest in order.
        const open = items.filter(n => !n.done).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
        return { group: g, open, done: items.filter(n => n.done) }
      })
      .filter(s => !isAll || s.open.length + s.done.length > 0)

    const toggleShown = (g: string) =>
      update($, filter, l => (l.includes(g) ? l.filter(x => x !== g) : [...l, g]))

    // One dropdown for the filter: picking a group ticks it on or off, so
    // several can be shown; "All groups" clears the ticks. While some are
    // ticked, a first option names them and stands as the dropdown's value.
    const showOptions = [
      ...(isAll ? [] : [{ value: SHOW_SUMMARY, label: shown.join(', ') }]),
      { value: SHOW_ALL, label: isAll ? '✓ All groups' : 'All groups' },
      ...allGroups.map(g => ({
        value: g,
        label: `${shown.includes(g) ? '✓' : '   '} ${g}`,
      })),
    ]

    return (
      <Box flexDirection="column" gap="sm" paddingTop="sm">
        {creating ? (
          <Box flexDirection="column" gap="xs">
            <Input
              key="new-group"
              placeholder="New group name"
              submitLabel="create"
              autoFocus
              onSubmit={value => {
                const name = value.trim()
                void (async () => {
                  if (name) {
                    await addGroup($, name)
                    await update($, current, () => name)
                  }
                  await update($, isCreating, () => false)
                })()
              }}
            />
            <Box flexDirection="row" justifyContent="flex-end">
              <Button
                key="cancel-group"
                label="Cancel"
                plain
                dimColor
                onPress={() => void update($, isCreating, () => false)}
              />
            </Box>
          </Box>
        ) : (
          <Select
            key="current-group"
            label="Add to"
            options={[...groupOptions, { value: NEW_GROUP, label: '＋ New group…' }]}
            value={target}
            onSelect={value => {
              if (value === NEW_GROUP) void update($, isCreating, () => true)
              else void update($, current, () => value)
            }}
          />
        )}
        <Input
          key={`new-${list.length}`}
          placeholder={'Heading on the first line\nDetails below, Enter to save'}
          submitLabel="save"
          rows={4}
          autoFocus={editingId === null && !creating ? true : undefined}
          onSubmit={value => {
            const text = value.trim()
            if (!text) return
            void addNote($, text)
          }}
        />
        <Box flexDirection="row" justifyContent="flex-end">
          <Button
            key="add-selection"
            label="＋ Add highlighted chat text"
            plain
            dimColor
            onPress={() =>
              void addSelection($).then(isAdded => {
                if (!isAdded) $.ui.toast('Highlight some chat text first')
              })
            }
          />
        </Box>

        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Select
            key="show"
            label="Show"
            options={showOptions}
            value={isAll ? SHOW_ALL : SHOW_SUMMARY}
            onSelect={value => {
              if (value === SHOW_ALL) void update($, filter, () => [])
              else if (value !== SHOW_SUMMARY) void toggleShown(value)
            }}
          />
          <Button
            key="refresh"
            label="↻"
            plain
            dimColor
            onPress={() => void reload($)}
          />
        </Box>

        {sections.length === 0 && <Text dimColor>Nothing yet.</Text>}
        {sections.map(s => (
          <Box key={`group-${s.group}`} flexDirection="column" gap="xs" marginTop="sm">
            <Text size="caption" weight="semibold" dimColor>
              {s.group.toUpperCase()} · {s.open.length}
            </Text>
            {s.open.length === 0 && (
              <Text size="footnote" dimColor>
                Nothing open.
              </Text>
            )}
            {s.open.map(row)}
            {s.done.length > 0 && (
              <Box
                flexDirection="row"
                justifyContent="space-between"
                alignItems="center"
                marginTop="xs"
              >
                <Text size="caption" dimColor>
                  Completed · {s.done.length}
                </Text>
                <Button
                  key={`clear-${s.group}`}
                  label="Clear"
                  plain
                  dimColor
                  onPress={() => {
                    void dropNotes($, s.done.map(n => n.id))
                  }}
                />
              </Box>
            )}
            {s.done.map(row)}
          </Box>
        ))}
        <Box flexDirection="row" justifyContent="space-between" marginTop="md">
          <Button
            key="open-trash"
            label={`🗑 Trash · ${trashCount}`}
            plain
            dimColor
            onPress={() => void update($, view, () => 'trash')}
          />
          <Button
            key="open-settings"
            label="⚙ Settings"
            plain
            dimColor
            onPress={() => void update($, view, () => 'settings')}
          />
        </Box>
      </Box>
    )
  })
}
