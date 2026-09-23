// bb-plugin-pdf-viewer — frontend entry.
//
// Two surfaces over one viewer: file openers, so a PDF, Word, PowerPoint or
// Excel file opened in bb renders here instead of downloading, and a nav
// panel for browsing a host's folders and reopening recent documents.
import { useMemo } from "react";
import {
  definePluginApp,
  type PluginFileOpenerProps,
} from "@get-bb/plugin-sdk/app";
import { DocumentsPanel } from "@/components/panel/DocumentsPanel";
import { DocumentViewer } from "@/components/viewer/DocumentViewer";
import {
  PDF_EXTENSIONS,
  PRESENTATION_EXTENSIONS,
  SPREADSHEET_EXTENSIONS,
  TEXT_EXTENSIONS,
} from "@/lib/formats";
import type { ViewerTarget } from "@/server";

/** File-opener surface: bb hands us a path and where it lives. */
function DocumentFileOpener({ path, source }: PluginFileOpenerProps) {
  // Copy only the fields the server's schema knows: the source object may
  // grow new fields in later bb versions, and the schema is strict.
  const target = useMemo<ViewerTarget>(
    () => ({
      kind: "opened",
      path,
      source: {
        kind: source.kind,
        threadId: source.threadId,
        environmentId: source.environmentId,
        projectId: source.projectId,
        ...(source.experimental_hostId
          ? { experimental_hostId: source.experimental_hostId }
          : {}),
      },
    }),
    [
      path,
      source.kind,
      source.threadId,
      source.environmentId,
      source.projectId,
      source.experimental_hostId,
    ],
  );
  return <DocumentViewer target={target} />;
}

export default definePluginApp((app) => {
  // Three openers rather than one, so "Open with" and Settings → File
  // openers name what each one does.
  app.slots.fileOpener({
    id: "pdf",
    title: "PDF viewer",
    extensions: [...PDF_EXTENSIONS],
    component: DocumentFileOpener,
  });

  app.slots.fileOpener({
    id: "office",
    title: "Document viewer",
    extensions: [...TEXT_EXTENSIONS, ...PRESENTATION_EXTENSIONS],
    component: DocumentFileOpener,
  });

  app.slots.fileOpener({
    id: "spreadsheet",
    title: "Spreadsheet viewer",
    extensions: [...SPREADSHEET_EXTENSIONS],
    component: DocumentFileOpener,
  });

  app.slots.navPanel({
    id: "pdf",
    title: "Documents",
    icon: "FileText",
    path: "pdf",
    component: DocumentsPanel,
  });
});
