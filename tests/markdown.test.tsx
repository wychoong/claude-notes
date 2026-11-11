import { expect, test } from 'claude-code/testing'

import { PANE, engine } from './harness'


for (const surface of ['terminal', 'desktop'] as const) {
  test(`markdown heading and a clickable checklist (${surface})`, async ($, on) => {
    const { files } = engine(on, '/p/demo')

    await $.session.start({ cwd: '/p/demo', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.input({
      key: 'new-0',
      text: '# Release plan\nSome **bold** intro\n- [ ] write docs\n- [x] fix bug',
    })

    // Heading hashes are dropped; the caption counts the checklist.
    expect(await ui.find({ type: 'Text', text: 'Release plan' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /1\/2 ✓/ }))?.text).toContain('1/2 ✓')

    // Open the card: the body draws as markdown plus checklist rows.
    const opener = await ui.find({ type: 'Button', text: '▶\uFE0E' })
    expect(opener).toBeDefined()
    await ui.press({ key: opener!.key! })
    expect(await ui.find({ type: 'Markdown', text: /\*\*bold\*\*/ })).toBeDefined()

    // Tick "write docs": the count follows.
    const task = await ui.find({ type: 'Text', text: 'write docs' })
    expect(task).toBeDefined()
    // The note is a markdown file with frontmatter; items got ➕ dates.
    const [path] = [...files.keys()].filter(k => k.endsWith('.md'))
    expect(path).toMatch(/^\/home\/me\/\.claude\/plugins\/notes\/notes\/release-plan-[a-z0-9]+\.md$/)
    const before = files.get(path!)!
    expect(before).toMatch(/^---\ngroup: demo\ncreated: \S+\n---\n/)
    expect(before).toMatch(/- \[ \] write docs ➕ \d{4}-\d{2}-\d{2}/)
    expect(before).toMatch(/- \[x\] fix bug ➕ \S+ ✅ \d{4}-\d{2}-\d{2}/)

    const id = path!.split('/').pop()!.replace(/\.md$/, '')
    await ui.press({ key: `task-chk-${id}-2` })
    expect((await ui.find({ type: 'Text', text: /2\/2 ✓/ }))?.text).toContain('2/2 ✓')
    expect(files.get(path!)).toMatch(/- \[x\] write docs ➕ \S+ ✅ \d{4}/)
    expect(await ui.find({ type: 'Text', text: /^✅ today$/ })).toBeDefined()

    // Delete moves the file to the trash folder.
    await ui.press({ key: `del-${id}` })
    expect(files.has(path!)).toBe(false)
    expect([...files.keys()].some(k => k.startsWith('/home/me/.claude/plugins/notes/trash/'))).toBe(true)
    await ui.unmount()
  })
}

test('notes from the JSON store move into markdown files once', async ($, on) => {
  const { files, store } = engine(on, '/p/demo', {
    notes: [
      { id: '1', text: 'Old one\n- [ ] item', at: '2026-11-10T08:00:00.000Z', group: 'General' },
    ],
    groups: ['Ideas'],
  })

  await $.session.start({ cwd: '/p/demo', surface: 'desktop', isInteractive: true })
  const md = [...files.entries()].filter(([k]) => k.endsWith('.md'))
  expect(md.length).toBe(1)
  expect(md[0]![1]).toContain('group: General\ncreated: 2026-11-10T08:00:00.000Z')
  expect(md[0]![1]).toMatch(/- \[ \] item ➕ \d{4}/)
  expect([...files.entries()].find(([k]) => k.endsWith('groups.json'))?.[1]).toContain('Ideas')
  expect(store.get('migrated-to-md')).toBe(true)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Old one' })).toBeDefined()
  await ui.unmount()
})
