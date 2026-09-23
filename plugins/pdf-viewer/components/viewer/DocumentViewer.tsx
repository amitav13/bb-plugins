// One file in the viewer: a header with the file's actions, and below it the
// PDF, the spreadsheet grid, or what is missing to show either.
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { documentFamily } from "@/lib/formats";
import { baseName } from "@/lib/pdf-paths";
import type { ViewerTarget } from "@/server";
import { openingMessage } from "./family";
import { NeedsLibreOffice } from "./NeedsLibreOffice";
import { SpreadsheetPane } from "./SpreadsheetPane";
import { Centered, Spinner } from "./Status";
import { useViewer } from "./use-viewer";
import { ViewerHeader } from "./ViewerHeader";

export function DocumentViewer({
  target,
  onBack,
}: {
  target: ViewerTarget;
  onBack?: () => void;
}) {
  const { result, generation, links, error, isLoading, reload } = useViewer(target);
  const family = result?.file.family ?? documentFamily(target.path);
  const name = result?.file.name ?? baseName(target.path);

  return (
    <div className="flex h-full w-full flex-col">
      <ViewerHeader
        name={name}
        path={result?.file.path ?? target.path}
        family={family}
        note={
          result?.view === "pdf" && result.converted
            ? "PDF preview"
            : result?.view === "spreadsheet" && result.fidelity === "basic"
              ? "Values only"
              : undefined
        }
        links={links}
        onBack={onBack}
        onReload={reload}
        isReloading={isLoading && result !== null}
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        {error ? (
          <Centered>
            <Icon name="AlertTriangle" className="mx-auto size-5" aria-hidden />
            <p className="text-destructive">Could not open {name}.</p>
            <p className="break-words">{error}</p>
            <Button size="sm" variant="outline" onClick={reload}>
              <Icon name="RotateCcw" aria-hidden />
              Try again
            </Button>
          </Centered>
        ) : !result ? (
          // A reload keeps the current content on screen; only the first
          // open has nothing to show yet.
          <Centered>
            <Spinner label={openingMessage(family)} />
          </Centered>
        ) : result.view === "pdf" ? (
          // The browser's own PDF viewer: paging, zoom, search and print.
          // Keyed by the open, not by URL, so a link refresh never reloads it.
          <iframe
            key={generation}
            src={result.document.url}
            title={name}
            className="min-h-0 w-full flex-1 border-0 bg-muted"
          />
        ) : result.view === "spreadsheet" ? (
          <SpreadsheetPane key={generation} target={target} result={result} />
        ) : (
          <NeedsLibreOffice result={result} onReload={reload} />
        )}
      </div>
    </div>
  );
}
