/**
 * One note. `at` is when it was created (kept under that name so notes saved
 * by earlier versions still read); `updatedAt` is set when its text is edited,
 * `doneAt` while it is checked off. `group` is absent on notes saved before
 * groups existed, which read as the `General` group.
 */
export type Note = {
  id: string
  text: string
  at: string
  updatedAt?: string
  done?: boolean
  doneAt?: string
  group?: string
  /** Kept at the top of its group while it is open. */
  pinned?: boolean
  /** Set on a note in the trash: when it was deleted. */
  trashedAt?: string
}

declare module 'claude-code' {
  interface PluginState {
    notes: {
      list: Shaped<Note[]>
      /** Groups made by hand, kept even while they hold no note. */
      groups: Shaped<string[]>
      /** The session's project folder name, the default group. */
      project: string | null
      /** The group new notes go to; null means the project's. */
      current: string | null
      /** Groups the list shows; empty means all of them. */
      filter: string[]
      /** True while the new-group field shows. */
      isCreating: boolean
      /** Ids of notes whose cards are open. */
      expanded: string[]
      editing: string | null
      /** Notes in the trash folder. */
      trash: Shaped<Note[]>
      /** Which screen the pane shows. */
      view: 'notes' | 'trash' | 'settings'
      /** The pane's settings, as in settings.json. */
      settings: { autoTrashDays: number; purgeDays: number }
    }
  }
}
