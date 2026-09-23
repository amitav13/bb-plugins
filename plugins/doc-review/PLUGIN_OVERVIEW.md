Review a document the way you review a design: leave comments right on a
Markdown file, a PDF, or a PowerPoint deck, then hand all of them to an agent
in one message.

## What you get

- Any `.md`, `.pdf`, or `.pptx` opens in a review tab beside the chat.
- Select text to comment on it; on pages and slides, draw a box around a
  chart or picture.
- Comments collect as drafts. Send them to the current chat or start a new
  chat with them; area comments carry an image of the region.
- The agent closes each comment with a note or asks a question back, and the
  tab shows it live: done, waiting, or needs you.
- A **Doc Review** page lists every file you have commented on.

## How it works

Pages are rendered on the bb server with poppler, and slides are converted
with LibreOffice first. Comments are stored in the plugin's own database; the
reviewed file is only changed by the agent you send the comments to.

## For agents

The bundled skill explains how to apply a batch and report back with
`bb doc-review resolve` and `bb doc-review reply`.
