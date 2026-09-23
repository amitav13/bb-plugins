# Doc Review

Comment on a Markdown, PDF, or PPTX file the way you would in Figma, then hand
every comment to an agent in one message — in the current chat or a new one.
The agent closes each comment with a note, so the panel shows what was fixed
and what still needs you.

- **Open any `.md`, `.pdf`, or `.pptx` for review.** The plugin registers as a
  file opener, so a file linked in chat, picked in the file picker, or opened
  with `bb thread open` renders in a panel tab beside the chat. The eye button
  switches to bb's own preview.
- **Comment on text or on an area.** Select text and press **Comment**.
  On PDF pages and slides, switch to **Area** and draw a box around a chart or
  picture. A whole-document comment is one click in the list.
- **Collect first, send once.** Comments stay as drafts until you press
  **Send to chat** (this chat) or pick **To a new chat** (same project, model,
  and workspace, fresh context). Area comments travel with an image of the
  region.
- **See the agent's answers.** The agent runs `bb doc-review resolve` or
  `bb doc-review reply`; the panel moves each comment to *Done* or *Needs you*
  with the agent's note, live.
- **All reviewed files in one place.** The **Doc Review** page in the sidebar
  lists files with comments and their status, and opens any file by path.

The reviewed file is never modified by the plugin; comments live in the
plugin's own database.

## Install

```sh
bb plugin install path:"/path/to/bb-plugins" --plugin doc-review --yes
```

The first opener registered for an extension becomes its default. To keep
bb's preview (or another viewer) as the default for `.md` or `.pdf`, pin it
under **Settings → File openers**; *Open with → Doc Review (comments)* stays in
the file link's context menu.

## Requirements

On the machine where the bb server runs:

| Tool | Needed for |
| --- | --- |
| `pdfinfo`, `pdftoppm`, `pdftotext` (poppler-utils) | PDF and PPTX pages, text selection, area images |
| `soffice` (LibreOffice) | PPTX: slides are converted to PDF once per file version |

Slides render with the fonts installed on that machine (including `~/.fonts`).

## For agents

The bundled skill (`skills/doc-review`) tells the agent how to apply a batch
and report back. The command:

```sh
bb doc-review list                          # comments sent to this thread, still waiting
bb doc-review list --status all --all-threads
bb doc-review show <id>
bb doc-review resolve <id...> --note "what changed"
bb doc-review reply <id> --note "question or reason"
```

## How it works

- `server.ts` resolves the opened path (workspace, thread storage, or host
  path) to an absolute path and host, stores documents and comments in the
  plugin's SQLite database, and publishes a realtime signal on every change.
- Markdown is split into top-level blocks (`marked` lexer) and each block is
  rendered with bb's `Markdown` component, so a selection maps back to source
  lines. Highlights use the CSS Custom Highlight API.
- PDF pages are rendered to PNG by `pdftoppm` on first view and cached per file
  version; `pdftotext -bbox-layout` supplies word boxes for an invisible,
  selectable text layer. A PPTX is converted to PDF by LibreOffice first.
- The panel polls the file's version every few seconds, so edits by the agent
  show up without reopening the tab.
- Sending builds one message (file, then per comment: id, location, quote,
  request) and either sends it to the current thread or spawns a new thread in
  the same project and environment with the source thread's model.

## Known limits

- Rendering runs on the bb server's machine. Files on other hosts are copied
  there for rendering.
- A PDF without its source can be commented on, but the agent can only answer
  those comments, not rebuild the PDF.
- When the file changes, comments anchored to text that no longer exists are
  marked in the list instead of highlighted.

## Development

```sh
npm install
npx tsc --noEmit
bb plugin build .
bb plugin dev .    # rebuild + reload on save
```
