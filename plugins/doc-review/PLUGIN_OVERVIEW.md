Read and review documents without leaving bb: Markdown, PDF, Word,
PowerPoint, and Excel open in a tab beside the chat, and every comment you
leave goes to an agent in one message.

## What you get

- Markdown, PDF, Word, PowerPoint, and Excel files open in a tab beside the
  chat instead of downloading. Word and PowerPoint are converted with
  LibreOffice; workbooks show as a formatted grid with sheet tabs.
- A classic view with the browser's own PDF viewer for search, zoom, and
  printing, and a download button for the original file.
- Comments on selected text, on a box drawn around a chart or picture, on
  spreadsheet cells, or on the whole document.
- Comments collect as drafts. Send them to the current chat or start a new
  chat with them; area comments carry an image of the region.
- The agent closes each comment with a note or asks a question back, and the
  tab shows it live: done, waiting, or needs you.
- A **Doc Review** page with commented files, recent files, and a folder
  browser.

## How it works

Pages are rendered on the bb server with poppler; Word and PowerPoint files
are converted with LibreOffice first and cached per version. Comments are
stored in the plugin's own database; the reviewed file is only changed by the
agent you send the comments to.

## For agents

The bundled skill explains how to apply a batch and report back with
`bb doc-review resolve` and `bb doc-review reply`.
