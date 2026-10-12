export interface PageRef {
  id: number;
  name?: string;
}

export interface PageEntity {
  id?: number;
  uuid?: string;
  name?: string;
  originalName?: string;
  "original-name"?: string;
  journal?: boolean;
  "journal?"?: boolean;
  journalDay?: number | null;
  "journal-day"?: number | null;
  properties?: Record<string, unknown>;
  namespace?: string | PageRef | number;
  [key: string]: unknown;
}

export interface BlockEntity {
  id?: number;
  uuid?: string;
  content?: string;
  format?: string;
  marker?: string | null;
  priority?: string | null;
  page?: PageRef | number | null;
  parent?: PageRef | number | null;
  left?: PageRef | number | null;
  children?: BlockEntity[];
  properties?: Record<string, unknown>;
  refs?: unknown[];
  pathRefs?: unknown[];
  "path-refs"?: unknown[];
  "pre-block?"?: boolean;
  [key: string]: unknown;
}

export function displayName(page: PageEntity): string {
  return page.originalName || page["original-name"] || page.name || "";
}

export function isJournal(page: PageEntity): boolean {
  return !!(page.journal || page["journal?"]);
}

export function coercePage(raw: any): PageEntity {
  if (!raw || typeof raw !== "object") return {};
  const p: PageEntity = { ...raw };
  if (p.namespace && typeof p.namespace === "object") {
    p.namespace = (p.namespace as PageEntity).name || "";
  } else if (typeof p.namespace === "number") {
    p.namespace = "";
  }
  return p;
}

export function coerceBlock(raw: any): BlockEntity {
  if (!raw || typeof raw !== "object") return {};
  const b: BlockEntity = { ...raw };
  if (Array.isArray(b.children)) {
    // Compact children format [["uuid", value]] — preserve it instead of
    // dropping it silently: map each pair to a minimal block so the data
    // survives into the dump (content kept when it is a string).
    if (b.children.length && Array.isArray(b.children[0])) {
      b.children = (b.children as unknown as unknown[][])
        .filter((pair) => Array.isArray(pair))
        .map((pair) => {
          const uuid = typeof pair[0] === "string" ? pair[0] : undefined;
          const value = pair[1];
          const content = typeof value === "string" ? value : value && typeof value === "object" ? "" : String(value ?? "");
          return coerceBlock({ uuid, content });
        });
    } else {
      b.children = b.children.filter((c: any) => c && typeof c === "object").map(coerceBlock);
    }
  } else {
    b.children = [];
  }
  return b;
}

function dumpBlockRef(ref: unknown): { id: number } | null {
  if (ref === null || ref === undefined) return null;
  if (typeof ref === "number") return { id: ref };
  if (typeof ref === "object") return { id: (ref as any).id ?? 0 };
  return null;
}

function dumpPageRef(ref: unknown): { id: number; name: string } | null {
  if (ref === null || ref === undefined) return null;
  if (typeof ref === "number") return { id: ref, name: "" };
  if (typeof ref === "object") return { id: (ref as any).id ?? 0, name: (ref as any).name || "" };
  return null;
}

/**
 * Dump a page into the upstream (Pydantic `model_dump(by_alias=False)`) shape:
 * snake_case field names, only declared fields. `name` remains the canonical
 * (lowercased) storage name; callers that want the display name override it.
 */
export function dumpPage(page: PageEntity): Record<string, unknown> {
  return {
    id: page.id ?? 0,
    uuid: page.uuid ?? "",
    name: page.name ?? "",
    original_name: page.originalName ?? page["original-name"] ?? "",
    journal: isJournal(page),
    journal_day: page.journalDay ?? page["journal-day"] ?? null,
    properties: page.properties ?? {},
    namespace: typeof page.namespace === "string" ? page.namespace : "",
  };
}

export function dumpBlock(block: BlockEntity): Record<string, unknown> {
  return {
    id: block.id ?? 0,
    uuid: block.uuid ?? "",
    content: block.content ?? "",
    format: block.format ?? "markdown",
    marker: block.marker ?? null,
    priority: block.priority ?? null,
    page: dumpPageRef(block.page),
    parent: dumpBlockRef(block.parent),
    left: dumpBlockRef(block.left),
    children: (block.children || []).map(dumpBlock),
    properties: block.properties ?? {},
    refs: block.refs ?? [],
    path_refs: block.pathRefs ?? block["path-refs"] ?? [],
    pre_block: block["pre-block?"] ?? false,
  };
}
