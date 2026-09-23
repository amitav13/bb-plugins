// Shared, dependency-free types and helpers. Both server.ts and app.tsx import
// this module, so it must stay free of Node and zod imports.

export type DocKind = "md" | "pdf" | "pptx";

/** A rectangle in page coordinates normalized to 0..1 of the page size. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a comment points.
 * - `doc`: the whole document.
 * - `md-text`: selected text in a Markdown file, with its source line range.
 * - `page-text`: selected text on a PDF page or PPTX slide (1-based page).
 * - `page-area`: a drawn rectangle on a page, with the text found inside it.
 */
export type Anchor =
  | { kind: "doc" }
  | {
      kind: "md-text";
      quote: string;
      prefix: string;
      suffix: string;
      startLine: number;
      endLine: number;
    }
  | { kind: "page-text"; page: number; quote: string; rects: Rect[] }
  | { kind: "page-area"; page: number; rect: Rect; text: string };

/**
 * - `draft`: written, not handed to an agent yet.
 * - `sent`: handed to an agent, waiting for the fix.
 * - `replied`: the agent answered without fixing (a question or a refusal).
 * - `resolved`: the agent fixed it and left a note.
 */
export type CommentStatus = "draft" | "sent" | "replied" | "resolved";

export interface ReviewComment {
  id: string;
  /** Display number within the document: #1, #2, … */
  seq: number;
  status: CommentStatus;
  anchor: Anchor;
  body: string;
  /** Document version the comment was written against. */
  docVersion: string | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  sentThreadId: string | null;
  /** The agent's latest note: what it changed, or its question. */
  agentNote: string | null;
  resolvedAt: number | null;
}

export interface ReviewDoc {
  id: string;
  kind: DocKind;
  name: string;
  absPath: string;
  /** Null when the file lives on the bb server's own machine. */
  hostId: string | null;
  version: string;
}

export interface PageInfo {
  /** 1-based page (or slide) number. */
  n: number;
  /** Page size in PDF points. */
  width: number;
  height: number;
  /** Image URL for the rendered page. */
  url: string;
}

/** One word with its box normalized to the page: [x0, y0, x1, y1, text]. */
export type PageWord = [number, number, number, number, string];

export interface PageText {
  n: number;
  lines: PageWord[][];
}

export const DOC_EXTENSIONS: Record<string, DocKind> = {
  md: "md",
  markdown: "md",
  pdf: "pdf",
  pptx: "pptx",
};

export function docKindFor(path: string): DocKind | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  if (!match) return null;
  return DOC_EXTENSIONS[match[1]!.toLowerCase()] ?? null;
}

/** "Slide" for decks, "Page" for everything else. */
export function pageNoun(kind: DocKind): "Slide" | "Page" {
  return kind === "pptx" ? "Slide" : "Page";
}

/** A short human label for where a comment points. */
export function anchorLabel(anchor: Anchor, kind: DocKind): string {
  switch (anchor.kind) {
    case "doc":
      return "Whole document";
    case "md-text":
      return anchor.startLine === anchor.endLine
        ? `Line ${anchor.startLine}`
        : `Lines ${anchor.startLine}–${anchor.endLine}`;
    case "page-text":
      return `${pageNoun(kind)} ${anchor.page}`;
    case "page-area":
      return `${pageNoun(kind)} ${anchor.page}, area`;
  }
}

/** The quoted text a comment points at, if any. */
export function anchorQuote(anchor: Anchor): string | null {
  switch (anchor.kind) {
    case "md-text":
    case "page-text":
      return anchor.quote;
    case "page-area":
      return anchor.text || null;
    case "doc":
      return null;
  }
}

/** Collapse whitespace so quotes compare across line wrapping. */
export function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncate(text: string, max: number): string {
  const flat = squash(text);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
