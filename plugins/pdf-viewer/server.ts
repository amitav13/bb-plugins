// bb-plugin-pdf-viewer — backend entry.
//
// The viewer shows PDFs, Word and PowerPoint files, and spreadsheets. The
// frontend never reads document bytes through rpc: a PDF — including one
// LibreOffice made out of a Word or PowerPoint file — travels as a
// short-lived URL, and a spreadsheet travels as a bounded grid model parsed
// here, one sheet at a time.
import { copyFile, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  contentTypeFor,
  documentFamily,
  extensionOf,
  isOoxmlSpreadsheetPath,
  isSupportedPath,
} from "./lib/formats.js";
import {
  baseName,
  directoryName,
  joinPath,
  pdfNameFor,
  previewUrlFor,
} from "./lib/pdf-paths.js";
import type { SheetData } from "./lib/sheet-model.js";
import { cacheKey, ConversionCache } from "./src/conversion-cache.js";
import { DocumentRegistry } from "./src/documents.js";
import { DOCUMENT_ROUTE, handleDocumentRequest } from "./src/http-routes.js";
import { LeaseCache } from "./src/lease-cache.js";
import {
  findLibreOffice,
  LibreOfficeRunner,
  type LibreOfficeInstall,
} from "./src/libreoffice.js";
import { openSpreadsheet, type SpreadsheetReader } from "./src/spreadsheet/index.js";

const LINK_TTL_MS = 60 * 60 * 1000;
/**
 * bb's file-preview route reads a whole file into memory and refuses anything
 * past this size, so bigger files fall back to this plugin's own ranged
 * stream. Preview is preferred below the ceiling because it is bb's native
 * transport: it reaches other hosts and keeps working when the app is open
 * remotely through bb connect.
 */
const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
const RECENTS_KEY = "recent-documents";
const RECENTS_LIMIT = 12;
/** Bump when conversion output changes, so older cache entries miss. */
const CONVERTER_VERSION = 1;
const CONVERSION_TIMEOUT_MS = 3 * 60 * 1000;
/** Past this LibreOffice needs minutes and gigabytes; the viewer declines. */
const CONVERSION_MAX_BYTES = 150 * 1024 * 1024;
/** A file on another host is copied over rpc in one piece; this bounds it. */
const REMOTE_MAX_BYTES = 64 * 1024 * 1024;
const CONVERTED_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
const CONVERTED_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REMOTE_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const REMOTE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How long a LibreOffice lookup is trusted before PATH is searched again. */
const LIBREOFFICE_LOOKUP_TTL_MS = 30 * 1000;

const fileOpenerSourceSchema = z
  .object({
    kind: z.enum(["host", "thread-storage", "workspace"]),
    threadId: z.string().nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
    experimental_hostId: z.string().optional(),
  })
  .strict();

/**
 * Where a file lives: an absolute path on a host (the nav panel), or a
 * file opener's path whose meaning depends on its source.
 */
const targetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("host"),
      path: z.string().min(1),
      hostId: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("opened"),
      path: z.string().min(1),
      source: fileOpenerSourceSchema,
    })
    .strict(),
]);

type Target = z.infer<typeof targetSchema>;

const linkSchema = z.object({ url: z.string(), expiresAtMs: z.number() });

type Link = z.infer<typeof linkSchema>;

const familySchema = z.enum(["pdf", "text", "presentation", "spreadsheet"]);

const fileSchema = z.object({
  name: z.string(),
  path: z.string(),
  hostId: z.string().nullable(),
  family: familySchema,
});

const workbookSummarySchema = z.object({
  sheets: z.array(
    z.object({
      name: z.string(),
      hidden: z.boolean(),
      kind: z.enum(["worksheet", "chartsheet", "other"]),
    }),
  ),
  activeSheet: z.number().int(),
});

/**
 * The readers build the grid; validating up to 100k cells field by field on
 * every response would cost more than it protects.
 */
const sheetDataSchema = z.custom<SheetData>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { rows?: unknown }).rows),
);

/** BCP 47 tag from the browser; formats dates and numbers like Excel would there. */
const localeSchema = z.string().max(64).optional();

const openResultSchema = z.discriminatedUnion("view", [
  z.object({
    view: z.literal("pdf"),
    file: fileSchema,
    document: linkSchema,
    download: linkSchema,
    /** True when LibreOffice made the PDF out of a Word or PowerPoint file. */
    converted: z.boolean(),
  }),
  z.object({
    view: z.literal("spreadsheet"),
    file: fileSchema,
    download: linkSchema,
    workbook: workbookSummarySchema,
    sheet: sheetDataSchema,
    /** "basic" when only values and fills could be read. */
    fidelity: z.enum(["full", "basic"]),
  }),
  z.object({
    view: z.literal("needs-libreoffice"),
    file: fileSchema,
    download: linkSchema,
    /** The LibreOffice module this file needs. */
    component: z.enum(["writer", "impress"]),
    /** False when no LibreOffice was found at all. */
    installed: z.boolean(),
    /** The server's platform: install instructions are for that machine. */
    platform: z.enum(["linux", "darwin", "win32", "other"]),
  }),
]);

const recentSchema = z.object({
  path: z.string(),
  name: z.string(),
  hostId: z.string().nullable(),
  openedAtMs: z.number(),
});

export const rpcContract = defineRpcContract({
  hosts: {
    input: z.null(),
    output: z.object({
      hosts: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          status: z.enum(["connected", "disconnected"]),
        }),
      ),
    }),
  },
  browse: {
    input: z
      .object({
        hostId: z.string().nullable().optional(),
        path: z.string().nullable().optional(),
      })
      .strict(),
    output: z.object({
      hostId: z.string(),
      directory: z.string(),
      parent: z.string().nullable(),
      entries: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          kind: z.enum(["directory", "file"]),
        }),
      ),
    }),
  },
  // Everything the viewer needs to show one file.
  open: {
    input: z.object({ target: targetSchema, locale: localeSchema }).strict(),
    output: openResultSchema,
  },
  // One more sheet of a workbook already opened.
  sheet: {
    input: z
      .object({
        target: targetSchema,
        index: z.number().int().min(0),
        locale: localeSchema,
      })
      .strict(),
    output: z.object({ sheet: sheetDataSchema }),
  },
  // Fresh URLs for an open viewer, minted before the old ones lapse.
  links: {
    input: z.object({ target: targetSchema }).strict(),
    output: z.object({
      document: linkSchema.nullable(),
      download: linkSchema,
    }),
  },
  recents: {
    input: z.null(),
    output: z.object({ recents: z.array(recentSchema) }),
  },
  forgetRecents: {
    input: z.null(),
    output: z.object({ recents: z.array(recentSchema) }),
  },
});

/** Wire types the frontend imports as types only. */
export type ViewerTarget = Target;
export type OpenResult = z.infer<typeof openResultSchema>;
export type ViewerLink = Link;
export type RecentDocument = z.infer<typeof recentSchema>;

interface ResolvedFile {
  absolutePath: string;
  /** Undefined for the server's own host. */
  hostId: string | undefined;
}

/** A file readable on the server's own disk: the original, or a copy of a remote one. */
interface LocalFile {
  path: string;
  /** Changes whenever the file's content can have changed. */
  identity: string;
  sizeBytes: number;
}

interface Runtime {
  conversions: ConversionCache;
  remoteCopies: ConversionCache;
  runner: LibreOfficeRunner;
}

export default async function plugin(bb: BbPluginApi) {
  const registry = new DocumentRegistry({ ttlMs: LINK_TTL_MS });
  const workbooks = new LeaseCache<SpreadsheetReader>({
    maxEntries: 4,
    idleMs: 10 * 60 * 1000,
  });
  const sweepTimer = setInterval(() => workbooks.sweep(), 60 * 1000);
  sweepTimer.unref();
  let runner: LibreOfficeRunner | null = null;
  bb.onDispose(() => {
    clearInterval(sweepTimer);
    registry.clear();
    workbooks.clear();
    runner?.dispose();
  });

  bb.http.route("GET", DOCUMENT_ROUTE, (context) =>
    handleDocumentRequest(context, registry),
  );

  const settings = bb.settings.define({
    rememberRecents: {
      type: "boolean",
      label: "Remember recently opened documents",
      default: true,
    },
    libreOfficePath: {
      type: "string",
      label: "LibreOffice executable",
      description:
        "Word and PowerPoint files are converted with LibreOffice on the machine bb runs on. Leave empty to find it automatically; set the full path to soffice if it lives somewhere unusual.",
      default: "",
    },
  });

  /** The host the nav panel browses when the user has not picked one. */
  async function defaultHostId(): Promise<string> {
    const hosts = await bb.sdk.hosts.list();
    const connected = hosts.find((host) => host.status === "connected");
    const host = connected ?? hosts[0];
    if (!host) throw new Error("No host is available to browse.");
    return host.id;
  }

  /**
   * The id of the host the server itself runs on, read once from its data
   * directory. Only a file on that host can be read from local disk.
   */
  let localHostIdPromise: Promise<string | null> | null = null;
  function localHostId(): Promise<string | null> {
    localHostIdPromise ??= (async () => {
      try {
        const config = await bb.sdk.system.config();
        const raw = await readFile(path.join(config.dataDir, "host-id"), "utf8");
        return raw.trim() || null;
      } catch (cause: unknown) {
        bb.log.warn(`could not resolve the local host id: ${String(cause)}`);
        return null;
      }
    })();
    return localHostIdPromise;
  }

  async function isLocal(hostId: string | undefined): Promise<boolean> {
    return !hostId || hostId === (await localHostId());
  }

  /** Cache folders and the converter, created on first use. */
  let runtimePromise: Promise<Runtime> | null = null;
  function runtime(): Promise<Runtime> {
    runtimePromise ??= (async () => {
      const config = await bb.sdk.system.config();
      const root = path.join(config.dataDir, "plugins", bb.pluginId, "cache");
      await mkdir(root, { recursive: true });
      runner = new LibreOfficeRunner({
        profileDir: path.join(root, "libreoffice-profile"),
        timeoutMs: CONVERSION_TIMEOUT_MS,
      });
      const conversions = new ConversionCache({
        root: path.join(root, "converted"),
        maxBytes: CONVERTED_CACHE_MAX_BYTES,
        maxAgeMs: CONVERTED_CACHE_MAX_AGE_MS,
      });
      const remoteCopies = new ConversionCache({
        root: path.join(root, "remote"),
        maxBytes: REMOTE_CACHE_MAX_BYTES,
        maxAgeMs: REMOTE_CACHE_MAX_AGE_MS,
      });
      void conversions.prune();
      void remoteCopies.prune();
      return { conversions, remoteCopies, runner };
    })().catch((cause: unknown) => {
      runtimePromise = null;
      throw cause;
    });
    return runtimePromise;
  }

  let libreOfficeLookup: {
    override: string;
    atMs: number;
    install: Promise<LibreOfficeInstall | null>;
  } | null = null;
  async function libreOffice(): Promise<LibreOfficeInstall | null> {
    const { libreOfficePath } = await settings.get();
    const override = libreOfficePath.trim();
    const now = Date.now();
    if (
      !libreOfficeLookup ||
      libreOfficeLookup.override !== override ||
      now - libreOfficeLookup.atMs > LIBREOFFICE_LOOKUP_TTL_MS
    ) {
      libreOfficeLookup = {
        override,
        atMs: now,
        install: findLibreOffice(override || undefined),
      };
    }
    return await libreOfficeLookup.install;
  }

  /**
   * Resolves a target to an absolute path plus the host it lives on.
   * Workspace paths are worktree-relative, thread-storage paths are relative
   * to the thread's storage root, and host paths are already absolute.
   */
  async function resolveTarget(target: Target): Promise<ResolvedFile> {
    if (target.kind === "host") {
      return {
        absolutePath: target.path,
        hostId: target.hostId ?? (await defaultHostId()),
      };
    }

    const { path: filePath, source } = target;
    if (source.kind === "workspace") {
      if (source.environmentId) {
        const environment = await bb.sdk.environments.get({
          environmentId: source.environmentId,
        });
        if (!environment.path) {
          throw new Error("This environment has no checkout on disk yet.");
        }
        return {
          absolutePath: joinPath(environment.path, filePath),
          hostId: environment.hostId,
        };
      }
      // A project's own checkout, opened outside any thread.
      if (source.projectId) {
        const project = await bb.sdk.projects.get({ projectId: source.projectId });
        const checkout =
          project.sources.find(
            (candidate) => candidate.hostId === source.experimental_hostId,
          ) ??
          project.sources.find((candidate) => candidate.isDefault) ??
          project.sources[0];
        if (!checkout) {
          throw new Error("This project has no checkout on any host.");
        }
        return {
          absolutePath: joinPath(checkout.path, filePath),
          hostId: checkout.hostId,
        };
      }
      throw new Error("This workspace file has no environment.");
    }

    if (source.kind === "thread-storage") {
      if (!source.threadId) {
        throw new Error("This stored file has no thread.");
      }
      // Only the storage root matters here, so ask for no entries at all.
      const storage = await bb.sdk.threads.storagePaths({
        threadId: source.threadId,
        includeFiles: "false",
        includeDirectories: "false",
      });
      return {
        absolutePath: joinPath(storage.storageRootPath, filePath),
        hostId: undefined,
      };
    }

    // A host path is absolute already; the environment only names its host.
    if (!source.environmentId) return { absolutePath: filePath, hostId: undefined };
    const environment = await bb.sdk.environments.get({
      environmentId: source.environmentId,
    });
    return { absolutePath: filePath, hostId: environment.hostId };
  }

  /** Mints a URL for one file: local disk when it must, bb preview otherwise. */
  async function mintLink(
    absolutePath: string,
    hostId: string | undefined,
  ): Promise<Link> {
    // Streaming from local disk lets the browser fetch ranges and has no size
    // ceiling, so it carries the files preview cannot.
    if (await isLocal(hostId)) {
      const stats = await stat(absolutePath).catch(() => null);
      if (stats?.isFile() && stats.size > PREVIEW_MAX_BYTES) {
        const { id, expiresAtMs } = registry.register({
          path: absolutePath,
          name: baseName(absolutePath),
          sizeBytes: stats.size,
          contentType: contentTypeFor(absolutePath),
        });
        return {
          url: `/api/v1/plugins/${bb.pluginId}/http${DOCUMENT_ROUTE}?id=${id}`,
          expiresAtMs,
        };
      }
    }

    // Name the server's own host explicitly: with several hosts connected,
    // "no host" need not mean this machine.
    const previewHost = hostId ?? (await localHostId()) ?? undefined;
    const preview = await bb.sdk.files.createPreview({
      ...(previewHost ? { hostId: previewHost } : {}),
      rootPath: directoryName(absolutePath),
      ttlMs: LINK_TTL_MS,
    });
    return {
      url: previewUrlFor(preview.baseUrl, baseName(absolutePath)),
      expiresAtMs: preview.expiresAtMs,
    };
  }

  /** The file on this server's disk, copying it over from another host if needed. */
  async function localFile(resolved: ResolvedFile): Promise<LocalFile> {
    if (await isLocal(resolved.hostId)) {
      const stats = await stat(resolved.absolutePath).catch(() => null);
      if (!stats?.isFile()) {
        throw new Error(`File not found: ${resolved.absolutePath}`);
      }
      return {
        path: resolved.absolutePath,
        identity: cacheKey([
          "local",
          resolved.absolutePath,
          stats.size,
          stats.mtimeMs,
        ]),
        sizeBytes: stats.size,
      };
    }

    const read = await bb.sdk.files.read({
      hostId: resolved.hostId,
      path: resolved.absolutePath,
    });
    if (read.sizeBytes > REMOTE_MAX_BYTES) {
      throw new Error(
        `This file is ${megabytes(read.sizeBytes)} MB on another host; the viewer copies files up to ${megabytes(REMOTE_MAX_BYTES)} MB from there. Download it instead.`,
      );
    }
    const identity = cacheKey(["remote", read.sha256]);
    const { remoteCopies } = await runtime();
    const copy = await remoteCopies.getOrCreate(
      identity,
      `source.${extensionOf(resolved.absolutePath) || "bin"}`,
      async (staging) => {
        const file = path.join(staging, "file");
        await writeFile(file, Buffer.from(read.content, read.contentEncoding));
        return file;
      },
    );
    return { path: copy, identity, sizeBytes: read.sizeBytes };
  }

  /**
   * Converts a Word or PowerPoint file to PDF, or says which LibreOffice
   * module is missing. The output is cached per file version.
   */
  async function convertedPdf(
    file: LocalFile,
    originalName: string,
    family: "text" | "presentation",
  ): Promise<string | { component: "writer" | "impress"; installed: boolean }> {
    const component = family === "presentation" ? "impress" : "writer";
    const install = await libreOffice();
    if (!install?.components[component]) {
      return { component, installed: install !== null };
    }
    if (file.sizeBytes > CONVERSION_MAX_BYTES) {
      throw new Error(
        `This file is ${megabytes(file.sizeBytes)} MB; the viewer converts files up to ${megabytes(CONVERSION_MAX_BYTES)} MB. Download it instead.`,
      );
    }
    const { conversions, runner: converter } = await runtime();
    return await conversions.getOrCreate(
      cacheKey(["pdf", CONVERTER_VERSION, file.identity]),
      pdfNameFor(originalName),
      (staging) =>
        convertInStaging(converter, install, file.path, originalName, staging, "pdf"),
    );
  }

  /**
   * Opens a workbook. Legacy formats (xls, xlsb, ods) go through LibreOffice
   * into xlsx when Calc is installed, so they render with full formatting;
   * without it the reader falls back to values and fills.
   */
  async function openWorkbook(
    file: LocalFile,
    originalPath: string,
    locale: string,
  ): Promise<SpreadsheetReader> {
    let source = file.path;
    if (!isOoxmlSpreadsheetPath(originalPath)) {
      const install = await libreOffice();
      if (install?.components.calc && file.sizeBytes <= CONVERSION_MAX_BYTES) {
        try {
          const { conversions, runner: converter } = await runtime();
          source = await conversions.getOrCreate(
            cacheKey(["xlsx", CONVERTER_VERSION, file.identity]),
            "workbook.xlsx",
            (staging) =>
              convertInStaging(
                converter,
                install,
                file.path,
                baseName(originalPath),
                staging,
                "xlsx",
              ),
          );
        } catch (cause: unknown) {
          bb.log.warn(
            `LibreOffice could not convert ${originalPath}; reading it directly: ${String(cause)}`,
          );
        }
      }
    }
    return await openSpreadsheet(source, { locale });
  }

  function withWorkbook<R>(
    resolved: ResolvedFile,
    locale: string,
    use: (reader: SpreadsheetReader) => Promise<R>,
  ): Promise<R> {
    return localFile(resolved).then((file) =>
      workbooks.use(
        `${file.identity}:${locale}`,
        () => openWorkbook(file, resolved.absolutePath, locale),
        use,
      ),
    );
  }

  async function readRecents(): Promise<z.infer<typeof recentSchema>[]> {
    return (
      (await bb.storage.kv.get<z.infer<typeof recentSchema>[]>(RECENTS_KEY)) ??
      []
    );
  }

  async function rememberDocument(document: {
    path: string;
    name: string;
    hostId: string | null;
  }): Promise<void> {
    const { rememberRecents } = await settings.get();
    if (!rememberRecents) return;
    const previous = await readRecents();
    const next = [
      { ...document, openedAtMs: Date.now() },
      ...previous.filter(
        (entry) =>
          entry.path !== document.path || entry.hostId !== document.hostId,
      ),
    ].slice(0, RECENTS_LIMIT);
    await bb.storage.kv.set(RECENTS_KEY, next);
  }

  bb.rpc.register(rpcContract, {
    async hosts() {
      const hosts = await bb.sdk.hosts.list();
      return {
        hosts: hosts.map((host) => ({
          id: host.id,
          name: host.name,
          status: host.status,
        })),
      };
    },

    async browse({ hostId, path: directory }) {
      const targetHost = hostId ?? (await defaultHostId());
      const listing = await bb.sdk.hosts.directory({
        hostId: targetHost,
        ...(directory ? { path: directory } : {}),
      });
      return {
        hostId: targetHost,
        directory: listing.directory,
        parent: listing.parent,
        entries: listing.entries
          .filter(
            (entry) => entry.kind === "directory" || isSupportedPath(entry.name),
          )
          .sort((left, right) => {
            if (left.kind !== right.kind) {
              return left.kind === "directory" ? -1 : 1;
            }
            return left.name.localeCompare(right.name);
          }),
      };
    },

    async open({ target, locale }): Promise<OpenResult> {
      const resolved = await resolveTarget(target);
      const family = documentFamily(resolved.absolutePath);
      const name = baseName(resolved.absolutePath);
      if (!family) {
        throw new Error(`The viewer does not open this kind of file: ${name}`);
      }
      const file = {
        name,
        path: resolved.absolutePath,
        hostId: resolved.hostId ?? null,
        family,
      };
      const download = await mintLink(resolved.absolutePath, resolved.hostId);
      const remember = async () => {
        // Only the panel's opens are remembered: its paths are absolute on a
        // known host, so a recent entry can be reopened from anywhere.
        if (target.kind === "host") {
          await rememberDocument({ path: file.path, name, hostId: file.hostId });
        }
      };

      if (family === "pdf") {
        await remember();
        return { view: "pdf", file, document: download, download, converted: false };
      }

      if (family === "spreadsheet") {
        const result = await withWorkbook(
          resolved,
          normalizeLocale(locale),
          async (reader): Promise<OpenResult> => ({
            view: "spreadsheet",
            file,
            download,
            workbook: reader.summary,
            sheet: await reader.readSheet(reader.summary.activeSheet),
            fidelity: reader.fidelity,
          }),
        );
        await remember();
        return result;
      }

      const converted = await convertedPdf(await localFile(resolved), name, family);
      if (typeof converted !== "string") {
        return {
          view: "needs-libreoffice",
          file,
          download,
          ...converted,
          platform: serverPlatform(),
        };
      }
      const document = await mintLink(converted, undefined);
      await remember();
      return { view: "pdf", file, document, download, converted: true };
    },

    async sheet({ target, index, locale }) {
      const resolved = await resolveTarget(target);
      return await withWorkbook(resolved, normalizeLocale(locale), async (reader) => {
        if (index >= reader.summary.sheets.length) {
          throw new Error("This workbook has no such sheet.");
        }
        return { sheet: await reader.readSheet(index) };
      });
    },

    async links({ target }) {
      const resolved = await resolveTarget(target);
      const family = documentFamily(resolved.absolutePath);
      const download = await mintLink(resolved.absolutePath, resolved.hostId);
      if (family === "pdf") return { document: download, download };
      if (family === "text" || family === "presentation") {
        const converted = await convertedPdf(
          await localFile(resolved),
          baseName(resolved.absolutePath),
          family,
        );
        return {
          document:
            typeof converted === "string"
              ? await mintLink(converted, undefined)
              : null,
          download,
        };
      }
      return { document: null, download };
    },

    async recents() {
      return { recents: await readRecents() };
    },

    async forgetRecents() {
      await bb.storage.kv.set(RECENTS_KEY, []);
      return { recents: [] };
    },
  });

  bb.log.info("pdf-viewer ready");
}

/**
 * Runs one LibreOffice conversion inside a staging directory. The input is
 * linked in under a neutral name, so LibreOffice's lock file and any odd
 * characters in the real name stay out of the user's folder and out of the
 * command line.
 */
async function convertInStaging(
  converter: LibreOfficeRunner,
  install: LibreOfficeInstall,
  sourcePath: string,
  originalName: string,
  staging: string,
  format: "pdf" | "xlsx",
): Promise<string> {
  const input = path.join(staging, `source.${extensionOf(originalName) || "bin"}`);
  await symlink(sourcePath, input).catch(() => copyFile(sourcePath, input));
  const outDir = path.join(staging, "out");
  await mkdir(outDir);
  return await converter.convert({ install, input, outDir, format });
}

function serverPlatform(): "linux" | "darwin" | "win32" | "other" {
  const { platform } = process;
  return platform === "linux" || platform === "darwin" || platform === "win32"
    ? platform
    : "other";
}

function normalizeLocale(locale: string | undefined): string {
  if (!locale) return "en-US";
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? "en-US";
  } catch {
    return "en-US";
  }
}

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}
