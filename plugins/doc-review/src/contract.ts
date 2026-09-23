// RPC contract between the review panel (app.tsx) and the backend. app.tsx
// imports only its type, so zod never reaches the frontend bundle.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const rectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  })
  .strict();

const MAX_QUOTE = 4000;

export const anchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("doc") }).strict(),
  z
    .object({
      kind: z.literal("md-text"),
      quote: z.string().min(1).max(MAX_QUOTE),
      prefix: z.string().max(200),
      suffix: z.string().max(200),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("page-text"),
      page: z.number().int().min(1),
      quote: z.string().min(1).max(MAX_QUOTE),
      rects: z.array(rectSchema).min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("page-area"),
      page: z.number().int().min(1),
      rect: rectSchema,
      text: z.string().max(MAX_QUOTE),
    })
    .strict(),
]);

const statusSchema = z.enum(["draft", "sent", "replied", "resolved"]);

export const commentSchema = z.object({
  id: z.string(),
  seq: z.number(),
  status: statusSchema,
  anchor: anchorSchema,
  body: z.string(),
  docVersion: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  sentAt: z.number().nullable(),
  sentThreadId: z.string().nullable(),
  agentNote: z.string().nullable(),
  resolvedAt: z.number().nullable(),
});

const docSchema = z.object({
  id: z.string(),
  kind: z.enum(["md", "pdf", "pptx"]),
  name: z.string(),
  absPath: z.string(),
  hostId: z.string().nullable(),
  version: z.string(),
});

export const openerSourceSchema = z
  .object({
    kind: z.enum(["host", "thread-storage", "workspace"]),
    threadId: z.string().nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
    experimental_hostId: z.string().nullable().optional(),
  })
  .strip();

const sendTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("new-thread"),
      /** The thread the panel is open in, if any: its project and model are reused. */
      sourceThreadId: z.string().nullable(),
      projectId: z.string().nullable(),
      environmentId: z.string().nullable(),
    })
    .strict(),
]);

const BODY_MAX = 8000;

export const rpcContract = defineRpcContract({
  "doc.open": {
    input: z
      .object({ path: z.string().min(1), source: openerSourceSchema })
      .strict(),
    output: z.object({ doc: docSchema }),
  },
  "doc.get": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.object({ doc: docSchema }),
  },
  "docs.list": {
    input: z.null(),
    output: z.object({
      docs: z.array(
        z.object({
          id: z.string(),
          kind: z.enum(["md", "pdf", "pptx"]),
          name: z.string(),
          absPath: z.string(),
          hostId: z.string().nullable(),
          counts: z.object({
            draft: z.number(),
            sent: z.number(),
            replied: z.number(),
            resolved: z.number(),
          }),
          lastActivity: z.number(),
        }),
      ),
    }),
  },
  "doc.version": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.object({ version: z.string().nullable() }),
  },
  "doc.markdown": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.object({
      version: z.string(),
      content: z.string(),
      /** Base URL that serves files next to the document, for relative images. */
      assetBaseUrl: z.string().nullable(),
    }),
  },
  "doc.pages": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.object({
      version: z.string(),
      pages: z.array(
        z.object({
          n: z.number(),
          width: z.number(),
          height: z.number(),
          url: z.string(),
        }),
      ),
    }),
  },
  "doc.pageText": {
    input: z
      .object({
        docId: z.string(),
        version: z.string(),
        n: z.number().int().min(1),
      })
      .strict(),
    output: z.object({
      n: z.number(),
      lines: z.array(
        z.array(
          z.tuple([z.number(), z.number(), z.number(), z.number(), z.string()]),
        ),
      ),
    }),
  },
  "comments.list": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.object({ comments: z.array(commentSchema) }),
  },
  "comments.create": {
    input: z
      .object({
        docId: z.string(),
        anchor: anchorSchema,
        body: z.string().trim().min(1).max(BODY_MAX),
        docVersion: z.string().nullable(),
      })
      .strict(),
    output: commentSchema,
  },
  "comments.update": {
    input: z
      .object({ id: z.string(), body: z.string().trim().min(1).max(BODY_MAX) })
      .strict(),
    output: commentSchema,
  },
  "comments.delete": {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ deleted: z.boolean() }),
  },
  "comments.reopen": {
    input: z.object({ id: z.string() }).strict(),
    output: commentSchema,
  },
  "comments.send": {
    input: z
      .object({
        docId: z.string(),
        /** Omit to send every draft of the document. */
        ids: z.array(z.string()).max(500).optional(),
        target: sendTargetSchema,
      })
      .strict(),
    output: z.object({ threadId: z.string(), sent: z.number() }),
  },
  "comments.handoffPrompt": {
    input: z
      .object({ docId: z.string(), ids: z.array(z.string()).max(500).optional() })
      .strict(),
    output: z.object({ prompt: z.string(), ids: z.array(z.string()) }),
  },
  "comments.markSent": {
    input: z
      .object({ ids: z.array(z.string()).min(1).max(500), threadId: z.string().nullable() })
      .strict(),
    output: z.object({ sent: z.number() }),
  },
});

export type RpcContract = typeof rpcContract;
