// Page rendering on the bb server's machine: pages of a PDF (the document
// itself, or LibreOffice's rendering of a Word or PowerPoint file — see
// viewer.ts) rendered to PNG by poppler's pdftoppm on first request, word
// boxes from pdftotext for the selectable text layer, and crops for area
// comments. Output is cached per document version in the plugin's data dir.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseBboxLayout, type BboxPage } from "./bbox.js";
import type { Rect } from "./types.js";

export interface PageSize {
  width: number;
  height: number;
}

/** Rendered page width in pixels: sharp on a retina panel, small enough to stream. */
const PAGE_PIXEL_WIDTH = 1600;
const RENDER_TIMEOUT_MS = 60_000;
const VERSIONS_KEPT = 2;

export class ToolMissingError extends Error {}

function run(
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: options.env ?? process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new ToolMissingError(`${command} is not installed on the bb server`));
            return;
          }
          const detail = String(stderr || error.message).trim().split("\n").slice(-3).join(" ");
          reject(new Error(`${command} failed: ${detail}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

export class Renderer {
  /** Deduplicates concurrent work that produces the same file. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  /** Cache directory for one version of one document. */
  versionDir(docId: string, version: string): string {
    return path.join(this.root, "cache", docId, hashOf(version));
  }

  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = work().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  /** Drops cached versions of a document except the newest few. */
  private async pruneVersions(docId: string, keep: string): Promise<void> {
    const docDir = path.join(this.root, "cache", docId);
    const entries = await readdir(docDir).catch(() => [] as string[]);
    const dated = await Promise.all(
      entries.map(async (name) => {
        const full = path.join(docDir, name);
        const info = await stat(full).catch(() => null);
        return { full, mtime: info?.mtimeMs ?? 0 };
      }),
    );
    const stale = dated
      .filter((entry) => entry.full !== keep)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(VERSIONS_KEPT - 1);
    await Promise.all(stale.map((entry) => rm(entry.full, { recursive: true, force: true })));
  }

  /** Page sizes in points, rotation applied. */
  async pageSizes(docId: string, version: string, pdfPath: string): Promise<PageSize[]> {
    const dir = this.versionDir(docId, version);
    const cached = path.join(dir, "sizes.json");
    const hit = await readFile(cached, "utf8").then(
      (raw) => JSON.parse(raw) as PageSize[],
      () => null,
    );
    if (hit) return hit;
    return this.once(cached, async () => {
      await mkdir(dir, { recursive: true });
      await this.pruneVersions(docId, dir);
      const output = await run("pdfinfo", ["-f", "1", "-l", "100000", pdfPath], {
        timeoutMs: RENDER_TIMEOUT_MS,
      }).catch((error: unknown) => {
        if (error instanceof ToolMissingError) {
          throw new ToolMissingError(
            "Pages need poppler-utils on the bb server (pdfinfo, pdftoppm, pdftotext).",
          );
        }
        throw error;
      });
      const sizes = new Map<number, PageSize>();
      const rotations = new Map<number, number>();
      for (const line of output.split("\n")) {
        const size = /^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/.exec(line);
        if (size) {
          sizes.set(Number(size[1]), {
            width: Number.parseFloat(size[2]!),
            height: Number.parseFloat(size[3]!),
          });
          continue;
        }
        const rot = /^Page\s+(\d+)\s+rot:\s+(\d+)/.exec(line);
        if (rot) rotations.set(Number(rot[1]), Number(rot[2]));
      }
      const pages = [...sizes.entries()]
        .sort(([a], [b]) => a - b)
        .map(([n, size]) =>
          (rotations.get(n) ?? 0) % 180 === 90
            ? { width: size.height, height: size.width }
            : size,
        );
      if (pages.length === 0) throw new Error("This PDF has no pages.");
      await mkdir(dir, { recursive: true });
      await writeFile(cached, JSON.stringify(pages));
      return pages;
    });
  }

  /** Renders one page to PNG once per version; returns the image path. */
  async pageImage(docId: string, version: string, pdfPath: string, n: number): Promise<string> {
    const dir = this.versionDir(docId, version);
    const target = path.join(dir, `page-${n}.png`);
    if (await exists(target)) return target;
    return this.once(target, async () => {
      await mkdir(dir, { recursive: true });
      const prefix = path.join(dir, `render-${n}-${process.pid}`);
      await run(
        "pdftoppm",
        [
          "-png",
          "-f",
          String(n),
          "-l",
          String(n),
          "-singlefile",
          "-scale-to-x",
          String(PAGE_PIXEL_WIDTH),
          "-scale-to-y",
          "-1",
          pdfPath,
          prefix,
        ],
        { timeoutMs: RENDER_TIMEOUT_MS },
      );
      await rename(`${prefix}.png`, target);
      return target;
    });
  }

  /** Word boxes for one page, cached as JSON. */
  async pageText(docId: string, version: string, pdfPath: string, n: number): Promise<BboxPage> {
    const dir = this.versionDir(docId, version);
    const cached = path.join(dir, `text-${n}.json`);
    const hit = await readFile(cached, "utf8").then(
      (raw) => JSON.parse(raw) as BboxPage,
      () => null,
    );
    if (hit) return hit;
    return this.once(cached, async () => {
      const xhtml = await run(
        "pdftotext",
        ["-bbox-layout", "-f", String(n), "-l", String(n), pdfPath, "-"],
        { timeoutMs: RENDER_TIMEOUT_MS },
      );
      const page = parseBboxLayout(xhtml)[0] ?? { width: 0, height: 0, lines: [] };
      await mkdir(dir, { recursive: true });
      await writeFile(cached, JSON.stringify(page));
      return page;
    });
  }

  /**
   * Crops a region of a page to PNG at a resolution that keeps small regions
   * legible and large ones reasonable. Returns the image bytes.
   */
  async crop(pdfPath: string, n: number, size: PageSize, rect: Rect): Promise<Buffer> {
    const widthInches = size.width / 72;
    const heightInches = size.height / 72;
    const regionInches = Math.max(rect.w * widthInches, 0.01);
    // Aim for ~1200 px across the region, between 96 and 300 dpi.
    const dpi = Math.round(Math.min(300, Math.max(96, 1200 / regionInches)));
    const pageWidth = widthInches * dpi;
    const pageHeight = heightInches * dpi;
    const x = Math.max(0, Math.floor(rect.x * pageWidth));
    const y = Math.max(0, Math.floor(rect.y * pageHeight));
    const w = Math.max(1, Math.min(Math.ceil(rect.w * pageWidth), Math.ceil(pageWidth) - x));
    const h = Math.max(1, Math.min(Math.ceil(rect.h * pageHeight), Math.ceil(pageHeight) - y));
    const dir = path.join(this.root, "crops");
    await mkdir(dir, { recursive: true });
    const prefix = path.join(dir, `crop-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await run(
      "pdftoppm",
      [
        "-png",
        "-f",
        String(n),
        "-l",
        String(n),
        "-singlefile",
        "-r",
        String(dpi),
        "-x",
        String(x),
        "-y",
        String(y),
        "-W",
        String(w),
        "-H",
        String(h),
        pdfPath,
        prefix,
      ],
      { timeoutMs: RENDER_TIMEOUT_MS },
    );
    const file = `${prefix}.png`;
    try {
      return await readFile(file);
    } finally {
      await rm(file, { force: true });
    }
  }
}
