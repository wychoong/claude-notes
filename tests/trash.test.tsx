import { expect, test } from 'claude-code/testing'

import { PANE, engine } from './harness'

const ROOT = '/home/me/.claude/plugins/notes'
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

test('a deleted note can be restored from the trash', async ($, on) => {
  const { files } = engine(on, '/p/demo')
  files.set(`${ROOT}/notes/keep-me-1.md`, `---\ngroup: demo\ncreated: ${daysAgo(1)}\n---\n\n# Keep me\n`)

  await $.session.start({ cwd: '/p/demo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'del-keep-me-1' })
  expect(files.has(`${ROOT}/notes/keep-me-1.md`)).toBe(false)
  expect(files.get(`${ROOT}/trash/keep-me-1.md`)).toMatch(/\ntrashed: \S+\n/)
  expect((await ui.find({ type: 'Button', text: /Trash · 1/ }))).toBeDefined()

  await ui.press({ key: 'open-trash' })
  expect(await ui.find({ type: 'Text', text: 'Keep me' })).toBeDefined()
  await ui.press({ key: 'restore-keep-me-1' })
  expect(files.has(`${ROOT}/trash/keep-me-1.md`)).toBe(false)
  expect(files.get(`${ROOT}/notes/keep-me-1.md`)).not.toContain('trashed:')

  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: 'Keep me' })).toBeDefined()
  await ui.unmount()
})

test('settings move old completed notes to the trash and purge old trash', async ($, on) => {
  const { files } = engine(on, '/p/demo')
  const note = (group: string, extra: string, title: string) =>
    `---\ngroup: ${group}\ncreated: ${daysAgo(40)}\n${extra}---\n\n# ${title}\n`
  files.set(`${ROOT}/notes/old-done.md`, note('demo', `done: ${daysAgo(10)}\n`, 'Old done'))
  files.set(`${ROOT}/notes/new-done.md`, note('demo', `done: ${daysAgo(1)}\n`, 'New done'))
  files.set(`${ROOT}/notes/open.md`, note('demo', '', 'Still open'))
  files.set(`${ROOT}/trash/ancient.md`, note('demo', `trashed: ${daysAgo(100)}\n`, 'Ancient'))
  files.set(`${ROOT}/trash/recent.md`, note('demo', `trashed: ${daysAgo(2)}\n`, 'Recent'))

  await $.session.start({ cwd: '/p/demo', surface: 'desktop', isInteractive: true })
  // Defaults are "Never": nothing moves.
  expect(files.has(`${ROOT}/notes/old-done.md`)).toBe(true)
  expect(files.has(`${ROOT}/trash/ancient.md`)).toBe(true)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-settings' })
  await ui.select({ key: 'auto-trash', value: '7' })
  expect(files.has(`${ROOT}/notes/old-done.md`)).toBe(false)
  expect(files.has(`${ROOT}/trash/old-done.md`)).toBe(true)
  expect(files.has(`${ROOT}/notes/new-done.md`)).toBe(true)
  expect(files.has(`${ROOT}/notes/open.md`)).toBe(true)

  await ui.select({ key: 'purge', value: '30' })
  expect(files.has(`${ROOT}/trash/ancient.md`)).toBe(false)
  expect(files.has(`${ROOT}/trash/recent.md`)).toBe(true)
  expect(files.has(`${ROOT}/trash/old-done.md`)).toBe(true)
  expect(JSON.parse(files.get(`${ROOT}/settings.json`)!)).toEqual({ autoTrashDays: 7, purgeDays: 30 })
  await ui.unmount()
})

test('a pinned open note sorts to the top of its group; done notes do not', async ($, on) => {
  const { files } = engine(on, '/p/demo')
  const note = (title: string, created: string, extra = '') =>
    `---\ngroup: demo\n${extra}created: ${created}\n---\n\n# ${title}\n`
  files.set(`${ROOT}/notes/newest.md`, note('Newest', daysAgo(1)))
  files.set(`${ROOT}/notes/older.md`, note('Older', daysAgo(5)))

  await $.session.start({ cwd: '/p/demo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const order = async () => {
    const texts: string[] = []
    for (const t of ['Newest', 'Older']) {
      const found = await ui.find({ type: 'Text', text: t })
      if (found) texts.push(t)
    }
    return texts
  }
  expect(await order()).toEqual(['Newest', 'Older'])

  await ui.press({ key: 'pin-older' })
  expect(files.get(`${ROOT}/notes/older.md`)).toContain('pinned: true')
  expect(files.get(`${ROOT}/notes/older.md`)).not.toContain('updated:')

  // Checking it off hides the pin button.
  await ui.press({ key: 'chk-older' })
  expect(await ui.find({ key: 'pin-older' })).toBeUndefined()
  await ui.unmount()
})

test('💬 puts the note into the message box, without checklist dates', async ($, on) => {
  const { files } = engine(on, '/p/demo')
  files.set(
    `${ROOT}/notes/plan.md`,
    `---\ngroup: demo\ncreated: ${daysAgo(1)}\n---\n\n# Plan\n- [x] ship ➕ 2026-11-10 ✅ 2026-11-11\n`,
  )
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })

  await $.session.start({ cwd: '/p/demo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'chat-plan' })
  expect(filled).toEqual(['# Plan\n- [x] ship\n'])
  await ui.unmount()
})

test('💬 copies the note when the message box takes no draft', async ($, on) => {
  const { files } = engine(on, '/p/demo')
  files.set(`${ROOT}/notes/plan.md`, `---\ngroup: demo\ncreated: ${daysAgo(1)}\n---\n\n# Plan\n`)
  on('prompt.fill', () => ({ isFilled: false }))
  const copied: string[] = []
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })

  await $.session.start({ cwd: '/p/demo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'chat-plan' })
  expect(copied).toEqual(['# Plan'])
  await ui.unmount()
})

test('⬆️ / ⬇️ reorder open notes and the order is kept in the files', async ($, on) => {
  const { files } = engine(on, '/p/demo')
  const note = (title: string, created: string) =>
    `---\ngroup: demo\ncreated: ${created}\n---\n\n# ${title}\n`
  files.set(`${ROOT}/notes/a.md`, note('A', daysAgo(1)))
  files.set(`${ROOT}/notes/b.md`, note('B', daysAgo(2)))
  files.set(`${ROOT}/notes/c.md`, note('C', daysAgo(3)))

  await $.session.start({ cwd: '/p/demo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Newest first: A, B, C. The first has no ⬆️, the last no ⬇️.
  expect(await ui.find({ key: 'up-a' })).toBeUndefined()
  expect(await ui.find({ key: 'down-c' })).toBeUndefined()

  await ui.press({ key: 'down-a' })
  // Now B, A, C: B has no ⬆️, A has both.
  expect(files.get(`${ROOT}/notes/b.md`)).toContain('order: 0')
  expect(files.get(`${ROOT}/notes/a.md`)).toContain('order: 1')
  expect(files.get(`${ROOT}/notes/c.md`)).toContain('order: 2')
  expect(files.get(`${ROOT}/notes/a.md`)).not.toContain('updated:')
  expect(await ui.find({ key: 'up-b' })).toBeUndefined()
  expect(await ui.find({ key: 'up-a' })).toBeDefined()

  await ui.press({ key: 'down-a' })
  expect(files.get(`${ROOT}/notes/c.md`)).toContain('order: 1')
  expect(files.get(`${ROOT}/notes/a.md`)).toContain('order: 2')
  expect(await ui.find({ key: 'down-a' })).toBeUndefined()
  await ui.unmount()
})
