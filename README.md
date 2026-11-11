# claude-notes

A note-taking pane for Claude Code that sits beside the chat. Notes are plain
markdown files with frontmatter, so you can also read and edit them in any
editor.

## Install

```
/plugin install notes --marketplace wychoong/claude-notes
```

Or from a terminal:

```bash
claude plugin marketplace add wychoong/claude-notes
claude plugin install notes@claude-notes
```

Open the pane with `/notes`.

## Features

- **Markdown notes**: the first line is the heading, the rest is the body.
  Press ▶ on a card to see the body rendered, with `- [ ]` items as
  clickable checkboxes.
- **Checklist dates**: items are stamped `➕ YYYY-MM-DD` when added and
  `✅ YYYY-MM-DD` when ticked.
- **To-dos**: check off a note to move it to its group's Completed list.
- **Groups**: new notes go to a group named after the project folder. Switch
  or create groups from the "Add to" picker, move a note from its ✏️ editor,
  and filter with the Show dropdown. Click a group's heading to fold it.
  Each group's Completed list starts folded; click its heading to open it.
  Folds are remembered.
- **Pins**: 📌 keeps an open note at the top of its group.
- **Reorder**: ⬆️ / ⬇️ (on hover) move an open note within its group; the
  order is saved in the note's frontmatter.
- **Trash**: ✕ moves a note to the trash, where you can restore it or delete
  it for good.
- **Settings**: optionally move completed notes to the trash after some
  days, and delete trashed notes after some days (both off by default).
- **From the chat**: highlight text and press "＋ Add highlighted chat text",
  or run `/note-this` (or `/note-this some text`).

## Where notes are kept

Outside the plugin, so updates never touch them:

```
~/.claude/plugins/notes/
  notes/<id>.md     one file per note
  trash/<id>.md     deleted notes
  groups.json       groups you created
  settings.json     the pane's settings
```

(Under `$CLAUDE_CONFIG_DIR/plugins/notes/` when `CLAUDE_CONFIG_DIR` is set.)

A note file:

```markdown
---
group: my-project
pinned: true
created: 2026-11-11T09:53:58.238Z
updated: 2026-11-11T10:12:00.000Z
---

# Release plan
- [ ] write docs ➕ 2026-11-11
- [x] fix bug ➕ 2026-11-10 ✅ 2026-11-11
```

## Develop

```bash
claude plugin validate .
claude plugin test .
```

## License

MIT
