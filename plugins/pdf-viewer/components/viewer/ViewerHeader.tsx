import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { DocumentFamily } from "@/lib/formats";
import { familyIcon } from "./family";
import type { ViewerLinks } from "./use-viewer";

export function ViewerHeader({
  name,
  path,
  family,
  note,
  links,
  onBack,
  onReload,
  isReloading,
}: {
  name: string;
  path: string;
  family: DocumentFamily | null;
  /** A short muted remark after the name, e.g. that this is a PDF rendering. */
  note?: string;
  links: ViewerLinks | null;
  onBack?: () => void;
  onReload: () => void;
  isReloading: boolean;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
      {onBack ? (
        <Button size="sm" variant="ghost" onClick={onBack} aria-label="Back to files">
          <Icon name="ChevronLeft" aria-hidden />
        </Button>
      ) : null}
      <Icon
        name={familyIcon(family)}
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="min-w-0 truncate text-sm font-medium" title={path}>
        {name}
      </span>
      {note ? (
        <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
          {note}
        </span>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={onReload}
          disabled={isReloading}
          aria-label="Reload document"
        >
          <Icon
            name="RotateCcw"
            className={isReloading ? "animate-spin" : undefined}
            aria-hidden
          />
        </Button>
        {links?.document ? (
          <Button size="sm" variant="ghost" asChild>
            <a
              href={links.document.url}
              target="_blank"
              rel="noreferrer"
              aria-label="Open in a new tab"
              title="Open in a new tab"
            >
              <Icon name="ExternalLink" aria-hidden />
            </a>
          </Button>
        ) : null}
        {links ? (
          <Button size="sm" variant="ghost" asChild>
            <a
              href={links.download.url}
              download={name}
              aria-label={`Download ${name}`}
              title={`Download ${name}`}
            >
              <Icon name="Download" aria-hidden />
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
