import type { On } from 'claude-code'

export const PANE = {
  plugin: 'notes',
  component: 'Pane',
  requestId: 'notes',
  props: {
    title: 'Notes',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/**
 * Stands in for the engine beneath the mod: commands, panes, the session's
 * folder, the key-value store, and an in-memory file system (with `rm`).
 */
export const engine = (on: On, cwd: string, oldStore: Record<string, unknown> = {}) => {
  const store = new Map<string, unknown>(Object.entries(oldStore))
  const files = new Map<string, string>()
  const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'))

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({
    value: files.has(e.path) || [...files.keys()].some(k => k.startsWith(`${e.path}/`)),
  }))
  on('fs.list', (_, e) => {
    const dir = e.path ?? cwd
    const names = new Map<string, 'file' | 'dir'>()
    for (const k of files.keys()) {
      if (!k.startsWith(`${dir}/`)) continue
      const rest = k.slice(dir.length + 1)
      const [head = ''] = rest.split('/')
      names.set(head, rest.includes('/') ? 'dir' : 'file')
    }
    return {
      value: [...names].map(([name, kind]) => ({
        name,
        kind,
        size: 0,
        mtimeMs: 0,
        isLink: false,
      })),
    }
  })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'rm') for (const a of e.argv.slice(1)) files.delete(a)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return { store, files, dirOf }
}
