// The "Doc Review" sidebar page: every file with comments and where its
// comments stand, a field to open any file by path, and a full-page review.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  useBbNavigate,
  useRealtime,
  type PluginFileOpenerSource,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { ReviewDoc } from "../src/types";
import { Workspace } from "./review-opener";
import { errorText, useReviewRpc } from "./use-review";

export const PANEL_PATH = "doc-review";

const HOST_SOURCE: PluginFileOpenerSource = {
  kind: "host",
  threadId: null,
  environmentId: null,
  projectId: null,
};

interface DocSummary {
  id: string;
  kind: ReviewDoc["kind"];
  name: string;
  absPath: string;
  counts: { draft: number; sent: number; replied: number; resolved: number };
  lastActivity: number;
}

function Counts({ counts }: { counts: DocSummary["counts"] }) {
  const parts = [
    counts.replied ? `${counts.replied} answered` : null,
    counts.draft ? `${counts.draft} draft${counts.draft === 1 ? "" : "s"}` : null,
    counts.sent ? `${counts.sent} waiting` : null,
    counts.resolved ? `${counts.resolved} done` : null,
  ].filter(Boolean);
  return <span>{parts.join(" · ")}</span>;
}

function DocList() {
  const rpc = useReviewRpc();
  const navigate = useBbNavigate();
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [opening, setOpening] = useState(false);

  const refetch = useCallback(() => {
    rpc.call("docs.list").then(
      (result) => {
        setDocs(result.docs);
        setError(null);
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("review-changed", refetch);

  const open = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = path.trim();
    if (!target || opening) return;
    setOpening(true);
    try {
      const { doc } = await rpc.call("doc.open", { path: target, source: HOST_SOURCE });
      navigate.toPluginPanel(PANEL_PATH, { subPath: `doc/${doc.id}` });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <p className="text-sm text-muted-foreground">
          Open a Markdown, PDF, or PPTX file from a chat to comment on it, then send every
          comment to the agent at once. Files you have commented on are listed here.
        </p>
        <form onSubmit={open} className="flex items-center gap-2">
          <Input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/absolute/path/to/file.pptx"
            aria-label="File to review"
          />
          <Button type="submit" disabled={opening || !path.trim()}>
            <Icon name={opening ? "Loading" : "FileText"} className={opening ? "size-4 animate-spin" : "size-4"} />
            Review
          </Button>
        </form>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {docs === null ? null : docs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No comments yet.
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {docs.map((doc) => (
              <li key={doc.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/50"
                  onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: `doc/${doc.id}` })}
                >
                  <Icon name="FileText" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{doc.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{doc.absPath}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    <Counts counts={doc.counts} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function DocPage({ docId }: { docId: string }) {
  const rpc = useReviewRpc();
  const navigate = useBbNavigate();
  const [doc, setDoc] = useState<ReviewDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    rpc.call("doc.get", { docId }).then(
      (result) => alive && setDoc(result.doc),
      (cause: unknown) => alive && setError(errorText(cause)),
    );
    return () => {
      alive = false;
    };
  }, [rpc, docId]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
        <p>{error}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => navigate.toPluginPanel(PANEL_PATH)}>
          Back to the list
        </Button>
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Icon name="Loading" className="size-5 animate-spin" />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={() => navigate.toPluginPanel(PANEL_PATH)}
        >
          <Icon name="ChevronLeft" className="size-4" />
          All files
        </Button>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{doc.absPath}</span>
      </div>
      <div className="min-h-0 flex-1">
        <Workspace doc={doc} source={HOST_SOURCE} />
      </div>
    </div>
  );
}

export function ReviewsPage({ subPath }: PluginNavPanelProps) {
  const match = /^doc\/(d_[a-f0-9]+)/.exec(subPath);
  return match ? <DocPage key={match[1]} docId={match[1]!} /> : <DocList />;
}
