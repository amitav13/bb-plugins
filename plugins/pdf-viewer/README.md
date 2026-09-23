# Document Viewer

Read PDF, Word, PowerPoint and Excel files inside bb instead of downloading
them. (The plugin id stays `pdf-viewer`, the name it was first published
under.)

- **PDF** renders in the browser's own viewer, with its paging, zoom, search
  and print controls.
- **Word and PowerPoint** — `docx`, `doc`, `odt`, `rtf`, `pptx`, `ppt`, `odp`
  and their macro and template variants — are converted to PDF by
  [LibreOffice](https://www.libreoffice.org) on the machine bb runs on, then
  shown in the same viewer. Conversions are cached per file version, so a
  document converts once and reopens instantly.
- **Excel** — `xlsx`, `xlsm`, `xls`, `xlsb`, `ods` and templates — opens as a
  grid: sheet tabs, column letters and row numbers, cell formatting (fonts,
  fills, borders, alignment, number formats), merged cells, frozen panes,
  hidden rows and columns. Dates and numbers follow the browser's locale, the
  way Excel follows the system's.
- **A Documents panel** in the sidebar browses a host's folders (only folders
  and supported files are listed) and reopens recent documents.

Any matching file opened in bb — a link in a message, the file picker,
`bb thread open` — renders in a panel tab. Three openers are registered (PDF
viewer, Document viewer, Spreadsheet viewer), so Settings → File openers and
"Open with" name what each one does.

## Install

```sh
bb plugin install path:"/path/to/bb-plugins" --plugin pdf-viewer --yes
```

Word and PowerPoint files need LibreOffice on the machine bb runs on. PDFs
and spreadsheets do not.

| Platform | Command |
| --- | --- |
| Debian, Ubuntu | `sudo apt install libreoffice-writer libreoffice-impress` |
| Fedora | `sudo dnf install libreoffice-writer libreoffice-impress` |
| macOS | `brew install --cask libreoffice` |
| Windows | `winget install TheDocumentFoundation.LibreOffice` |

With `libreoffice-calc` installed as well, legacy spreadsheets (`xls`,
`xlsb`, `ods`) are converted to `xlsx` first and keep their formatting;
without it they still open, with values and fills only. Office documents
often use Calibri and Cambria: on Linux, `fonts-crosextra-carlito` and
`fonts-crosextra-caladea` keep their layout faithful.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Remember recently opened documents | on | Keeps the last 12 documents opened from the panel in its "Recent" list. Turn it off to record nothing. |
| LibreOffice executable | empty | Full path to `soffice` when it is not on `PATH` or in the usual install folders. Empty means find it automatically. |

Settings changes apply immediately; the recent list can also be cleared from
the panel.

## How it works

- `server.ts` resolves a request to an absolute path and a host: workspace
  paths against the environment's checkout (or the project's checkout),
  thread-storage paths against the thread's storage root, host paths as-is.
  A file on another host is copied over bb's host connection first.
- **PDF transport.** Preferred transport is `bb.sdk.files.createPreview`,
  confined to the document's own directory and leased for an hour. Files past
  the 25 MB preview ceiling are registered in an in-memory registry
  (`src/documents.ts`) and served by the plugin's own route
  (`src/http-routes.ts`), which honours `Range` and never accepts a path from
  the client — only an opaque id whose lease extends while it is being read.
- **Conversion** (`src/libreoffice.ts`) runs LibreOffice headless in the
  plugin's own profile, one document at a time, killing a conversion that
  runs past three minutes. The input is linked into a staging folder under a
  neutral name, so nothing is written next to the user's file. Output lands in
  an on-disk cache (`src/conversion-cache.ts`) under
  `<bb data dir>/plugins/pdf-viewer/cache`, one folder per document, capped at
  1 GB and 30 days of disuse.
- **Spreadsheets** (`src/spreadsheet/`) are parsed on the server into a
  bounded grid model (`lib/sheet-model.ts`): at most 5,000 rows, 200 columns
  and 100,000 cells per sheet, with a note when a sheet is cut. The `xlsx`
  reader streams the workbook and yields to the event loop, so a large file
  does not stall bb. Parsed workbooks stay open for ten minutes
  (`src/lease-cache.ts`), so switching sheets does not parse again.
- `app.tsx` renders PDFs in an iframe and spreadsheets in a grid
  (`components/spreadsheet/`), and refreshes download links every 45 minutes
  without reloading the document on screen.

## Known limits

- bb picks the first matching file opener in plugin-id order. bb 0.43 ships a
  builtin `pdf-preview` that sorts before `pdf-viewer`, so a `.pdf` link opens
  there by default; pin this plugin under Settings → File openers, or use
  "Open with", to get its viewer (which also streams PDFs past 25 MB). The
  same applies to any other installed plugin that claims these extensions.
- The grid renders only the rows around the viewport, so the browser's Find
  sees those rows, not the whole sheet.
- A file larger than 25 MB **on another host** cannot be shown as PDF, and a
  file over 64 MB on another host cannot be converted or read: bb's preview
  transport refuses the former, and the copy over the host connection is
  bounded.
- Files over 150 MB are not converted.
- Charts, images and conditional formatting in spreadsheets are not drawn;
  the grid shows cell values and formatting.
- Without LibreOffice Calc, `xls`, `xlsb` and `ods` are read directly, with
  values and fills only, up to 20 MB.
- The plugin's streaming route uses bb's `local` auth, which is what an iframe
  navigation from the bb app satisfies.

## Development

```sh
npm install
npm test           # vitest: readers, conversion, caches, ranges, paths
npx tsc --noEmit
bb plugin build .
bb plugin dev .    # rebuild + reload on save
```
