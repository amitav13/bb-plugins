// Nav panel: browse a host's folders for documents, or reopen a recent one.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { familyIcon } from "@/components/viewer/family";
import { DocumentViewer } from "@/components/viewer/DocumentViewer";
import { errorMessage } from "@/components/viewer/use-viewer";
import { documentFamily } from "@/lib/formats";
import type { RecentDocument, rpcContract, ViewerTarget } from "@/server";

interface BrowseEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

/** How many recent documents the panel lists above the folder. */
const RECENTS_SHOWN = 5;

export function DocumentsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [hostId, setHostId] = useState<string | null>(null);
  const [directory, setDirectory] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [recents, setRecents] = useState<RecentDocument[]>([]);
  const [selected, setSelected] = useState<ViewerTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(true);

  const browse = useCallback(
    async (next: { hostId?: string | null; path?: string | null }) => {
      setIsBusy(true);
      setError(null);
      try {
        const listing = await rpc.call("browse", {
          hostId: next.hostId ?? null,
          path: next.path ?? null,
        });
        setHostId(listing.hostId);
        setDirectory(listing.directory);
        setParent(listing.parent);
        setEntries(listing.entries);
      } catch (cause: unknown) {
        setError(errorMessage(cause));
      } finally {
        setIsBusy(false);
      }
    },
    [rpc],
  );

  const refreshRecents = useCallback(async () => {
    try {
      const { recents: next } = await rpc.call("recents");
      setRecents(next);
    } catch {
      // Recents are a convenience; a failure here must not block browsing.
    }
  }, [rpc]);

  useEffect(() => {
    void browse({});
    void refreshRecents();
  }, [browse, refreshRecents]);

  const crumbs = useMemo(() => {
    if (!directory) return [];
    const segments = directory.split("/").filter(Boolean);
    return segments.map((segment, index) => ({
      name: segment,
      path: `/${segments.slice(0, index + 1).join("/")}`,
    }));
  }, [directory]);

  if (selected) {
    return (
      <DocumentViewer
        target={selected}
        onBack={() => {
          setSelected(null);
          // The open just recorded this document; show it on the way back.
          void refreshRecents();
        }}
      />
    );
  }

  const open = (path: string, host: string | null) =>
    setSelected({ kind: "host", path, hostId: host });

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <Button
          size="sm"
          variant="ghost"
          disabled={!parent}
          onClick={() => void browse({ hostId, path: parent })}
          aria-label="Parent folder"
        >
          <Icon name="ChevronLeft" aria-hidden />
        </Button>
        {crumbs.length === 0 ? (
          <span>{directory ?? "…"}</span>
        ) : (
          crumbs.map((crumb, index) => (
            <span key={crumb.path} className="flex items-center gap-1">
              {index > 0 ? <span aria-hidden>/</span> : null}
              <button
                type="button"
                className="cursor-pointer rounded px-1 hover:bg-state-hover hover:text-foreground"
                onClick={() => void browse({ hostId, path: crumb.path })}
              >
                {crumb.name}
              </button>
            </span>
          ))
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {error ? (
          <p className="px-2 py-1 text-sm text-destructive">{error}</p>
        ) : null}

        {recents.length > 0 ? (
          <div className="mb-3">
            <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
              Recent
            </p>
            {recents.slice(0, RECENTS_SHOWN).map((recent) => (
              <button
                key={`${recent.hostId ?? "local"}:${recent.path}`}
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover"
                onClick={() => open(recent.path, recent.hostId)}
                title={recent.path}
              >
                <Icon
                  name={familyIcon(documentFamily(recent.path))}
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="truncate">{recent.name}</span>
              </button>
            ))}
          </div>
        ) : null}

        {isBusy ? (
          <p className="px-2 py-1 text-sm text-muted-foreground">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="px-2 py-1 text-sm text-muted-foreground">
            No folders or documents here.
          </p>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover"
              onClick={() => {
                if (entry.kind === "directory") {
                  void browse({ hostId, path: entry.path });
                } else {
                  open(entry.path, hostId);
                }
              }}
              title={entry.path}
            >
              <Icon
                name={
                  entry.kind === "directory"
                    ? "Folder"
                    : familyIcon(documentFamily(entry.name))
                }
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="truncate">{entry.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
