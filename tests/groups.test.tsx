import { expect, test } from 'claude-code/testing'

import { PANE, engine } from './harness'


for (const surface of ['terminal', 'desktop'] as const) {
  test(`notes go to the project group, new groups, and the filter (${surface})`, async ($, on) => {
    const { files } = engine(on, '/Users/me/Project/my-app')

    await $.session.start({ cwd: '/Users/me/Project/my-app', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })

    // A new note lands in the project folder's group.
    await ui.input({ key: 'new-0', text: 'First\nbody' })
    expect((await ui.find({ type: 'Text', text: /^MY-APP/ }))?.text).toContain('MY-APP · 1')

    // Make a group; it becomes the target for the next note.
    await ui.select({ key: 'current-group', value: '__notes_new_group__' })
    await ui.input({ key: 'new-group', text: 'Ideas' })
    await ui.input({ key: 'new-1', text: 'Second' })
    expect((await ui.find({ type: 'Text', text: /^IDEAS/ }))?.text).toContain('IDEAS · 1')

    // Show only Ideas: the project's section goes.
    await ui.select({ key: 'show', value: 'Ideas' })
    expect(await ui.find({ type: 'Text', text: /^MY-APP/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Second' })).toBeDefined()

    // Back to all: both sections again.
    await ui.select({ key: 'show', value: '__notes_show_all__' })
    expect((await ui.find({ type: 'Text', text: /^MY-APP/ }))?.text).toContain('MY-APP · 1')
    const first = await ui.find({ type: 'Text', text: 'First' })
    expect(first).toBeDefined()
    await ui.unmount()
  })
}
