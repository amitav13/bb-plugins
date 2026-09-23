// Holds the sheets of one opened workbook: the first arrives with the open
// call, the others are fetched when their tab is picked and kept for the
// next visit.
import { useCallback, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { SpreadsheetView } from "@/components/spreadsheet/SpreadsheetView";
import type { SheetData } from "@/lib/sheet-model";
import type { OpenResult, rpcContract, ViewerTarget } from "@/server";
import { errorMessage, viewerLocale } from "./use-viewer";

type SpreadsheetResult = Extract<OpenResult, { view: "spreadsheet" }>;

/** Sheets kept in the browser; each can hold up to 100k cells. */
const KEPT_SHEETS = 6;

export function SpreadsheetPane({
  target,
  result,
}: {
  target: ViewerTarget;
  result: SpreadsheetResult;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [sheets, setSheets] = useState<Map<number, SheetData>>(
    () => new Map([[result.sheet.index, result.sheet]]),
  );
  const [selected, setSelected] = useState(result.sheet.index);
  const [shown, setShown] = useState<SheetData>(result.sheet);
  const [loadingSheet, setLoadingSheet] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);
  const sheetsRef = useRef(sheets);
  sheetsRef.current = sheets;

  const onSelectSheet = useCallback(
    (index: number) => {
      const request = ++latestRequest.current;
      setSelected(index);
      setError(null);
      const cached = sheetsRef.current.get(index);
      if (cached) {
        setShown(cached);
        setLoadingSheet(null);
        return;
      }
      setLoadingSheet(index);
      rpc
        .call("sheet", { target, index, locale: viewerLocale() })
        .then(({ sheet }) => {
          setSheets((previous) => {
            const next = new Map(previous);
            next.delete(index);
            next.set(index, sheet);
            // Map keeps insertion order: the oldest visit goes first.
            for (const key of next.keys()) {
              if (next.size <= KEPT_SHEETS) break;
              if (key !== index) next.delete(key);
            }
            return next;
          });
          if (latestRequest.current !== request) return;
          setShown(sheet);
          setLoadingSheet(null);
        })
        .catch((cause: unknown) => {
          if (latestRequest.current !== request) return;
          setLoadingSheet(null);
          setError(errorMessage(cause));
        });
    },
    [rpc, target],
  );

  // While another sheet loads the previous one stays on screen, dimmed by
  // the view; a sheet that failed to load shows its error instead.
  const sheet = shown.index === selected || loadingSheet !== null ? shown : null;
  return (
    <SpreadsheetView
      workbook={result.workbook}
      selectedSheet={selected}
      sheet={error ? null : sheet}
      loadingSheet={loadingSheet}
      error={error}
      onSelectSheet={onSelectSheet}
    />
  );
}
