// Opening a file in the viewer: one rpc round trip for the content, then a
// quiet link refresh while the tab stays open.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type {
  OpenResult,
  rpcContract,
  ViewerLink,
  ViewerTarget,
} from "@/server";

/** Refresh URLs well before their one-hour lease expires. */
const LINK_REFRESH_MS = 45 * 60 * 1000;

export interface ViewerLinks {
  /** The PDF to show or open in a new tab; null for spreadsheets. */
  document: ViewerLink | null;
  /** The original file. */
  download: ViewerLink;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The browser's language: spreadsheets format dates and numbers for it. */
export function viewerLocale(): string {
  return typeof navigator !== "undefined" && navigator.language
    ? navigator.language
    : "en-US";
}

interface Opened {
  /** The target this result belongs to, so a stale one is never shown. */
  key: string;
  result: OpenResult;
  /** Bumped on every open; keys the embedded document so reload remounts it. */
  generation: number;
}

export function useViewer(target: ViewerTarget): {
  result: OpenResult | null;
  generation: number;
  links: ViewerLinks | null;
  error: string | null;
  isLoading: boolean;
  reload: () => void;
} {
  const rpc = useRpc<typeof rpcContract>();
  const key = JSON.stringify(target);
  const targetRef = useRef(target);
  targetRef.current = target;

  const [opened, setOpened] = useState<Opened | null>(null);
  const [links, setLinks] = useState<ViewerLinks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    rpc
      .call("open", { target: targetRef.current, locale: viewerLocale() })
      .then((result) => {
        if (cancelled) return;
        setOpened((previous) => ({
          key,
          result,
          generation: (previous?.generation ?? 0) + 1,
        }));
        setLinks({
          document: result.view === "pdf" ? result.document : null,
          download: result.download,
        });
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(errorMessage(cause));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, key, nonce]);

  const current = opened?.key === key ? opened : null;

  // New URLs replace the header's links only; the document on screen keeps
  // its own, so a long read is never reset to page one.
  useEffect(() => {
    if (!current) return;
    const timer = setInterval(() => {
      rpc
        .call("links", { target: targetRef.current })
        .then(setLinks)
        .catch(() => undefined);
    }, LINK_REFRESH_MS);
    return () => clearInterval(timer);
  }, [rpc, current]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return {
    result: current?.result ?? null,
    generation: current?.generation ?? 0,
    links: current ? links : null,
    error,
    isLoading,
    reload,
  };
}
