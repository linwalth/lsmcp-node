import { z } from "../schema";
import { ANNOT_READ_ONLY } from "./shared";
import type { ToolReg } from "./shared";
import type { LogseqClient } from "../client";
import type { BlockEntity, PageEntity } from "../types";
import { coerceBlock, coercePage, displayName, dumpBlock, dumpPage, isJournal } from "../types";

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function countBlocks(blocks: BlockEntity[]): number {
  let total = 0;
  for (const block of blocks) total += 1 + countBlocks(block.children || []);
  return total;
}

function dedupChildren(children: BlockEntity[], seen: Set<string>): BlockEntity[] {
  const filtered: BlockEntity[] = [];
  for (const child of children) {
    if (!child.uuid || seen.has(child.uuid)) continue;
    seen.add(child.uuid);
    child.children = dedupChildren(child.children || [], seen);
    filtered.push(child);
  }
  return filtered;
}

function parseBlockTree(rawBlocks: BlockEntity[]): BlockEntity[] {
  const seen = new Set<string>();
  const parsed: BlockEntity[] = [];
  for (const raw of rawBlocks) {
    if (!raw.uuid || seen.has(raw.uuid)) continue;
    seen.add(raw.uuid);
    raw.children = dedupChildren(raw.children || [], seen);
    parsed.push(raw);
  }
  return parsed;
}

function pageSummary(page: PageEntity, slim = false): Record<string, unknown> {
  const summary: Record<string, unknown> = { name: displayName(page), journal: isJournal(page) };
  if (!slim) summary.properties = page.properties || {};
  return summary;
}

function leafSegment(name: string): string {
  const parts = name.split("/");
  return parts[parts.length - 1];
}

function searchRank(page: PageEntity, queryCf: string): [number, number, number, string] {
  const nameCf = (page.name || "").toLowerCase();
  const leaf = leafSegment(nameCf);
  let bucket = 2;
  if (leaf === queryCf) bucket = 0;
  else if (leaf.includes(queryCf)) bucket = 1;
  const depth = (page.name || "").split("/").length;
  return [bucket, depth, (page.name || "").length, nameCf];
}

function compareRank(a: [number, number, number, string], b: [number, number, number, string]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  }
  return cmp(a[3], b[3]);
}

export const coreTools: ToolReg[] = [
  {
    name: "health",
    description: "Ping Logseq and return graph name and page count.",
    inputSchema: {},
    annotations: ANNOT_READ_ONLY,
    handler: async (client: LogseqClient) => {
      const graph = await client.call("logseq.App.getCurrentGraph");
      const pages = await client.call("logseq.Editor.getAllPages");
      const graphName = graph && typeof graph === "object" ? graph.name || "unknown" : "unknown";
      const pageCount = Array.isArray(pages) ? pages.length : 0;
      return JSON.stringify({ status: "ok", graph: graphName, page_count: pageCount });
    },
  },

  {
    name: "get_page",
    description:
      "Return a page entity and deduplicated block tree by page name. Pass name with natural casing; Logseq resolves it case-insensitively, and the returned page surfaces the human-readable name.",
    inputSchema: {
      name: z.string().describe("Page name with natural casing (e.g. 'Meeting Notes 2026'). Resolved case-insensitively."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { name }) => {
      const pageRaw = await client.call("logseq.Editor.getPage", name);
      if (pageRaw === null || pageRaw === undefined) throw new Error(`page not found: ${name}`);

      const pageEntity = coercePage(pageRaw);
      const pageView = dumpPage(pageEntity);
      pageView.name = displayName(pageEntity);

      const blocks = parseBlockTree(await client.getPageBlocksTree(name as string));

      return JSON.stringify({
        page: pageView,
        blocks: blocks.map(dumpBlock),
        block_count: countBlocks(blocks),
      });
    },
  },

  {
    name: "get_block",
    description:
      "Get a single block by UUID, optionally with its child subtree. Identify the block by UUID — use get_page or page_outline first to discover UUIDs. Set include_children=false for a lightweight fetch.",
    inputSchema: {
      uuid: z.string().describe("Block UUID (not a page name). From get_page/page_outline/etc."),
      include_children: z.boolean().optional().describe("If true (default), return the block's child subtree too."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { uuid, include_children }) => {
      const raw = await client.call("logseq.Editor.getBlock", uuid, { includeChildren: include_children !== false });
      if (raw === null || raw === undefined) throw new Error(`block not found: ${uuid}`);
      return JSON.stringify(dumpBlock(coerceBlock(raw)));
    },
  },

  {
    name: "list_pages",
    description:
      "List pages, optionally narrowed to a namespace prefix. Returns AT MOST `limit` pages (default 50) sorted alphabetically. Use search_pages when you only know a fragment, or list_namespace to browse a whole namespace without truncation.",
    inputSchema: {
      namespace: z.string().optional().describe("Optional namespace PREFIX to filter by (e.g. 'projects'). Case-insensitive. Empty = all pages."),
      include_journals: z.boolean().optional().describe("If true, include journal/day pages. Default false (exclude journals)."),
      limit: z.number().optional().describe("Max pages to return. 0 = unlimited. Default 50."),
      slim: z.boolean().optional().describe("If true, drop per-page 'properties' — return only name+journal (lighter)."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { namespace, include_journals, limit, slim }) => {
      const ns = (namespace as string) || "";
      const inclJournals = !!include_journals;
      const lim = limit === undefined ? 50 : (limit as number);
      const slm = !!slim;

      const pages = (await client.getAllPages()).filter((page) => {
        if (!page.name) return false;
        if (!inclJournals && isJournal(page)) return false;
        if (ns && !page.name.toLowerCase().startsWith(ns.toLowerCase())) return false;
        return true;
      });
      pages.sort((a, b) => cmp((a.name || "").toLowerCase(), (b.name || "").toLowerCase()));
      const totalMatching = pages.length;
      const limited = lim > 0 ? pages.slice(0, lim) : pages;
      const hasMore = lim > 0 && totalMatching > limited.length;

      const result = limited.map((page) => pageSummary(page, slm));
      return JSON.stringify({ pages: result, count: result.length, total_matching: totalMatching, has_more: hasMore });
    },
  },

  {
    name: "search_pages",
    description:
      "Find pages by a fragment of their name — the primary way to locate a page when you do NOT know its exact full path. Matching is case-insensitive against both display name and storage slug; results are ranked so the most likely page sorts first.",
    inputSchema: {
      query: z.string().describe("Fragment of a page name to search for (case-insensitive). Matches both display name and storage slug."),
      include_journals: z.boolean().optional().describe("If true, include journal pages in results. Default false."),
      limit: z.number().optional().describe("Max results. 0 = all matches. Default 50."),
      slim: z.boolean().optional().describe("If true, drop per-page 'properties' — lighter results."),
      within_namespace: z.string().optional().describe("Restrict matches to pages beneath this namespace. Empty = search everywhere."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { query, include_journals, limit, slim, within_namespace }) => {
      const stripped = ((query as string) || "").trim();
      if (!stripped) throw new Error("query must be a non-empty string");
      const queryCf = stripped.toLowerCase();
      const nsCf = ((within_namespace as string) || "").trim().replace(/^\/+|\/+$/g, "").toLowerCase();
      const inclJournals = !!include_journals;
      const lim = limit === undefined ? 50 : (limit as number);
      const slm = !!slim;

      const matches = (await client.getAllPages()).filter((page) => {
        if (!page.name) return false;
        if (!inclJournals && isJournal(page)) return false;
        const nameLower = page.name.toLowerCase();
        if (nsCf && !nameLower.startsWith(nsCf + "/") && nameLower !== nsCf) return false;
        const haystack = (page.name + "\n" + (displayName(page) || "")).toLowerCase();
        return haystack.includes(queryCf);
      });

      matches.sort((a, b) => compareRank(searchRank(a, queryCf), searchRank(b, queryCf)));
      const totalMatching = matches.length;
      const limited = lim > 0 ? matches.slice(0, lim) : matches;
      const hasMore = lim > 0 && totalMatching > limited.length;

      const result = limited.map((page) => pageSummary(page, slm));
      return JSON.stringify({ pages: result, count: result.length, total_matching: totalMatching, has_more: hasMore });
    },
  },

  {
    name: "list_namespace",
    description:
      "List every page beneath a namespace, without the alphabetical truncation that affects list_pages. Use this to browse a hierarchy when you know a parent namespace but not the leaf page.",
    inputSchema: {
      namespace: z.string().describe("Namespace path without slashes (e.g. 'projects' or 'worldbuilding/regions'). Case-insensitive."),
      include_journals: z.boolean().optional().describe("If true, include journal pages. Default false."),
      limit: z.number().optional().describe("Cap on results. 0 (default) = all matching pages, no truncation."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { namespace, include_journals, limit }) => {
      const ns = ((namespace as string) || "").trim().replace(/^\/+|\/+$/g, "");
      if (!ns) throw new Error("namespace must be a non-empty string");
      const inclJournals = !!include_journals;
      const lim = limit === undefined ? 0 : (limit as number);

      const raw = await client.call("logseq.Editor.getPagesFromNamespace", ns);
      const pages = (Array.isArray(raw) ? raw.map(coercePage) : []).filter((page: PageEntity) => {
        if (!page.name) return false;
        if (!inclJournals && isJournal(page)) return false;
        return true;
      });
      pages.sort((a: PageEntity, b: PageEntity) => cmp((a.name || "").toLowerCase(), (b.name || "").toLowerCase()));

      const totalMatching = pages.length;
      const limited = lim > 0 ? pages.slice(0, lim) : pages;
      const hasMore = lim > 0 && totalMatching > limited.length;

      const result = limited.map((page: PageEntity) => pageSummary(page));
      return JSON.stringify({ pages: result, count: result.length, total_matching: totalMatching, has_more: hasMore });
    },
  },

  {
    name: "list_namespace_tree",
    description:
      "Browse a namespace as a HIERARCHICAL TREE (parents with nested children). Unlike list_namespace (flat list), this preserves the parent→child structure so you can drill into sub-namespaces.",
    inputSchema: {
      namespace: z.string().describe("Top-level or nested namespace path without slashes (e.g. 'worldbuilding'). Case-insensitive."),
      include_journals: z.boolean().optional().describe("If true, include journal pages in the tree. Default false."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { namespace, include_journals }) => {
      const ns = ((namespace as string) || "").trim().replace(/^\/+|\/+$/g, "");
      if (!ns) throw new Error("namespace must be a non-empty string");
      const inclJournals = !!include_journals;

      const raw = await client.call("logseq.Editor.getPagesTreeFromNamespace", ns);
      const pagesRaw = Array.isArray(raw) ? raw : [];

      function treeNode(rawPage: any): Record<string, unknown> | null {
        const page = coercePage(rawPage);
        if (!page.name) return null;
        if (!inclJournals && isJournal(page)) return null;
        const childrenRaw = rawPage.children;
        const children: Array<Record<string, unknown>> = [];
        if (Array.isArray(childrenRaw)) {
          for (const childRaw of childrenRaw) {
            if (childRaw && typeof childRaw === "object") {
              const child = treeNode(childRaw);
              if (child) children.push(child);
            }
          }
        }
        const node: Record<string, unknown> = pageSummary(page);
        node.children = children;
        return node;
      }

      const tree: Array<Record<string, unknown>> = [];
      for (const rawPage of pagesRaw) {
        if (rawPage && typeof rawPage === "object") {
          const node = treeNode(rawPage);
          if (node) tree.push(node);
        }
      }
      return JSON.stringify(tree);
    },
  },

  {
    name: "get_references",
    description:
      "Get backlinks to a page — pages that CONTAIN a wikilink to this page. Returns the referring pages and the specific blocks within them that link here. For the reverse direction use forward_links.",
    inputSchema: {
      name: z.string().describe("Page name whose backlinks to retrieve (natural casing)."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { name }) => {
      const refs = await client.getPageLinkedReferences(name as string);
      if (!refs) return JSON.stringify([]);
      const backlinks = refs.map(([page, blocks]) => ({
        page: displayName(page),
        blocks: (blocks || []).map((block) => ({ uuid: block.uuid, content: block.content })),
      }));
      return JSON.stringify(backlinks);
    },
  },
];
