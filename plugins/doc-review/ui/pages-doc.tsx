// Page view for PDF and PPTX: server-rendered page images with an invisible,
// selectable word layer on top. Text selections become `page-text` comments;
// in Area mode a dragged box becomes a `page-area` comment.
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  pageNoun,
  type Anchor,
  type DocKind,
  type PageInfo,
  type PageWord,
  type Rect,
  type ReviewComment,
} from "../src/types";
import type { Point } from "./markdown-doc";
import { isCommentShortcut, SelectionMenu } from "./selection-menu";
import { errorText, useReviewRpc } from "./use-review";

export type PageMode = "text" | "area";

interface LiveSelection {
  page: number;
  rects: Rect[];
  quote: string;
}

const MIN_AREA = 0.012;

function unionRect(words: PageWord[]): Rect {
  const x0 = Math.min(...words.map((word) => word[0]));
  const y0 = Math.min(...words.map((word) => word[1]));
  const x1 = Math.max(...words.map((word) => word[2]));
  const y1 = Math.max(...words.map((word) => word[3]));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function inside(rect: Rect, word: PageWord): boolean {
  const cx = (word[0] + word[2]) / 2;
  const cy = (word[1] + word[3]) / 2;
  return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(3)}%`;
}

/** The invisible word layer that makes page text selectable. */
const TextLayer = memo(function TextLayer({
  lines,
  aspect,
}: {
  lines: PageWord[][];
  /** Page height / width. */
  aspect: number;
}) {
  return (
    <div className="doc-review-textlayer absolute inset-0" data-textlayer="">
      {lines.map((line, li) =>
        line.map((word, wi) => (
          <span
            key={`${li}:${wi}`}
            data-li={li}
            data-wi={wi}
            style={{
              left: pct(word[0]),
              top: pct(word[1]),
              width: pct(word[2] - word[0]),
              height: pct(word[3] - word[1]),
              fontSize: `${((word[3] - word[1]) * aspect * 100 * 0.85).toFixed(3)}cqw`,
            }}
          >
            {word[4]}
          </span>
        )),
      )}
    </div>
  );
});

function Pin({
  seq,
  rect,
  active,
  resolved,
  onClick,
}: {
  seq: number;
  rect: Rect;
  active: boolean;
  resolved: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "pointer-events-auto absolute z-30 inline-flex h-5 min-w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full px-1 text-[11px] font-semibold shadow",
        active
          ? "bg-primary text-primary-foreground ring-2 ring-primary/40"
          : resolved
            ? "bg-muted text-muted-foreground"
            : "bg-primary/90 text-primary-foreground",
      )}
      style={{ left: `max(10px, ${pct(rect.x)})`, top: `max(10px, ${pct(rect.y)})` }}
      aria-label={`Comment ${seq}`}
    >
      {seq}
    </button>
  );
}

function PageView({
  page,
  kind,
  lines,
  mode,
  comments,
  activeId,
  live,
  pendingAnchor,
  onVisible,
  onStale,
  onSelectComment,
  onArea,
}: {
  page: PageInfo;
  kind: DocKind;
  lines: PageWord[][] | undefined;
  mode: PageMode;
  comments: ReviewComment[];
  activeId: string | null;
  live: LiveSelection | null;
  pendingAnchor: Anchor | null;
  onVisible: (n: number) => void;
  onStale: () => void;
  onSelectComment: (id: string) => void;
  onArea: (page: number, rect: Rect, element: HTMLElement) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );

  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onVisible(page.n);
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [page.n, onVisible]);

  const pointFor = (event: ReactPointerEvent) => {
    const box = element.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    };
  };

  const draftRect: Rect | null = draft
    ? {
        x: Math.min(draft.x0, draft.x1),
        y: Math.min(draft.y0, draft.y1),
        w: Math.abs(draft.x1 - draft.x0),
        h: Math.abs(draft.y1 - draft.y0),
      }
    : null;

  // Clicking highlighted text (with no selection) opens its comment.
  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (mode !== "text") return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const box = element.current!.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    const hit = comments.find((comment) => {
      const anchor = comment.anchor;
      if (anchor.kind === "page-text" && anchor.page === page.n) {
        return anchor.rects.some((rect) => contains(rect, x, y));
      }
      if (anchor.kind === "page-area" && anchor.page === page.n) return contains(anchor.rect, x, y);
      return false;
    });
    if (hit) onSelectComment(hit.id);
  };

  const pendingOnPage =
    pendingAnchor &&
    (pendingAnchor.kind === "page-text" || pendingAnchor.kind === "page-area") &&
    pendingAnchor.page === page.n
      ? pendingAnchor
      : null;

  return (
    <div
      ref={element}
      data-page={page.n}
      className="@container relative w-full overflow-hidden rounded-md border border-border bg-muted shadow-sm"
      style={{ aspectRatio: `${page.width} / ${page.height}` }}
      onClick={onClick}
    >
      <img
        src={page.url}
        alt={`${pageNoun(kind)} ${page.n}`}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={onStale}
        className="pointer-events-none absolute inset-0 size-full select-none"
      />

      {/* Existing comments, the live selection, and the comment being written. */}
      <div className="pointer-events-none absolute inset-0 z-10">
        {comments.map((comment) => {
          const anchor = comment.anchor;
          if ((anchor.kind !== "page-text" && anchor.kind !== "page-area") || anchor.page !== page.n) {
            return null;
          }
          const active = comment.id === activeId;
          const resolved = comment.status === "resolved";
          if (resolved && !active) return null;
          const rects = anchor.kind === "page-text" ? anchor.rects : [anchor.rect];
          return rects.map((rect, index) => (
            <div
              key={`${comment.id}:${index}`}
              className={cn(
                "absolute rounded-[2px]",
                anchor.kind === "page-area"
                  ? active
                    ? "border-2 border-primary bg-primary/15"
                    : "border-2 border-primary/70 bg-primary/5"
                  : active
                    ? "bg-primary/35"
                    : "bg-primary/20",
              )}
              style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
            />
          ));
        })}
        {live && live.page === page.n
          ? live.rects.map((rect, index) => (
              <div
                key={`live:${index}`}
                className="absolute rounded-[2px] bg-primary/30"
                style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
              />
            ))
          : null}
        {pendingOnPage
          ? (pendingOnPage.kind === "page-text" ? pendingOnPage.rects : [pendingOnPage.rect]).map(
              (rect, index) => (
                <div
                  key={`pending:${index}`}
                  className={cn(
                    "absolute rounded-[2px]",
                    pendingOnPage.kind === "page-area"
                      ? "border-2 border-dashed border-primary bg-primary/10"
                      : "bg-primary/35",
                  )}
                  style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
                />
              ),
            )
          : null}
        {draftRect ? (
          <div
            className="absolute border-2 border-dashed border-primary bg-primary/10"
            style={{
              left: pct(draftRect.x),
              top: pct(draftRect.y),
              width: pct(draftRect.w),
              height: pct(draftRect.h),
            }}
          />
        ) : null}
      </div>

      {lines ? <TextLayer lines={lines} aspect={page.height / page.width} /> : null}

      <div className="pointer-events-none absolute inset-0 z-30">
        {comments.map((comment) => {
          const anchor = comment.anchor;
          if ((anchor.kind !== "page-text" && anchor.kind !== "page-area") || anchor.page !== page.n) {
            return null;
          }
          const active = comment.id === activeId;
          const resolved = comment.status === "resolved";
          if (resolved && !active) return null;
          const first = anchor.kind === "page-text" ? anchor.rects[0]! : anchor.rect;
          return (
            <Pin
              key={comment.id}
              seq={comment.seq}
              rect={first}
              active={active}
              resolved={resolved}
              onClick={() => onSelectComment(comment.id)}
            />
          );
        })}
      </div>

      {mode === "area" ? (
        <div
          className="absolute inset-0 z-20 cursor-crosshair touch-none"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const point = pointFor(event);
            setDraft({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
          }}
          onPointerMove={(event) => {
            if (!draft) return;
            const point = pointFor(event);
            setDraft((current) => (current ? { ...current, x1: point.x, y1: point.y } : current));
          }}
          onPointerUp={() => {
            const rect = draftRect;
            setDraft(null);
            if (rect && rect.w >= MIN_AREA && rect.h >= MIN_AREA && element.current) {
              onArea(page.n, rect, element.current);
            }
          }}
          onPointerCancel={() => setDraft(null)}
        />
      ) : null}

      <div className="pointer-events-none absolute bottom-1.5 right-2 z-30 rounded bg-background/80 px-1.5 text-[10px] tabular-nums text-muted-foreground">
        {page.n}
      </div>
    </div>
  );
}

export function PagesDoc({
  docId,
  kind,
  version,
  pages,
  mode,
  comments,
  activeId,
  scrollRequest,
  scroller,
  pendingAnchor,
  composer,
  composerPoint,
  onStale,
  onRequestComment,
  onSelectComment,
}: {
  docId: string;
  kind: DocKind;
  version: string;
  pages: PageInfo[];
  mode: PageMode;
  comments: ReviewComment[];
  activeId: string | null;
  scrollRequest: number;
  scroller: RefObject<HTMLElement | null>;
  pendingAnchor: Anchor | null;
  composer: ReactNode;
  composerPoint: Point | null;
  onStale: () => void;
  onRequestComment: (anchor: Anchor, point: Point) => void;
  onSelectComment: (id: string) => void;
}) {
  const rpc = useReviewRpc();
  const root = useRef<HTMLDivElement>(null);
  const [texts, setTexts] = useState<Map<number, PageWord[][]>>(new Map());
  const requested = useRef(new Set<number>());
  const [live, setLive] = useState<LiveSelection | null>(null);
  const [button, setButton] = useState<{ point: Point; anchor: Anchor } | null>(null);

  // Page text belongs to one file version.
  useEffect(() => {
    requested.current = new Set();
    setTexts(new Map());
  }, [docId, version]);

  const loadText = useCallback(
    (n: number) => {
      if (requested.current.has(n)) return;
      requested.current.add(n);
      rpc.call("doc.pageText", { docId, version, n }).then(
        (result) => setTexts((current) => new Map(current).set(n, result.lines)),
        (cause: unknown) => {
          requested.current.delete(n);
          if (/changed/i.test(errorText(cause))) onStale();
        },
      );
    },
    [rpc, docId, version, onStale],
  );

  /** Converts a point on a page element to coordinates inside the root. */
  const toRoot = useCallback((pageElement: HTMLElement, x: number, y: number): Point => {
    const rootBox = root.current!.getBoundingClientRect();
    const box = pageElement.getBoundingClientRect();
    return {
      top: box.top - rootBox.top + y * box.height + 8,
      left: Math.max(8, box.left - rootBox.left + x * box.width - 40),
    };
  }, []);

  // Text selections: read the selected words from the word layer.
  const computeSelection = useCallback((): (LiveSelection & { point: Point; anchor: Anchor }) | null => {
    const element = root.current;
    const selection = window.getSelection();
    if (!element || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!element.contains(range.commonAncestorContainer)) return null;
    const startNode = range.startContainer;
    const startElement = startNode instanceof Element ? startNode : startNode.parentElement;
    const pageElement = startElement?.closest<HTMLElement>("[data-page]");
    const n = Number(pageElement?.dataset.page);
    const lines = texts.get(n);
    if (!pageElement || !lines) return null;
    const spans = pageElement.querySelectorAll<HTMLElement>("[data-textlayer] > span");
    const picked = new Map<number, PageWord[]>();
    for (const span of spans) {
      if (!range.intersectsNode(span)) continue;
      const li = Number(span.dataset.li);
      const word = lines[li]?.[Number(span.dataset.wi)];
      if (!word) continue;
      picked.set(li, [...(picked.get(li) ?? []), word]);
    }
    if (picked.size === 0) return null;
    const ordered = [...picked.entries()].sort(([a], [b]) => a - b);
    const rects = ordered.map(([, words]) => unionRect(words));
    const quote = ordered.map(([, words]) => words.map((word) => word[4]).join(" ")).join("\n");
    const last = rects[rects.length - 1]!;
    return {
      page: n,
      rects,
      quote,
      point: toRoot(pageElement, last.x + last.w, last.y + last.h),
      anchor: { kind: "page-text", page: n, quote: quote.slice(0, 4000), rects: rects.slice(0, 200) },
    };
  }, [texts, toRoot]);

  const readSelection = useCallback(() => {
    const candidate = computeSelection();
    setLive(candidate ? { page: candidate.page, rects: candidate.rects, quote: candidate.quote } : null);
    setButton(candidate ? { point: candidate.point, anchor: candidate.anchor } : null);
  }, [computeSelection]);

  const commentOn = useCallback(
    (anchor: Anchor, point: Point) => {
      setButton(null);
      setLive(null);
      window.getSelection()?.removeAllRanges();
      onRequestComment(anchor, point);
    },
    [onRequestComment],
  );

  // Right-click on selected words offers Comment; elsewhere the usual menu stays.
  const [menu, setMenu] = useState<{ top: number; left: number; anchor: Anchor; quote: string } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (mode !== "text") return;
    const candidate = computeSelection();
    const element = root.current;
    if (!candidate || !element) return;
    event.preventDefault();
    const box = element.getBoundingClientRect();
    setMenu({
      top: event.clientY - box.top,
      left: Math.min(event.clientX - box.left, box.width - 190),
      anchor: candidate.anchor,
      quote: candidate.quote,
    });
  };

  // Cmd+Option+M comments on the current selection.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isCommentShortcut(event) || mode !== "text") return;
      const candidate = computeSelection();
      if (!candidate) return;
      event.preventDefault();
      commentOn(candidate.anchor, candidate.point);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [computeSelection, commentOn, mode]);

  useEffect(() => {
    let timer = 0;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(readSelection, 120);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [readSelection]);

  // Switching modes drops a half-made selection.
  useEffect(() => {
    setLive(null);
    setButton(null);
    window.getSelection()?.removeAllRanges();
  }, [mode]);

  const onArea = useCallback(
    (n: number, rect: Rect, pageElement: HTMLElement) => {
      const words = (texts.get(n) ?? []).flat().filter((word) => inside(rect, word));
      const text = words.map((word) => word[4]).join(" ").slice(0, 4000);
      onRequestComment(
        { kind: "page-area", page: n, rect, text },
        toRoot(pageElement, rect.x + rect.w, rect.y + rect.h),
      );
    },
    [texts, toRoot, onRequestComment],
  );

  // Scroll the active comment's page region into view when the list asks.
  useEffect(() => {
    if (!scrollRequest || !activeId) return;
    const comment = comments.find((candidate) => candidate.id === activeId);
    const anchor = comment?.anchor;
    if (!anchor || (anchor.kind !== "page-text" && anchor.kind !== "page-area")) return;
    const pageElement = root.current?.querySelector<HTMLElement>(`[data-page="${anchor.page}"]`);
    const container = scroller.current;
    if (!pageElement || !container) return;
    const rect = anchor.kind === "page-text" ? anchor.rects[0]! : anchor.rect;
    const box = pageElement.getBoundingClientRect();
    const view = container.getBoundingClientRect();
    const y = box.top + rect.y * box.height;
    if (y < view.top + 40 || y > view.bottom - 80) {
      container.scrollTo({ top: container.scrollTop + y - view.top - view.height / 3, behavior: "smooth" });
    }
  }, [scrollRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={root}
      className={cn(
        "doc-review-pages relative mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-4",
        mode === "area" && "select-none",
      )}
      onContextMenu={onContextMenu}
    >
      {menu ? (
        <SelectionMenu
          top={menu.top}
          left={menu.left}
          quote={menu.quote}
          onClose={closeMenu}
          onComment={() => commentOn(menu.anchor, { top: menu.top + 4, left: menu.left })}
        />
      ) : null}
      {pages.map((page) => (
        <PageView
          key={`${version}:${page.n}`}
          page={page}
          kind={kind}
          lines={texts.get(page.n)}
          mode={mode}
          comments={comments}
          activeId={activeId}
          live={live}
          pendingAnchor={pendingAnchor}
          onVisible={loadText}
          onStale={onStale}
          onSelectComment={onSelectComment}
          onArea={onArea}
        />
      ))}
      {button && !composer && mode === "text" ? (
        <button
          type="button"
          className="absolute z-40 inline-flex items-center gap-1.5 rounded-md border border-border bg-popover px-2.5 py-1 text-xs font-medium text-popover-foreground shadow-md hover:bg-accent"
          style={{ top: button.point.top, left: button.point.left }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            commentOn(button.anchor, button.point);
          }}
        >
          <Icon name="MessageSquarePlus" className="size-3.5" />
          Comment
        </button>
      ) : null}
      {composer && composerPoint ? (
        <div
          className="absolute z-50 w-[min(22rem,calc(100%-1rem))]"
          style={{
            top: composerPoint.top,
            left: `min(${Math.max(composerPoint.left, 8)}px, calc(100% - min(22rem, calc(100% - 1rem)) - 0.5rem))`,
          }}
        >
          {composer}
        </div>
      ) : null}
    </div>
  );
}
