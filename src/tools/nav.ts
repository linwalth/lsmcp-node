import { z } from "../schema";
import { ANNOT_READ_ONLY } from "./shared";
import type { ToolReg } from "./shared";
import type { LogseqClient } from "../client";
import type { BlockEntity, PageEntity } from "../types";
import { displayName, isJournal } from "../types";

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function ednLiteral(value: unknown): string {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  if (Array.isArray(value)) return "[" + value.map(ednLiteral).join(" ") + "]";
  const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function interpolate(datalog: string, inputs: unknown[]): string {
  const seen = new Set<number>();
  const interpolated = datalog.replace(/%(\d+)/g, (_match, digits: string) => {
    const idx = parseInt(digits, 10);
    if (idx < 1 || idx > inputs.length) {
      throw new Error(`placeholder %${idx} out of range (have ${inputs.length} input(s))`);
    }
    seen.add(idx);
    return ednLiteral(inputs[idx - 1]);
  });
  const unused: number[] = [];
  for (let i = 0; i < inputs.length; i++) if (!seen.has(i + 1)) unused.push(i + 1);
  if (unused.length) throw new Error(`inputs at positions ${unused} were not referenced by any %N placeholder`);
  return interpolated;
}

function truncate(text: string, limit = 140): string {
  const t = (text || "").trim();
  return t.length <= limit ? t : t.slice(0, limit - 1) + "\u2026";
}

function flattenOutline(blocks: BlockEntity[], depth = 0, maxChars = 140): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    out.push({
      uuid: block.uuid,
      depth,
      content: truncate(block.content || "", maxChars),
      marker: block.marker,
      has_children: !!(block.children && block.children.length),
    });
    if (block.children && block.children.length) out.push(...flattenOutline(block.children, depth + 1, maxChars));
  }
  return out;
}

function collectRefIds(blocks: BlockEntity[], acc: Set<number>): void {
  for (const block of blocks) {
    for (const ref of block.refs || []) {
      if (ref && typeof ref === "object" && typeof (ref as any).id === "number") acc.add((ref as any).id);
      else if (typeof ref === "number") acc.add(ref);
    }
    if (block.children && block.children.length) collectRefIds(block.children, acc);
  }
}

const LINK_RE = /\[\[([^\]]+)\]\]/g;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const EM_DASH = "\u2014";
const EN_DASH = "\u2013";
const SMART_QUOTES = ["\u201c", "\u201d", "\u2018", "\u2019"];

const ORPHAN_ALLOWED = ["kreaturen/monster", "kreaturen/tiere", "götter und höhere wesen", "blaupausen", "spells"];
const ORPHAN_FORBIDDEN = ["kreaturen/npcs (recurring)", "kreaturen/npcs (regular)", "quests", "items", "schauplätze"];

function classifyOrphan(name: string): string {
  const lower = name.toLowerCase();
  for (const ns of ORPHAN_FORBIDDEN) if (lower.startsWith(ns)) return "forbidden";
  for (const ns of ORPHAN_ALLOWED) if (lower.startsWith(ns)) return "allowed";
  return "review";
}

function stripLinksAndImages(text: string): string {
  return text.replace(IMAGE_RE, "").replace(LINK_RE, "");
}

function extractOutgoingLinks(blocks: BlockEntity[]): string[] {
  const links: string[] = [];
  for (const block of blocks) {
    const re = new RegExp(LINK_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(block.content || "")) !== null) {
      let raw = m[1];
      if (raw.includes("|")) raw = raw.slice(0, raw.lastIndexOf("|"));
      links.push(raw.trim());
    }
    if (block.children && block.children.length) links.push(...extractOutgoingLinks(block.children));
  }
  return links;
}

const BLUEPRINT_NAMESPACE = "blaupausen";

const CONVENTIONS: Record<string, unknown> = {
  typography: {
    em_en_dashes: "Forbidden in prose. Replace by context: sentence boundary '. ', apposition ', ', stats whitespace only, number ranges '-'. Dashes inside [[...]] links, asset paths, and properties are exempt.",
    quotes: "ASCII quotes only: \" and '. No smart/curly quotes.",
    umlauts: "Write ä ö ü ß as real umlauts, never ae oe ue ss. Exception: proper nouns consistently spelled without umlauts.",
    no_cjk: "No CJK unified ideographs in wiki content. Transliterate or translate Asian-origin terms.",
    sentences_end_with_period: "Narrative/prose bullets always end with a period. Fragments (HP, AC, labels, stats) do not. Does not apply to statblocks and technical lists.",
  },
  structure: {
    bullet_style: "Bullets, not flowing prose. Related facts in one bullet, sub-bullets for details, max depth 3. No doubled '- -' (Logseq already makes a bullet from '-'). Detailed descriptions nonetheless. Links to everything relevant.",
    no_bullet_prefix: "Do not prefix block content with '- ' or '*' — every Logseq block is inherently a bullet, so leading dashes render literally.",
    headings_root_level: "All headings on root level, never indented. '### Heading', not '- ### Heading' or '\\t### Heading'. Heading depth (# to ######) is preserved. No exceptions.",
    section_labels: "Section labels as '### Label' headings (without '**', Logseq renders bold). Statblock headings all '### '.",
    no_title_heading: "First line of a page must not repeat the file name. Logseq displays the file name as the title.",
    no_block_ids: "No block IDs (^BLOCKNAME).",
  },
  links: {
    notation: "Slash notation: [[Namespace/Page]]. Physical files use ___ separator internally (invisible to writer).",
    existing_only: "Links may only point to EXISTING pages. Verify the target exists before linking. Dead-links create empty pages on click and must be cleaned up manually. If a target does not exist, write as plain text (without [[]]) or create the page first. Exception: deliberate forward-references filled promptly (e.g. quest links on new dungeons).",
    no_pipe_aliases: "[[Namespace/Name|Name]] is forbidden when the alias equals the last path segment — Logseq creates an empty page on click. Use [[Namespace/Name]] instead.",
    alias_syntax: "Pipe-syntax [[Namespace/Name|Alias]] does NOT work in Logseq (that is Obsidian syntax). Correct Logseq syntax: [Display Text]([[Namespace/Page]]). Example: [die lachende Katze]([[Organisationen/Gilden und Verbünde/Die lachende Katze - Händlergilde]]).",
    no_inline_chains: "No comma-separated inline link chains. Expand to nested bullets instead.",
    child_locations: "Child locations link to parent splitter: '- Liegt auf [[...]]'.",
  },
  game_design: {
    no_quest_tags: "No tags for plothooks/quests. Plothooks under '### Plothooks' on location pages. Quests in the Quests/ namespace.",
    ley_not_resource: "Ley is cosmic energy, omnipresent, connected to water. Not mineable, not controllable like a mine.",
    fantastic_realism: "Adapt real-world processes and principles for the fantasy world. The user has the final word.",
    metropolregionen: "Cities under a same-named region are named 'Metropolregion X/X'. Region: 'Metropolregion Baroly', city below: 'Baroly'. Exception: hub/dungeon pairs (e.g. Ana-Noxys/Ana-Noxys) are not metropolregionen and stay untouched.",
  },
  statblock_schema: {
    mandatory_fields: "Description (short prose, max 5-8 lines), CR / difficulty, HP, AC, movement, STR/DEX/CON/INT/WIS/CHA (with modifier in parentheses), type, alignment, actions.",
    optional_fields: "Bonus actions, reactions, free actions (bosses only).",
    no_basismod: "Basismod is deprecated. Use six attribute scores (STR/DEX/CON/INT/WIS/CHA) with modifiers. Proficiency bonus (Ubungsbonus) is player-characters only, never in NPC/creature statblocks.",
    art_label: "**Art:** not **Rasse:** or **Volk:** (universal for humanoid, monstrosity, undead, etc.).",
    free_actions: "'Freie Aktionen' replaces 'Villain-Aktionen'/' Bosewichtaktionen'.",
    dungeon_indent: "Dungeon statblocks retain double indentation (\\t\\t-) under '#### [Name]' within '### Encounters'.",
  },
  images: "Image and cover-image embeds (![bild](../assets/...)) are tolerated on ALL pages of ALL schemas. Neither blueprints nor audits object to image embeds. Images do not disturb any schema.",
};

const NAMESPACE_MAP: Record<string, string | Record<string, string>> = {
  "schauplätze": { splitter: "World shards and locations (Schauplätze/Splitter/)" },
  kreaturen: {
    npcs_recurring: "Recurring NPCs and humanoid encounter groups (Kreaturen/NPCs (Recurring)/)",
    npcs_regular: "One-shot NPCs (Kreaturen/NPCs (Regular)/)",
    npcs_retired: "Dead/retired NPCs (Kreaturen/NPCs (Retired)/)",
    tiere: "Animal creatures (Kreaturen/Tiere/)",
    fahrzeuge: "Airships, planes, ships (Kreaturen/Fahrzeuge/)",
    monster: "Non-humanoid monsters, constructs, ghosts (Kreaturen/Monster/)",
  },
  organisationen: "Religions and cults, guilds and unions, military and factions, groups, syndicates, gangs, families and clans",
  "götter und höhere wesen": "Gods, saints, higher principles",
  items: { _root: "Items, curses, relics", drogen: "Drug sub-category (Items/Drogen/)" },
  spells: "Homebrew spells",
  quests: "Quests with '### Prämisse' minimum",
  blaupausen: "19 page-structure templates (categories: Splitter, Städte, Dörfer, Gegenden, Dungeons, Natur, Magisch, Zivilisation, Quest, NPC, Encounter, Monster, Organisation, Kompendium, Götter, Items, Spells, Tiere, Fahrzeuge)",
};

function ratcliffMatches(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  let best = 0;
  let bestI = 0;
  let bestJ = 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > best) {
          best = dp[i][j];
          bestI = i;
          bestJ = j;
        }
      }
    }
  }
  if (best === 0) return 0;
  return (
    best +
    ratcliffMatches(a.slice(0, bestI - best), b.slice(0, bestJ - best)) +
    ratcliffMatches(a.slice(bestI), b.slice(bestJ))
  );
}

function sequenceRatio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  return (2 * ratcliffMatches(a, b)) / total;
}

export const navTools: ToolReg[] = [
  {
    name: "query",
    description:
      "Run a Datalog query against Logseq's indexed Datascript DB. Pushes filtering/joins INTO Logseq instead of fetching all pages. Logseq's HTTP API does not auto-bind `$`, so inline caller values via %1,%2,... placeholders — do NOT use `:in $`.",
    inputSchema: {
      datalog: z.string().describe("Datalog query string (Logseq advanced-query edn syntax). Inline caller values via %1,%2,... placeholders (do NOT use :in $ — HTTP API won't bind it)."),
      inputs: z.array(z.any()).optional().nullable().describe("Values for %1,%2,... placeholders, in order. Each is substituted as a quoted edn literal. Null/omit for unparameterised queries."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { datalog, inputs }) => {
      const stripped = ((datalog as string) || "").trim();
      if (!stripped) throw new Error("datalog query must be a non-empty string");
      const argsList = Array.isArray(inputs) ? (inputs as unknown[]) : [];
      const finalQuery = argsList.length ? interpolate(stripped, argsList) : stripped;
      try {
        const result = await client.call("logseq.DB.customQuery", finalQuery);
        return JSON.stringify(result);
      } catch (err) {
        throw new Error(`Datalog query failed: ${(err as Error).message}`);
      }
    },
  },

  {
    name: "graph_stats",
    description:
      "Cheap orientation snapshot of the whole graph: graph name, total pages, journal vs non-journal counts, and top namespaces by page count. Call this FIRST to understand the shape of the graph.",
    inputSchema: {},
    annotations: ANNOT_READ_ONLY,
    handler: async (client) => {
      const graph = await client.call("logseq.App.getCurrentGraph");
      const pages = (await client.getAllPages()).filter((page) => page.name);
      const total = pages.length;
      const journalCount = pages.filter((page) => isJournal(page)).length;
      const nsCounts = new Map<string, number>();
      for (const page of pages) {
        if (isJournal(page)) continue;
        const top = (page.name || "").split("/", 1)[0];
        nsCounts.set(top, (nsCounts.get(top) || 0) + 1);
      }
      const topNamespaces = [...nsCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
      return JSON.stringify({
        graph: graph && typeof graph === "object" ? graph.name || "unknown" : "unknown",
        total_pages: total,
        journals: journalCount,
        non_journals: total - journalCount,
        top_namespaces: topNamespaces,
      });
    },
  },

  {
    name: "page_outline",
    description:
      "Return a FLAT outline skeleton of a page — block uuids with indented depth and TRUNCATED content, no nested children payloads. Cheaper than get_page when you only need the structure.",
    inputSchema: {
      name: z.string().describe("Page name (natural casing)."),
      max_chars: z.number().optional().describe("Truncate each block's content preview to this many chars (default 140)."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { name, max_chars }) => {
      const blocks = await client.getPageBlocksTree(name as string);
      const seen = new Set<string>();
      const parsed: BlockEntity[] = [];
      for (const block of blocks) {
        if (!block.uuid || seen.has(block.uuid)) continue;
        seen.add(block.uuid);
        parsed.push(block);
      }
      const outline = flattenOutline(parsed, 0, max_chars === undefined ? 140 : (max_chars as number));
      return JSON.stringify({ page: name, block_count: outline.length, outline });
    },
  },

  {
    name: "expand_references",
    description:
      "Expand the BACKLINK neighbourhood around a page by up to `hops` BFS levels. Starts at `name`, collects pages that REFERENCE it (level 1), then pages that reference THOSE, etc. For the outward direction use forward_links.",
    inputSchema: {
      name: z.string().describe("Starting page name (natural casing). Expansion begins here at distance 0."),
      hops: z.number().optional().describe("BFS radius (default 1). 1 = direct backlinks, 2 = backlinks of backlinks."),
      max_pages: z.number().optional().describe("Hard cap on total reached pages (default 50)."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { name, hops, max_pages }) => {
      const h = hops === undefined ? 1 : (hops as number);
      const mp = max_pages === undefined ? 50 : (max_pages as number);
      if (h < 1) throw new Error("hops must be >= 1");
      if (mp < 1) throw new Error("max_pages must be >= 1");

      const reached = new Map<string, number>([[name as string, 0]]);
      let frontier: string[] = [name as string];

      for (let level = 1; level <= h; level++) {
        if (!frontier.length) break;
        const nextFrontier: string[] = [];
        for (const current of frontier) {
          const refs = await client.getPageLinkedReferences(current);
          if (!refs) continue;
          for (const [page] of refs) {
            const neighbor = displayName(page) || page.name || "";
            if (!neighbor || reached.has(neighbor)) continue;
            reached.set(neighbor, level);
            nextFrontier.push(neighbor);
            if (reached.size >= mp) {
              return JSON.stringify({
                start: name, hops: h, direction: "backlinks",
                reached: [...reached.entries()].map(([p, d]) => ({ page: p, distance: d })),
                truncated: true,
              });
            }
          }
        }
        frontier = nextFrontier;
      }

      return JSON.stringify({
        start: name, hops: h, direction: "backlinks",
        reached: [...reached.entries()].map(([p, d]) => ({ page: p, distance: d })),
        truncated: false,
      });
    },
  },

  {
    name: "forward_links",
    description:
      "List the pages that THIS page links to (outbound wikilinks). The complement of get_references (inbound backlinks). Resolves link page-ids to human-readable names.",
    inputSchema: {
      name: z.string().describe("Page name whose outbound wikilinks to list (natural casing)."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { name }) => {
      const parsed = await client.getPageBlocksTree(name as string);
      const refIds = new Set<number>();
      collectRefIds(parsed, refIds);
      if (!refIds.size) return JSON.stringify({ page: name, links: [], count: 0 });

      const idMap = await client.idToNameMap();
      const links: string[] = [];
      for (const rid of [...refIds].sort((a, b) => a - b)) {
        const nm = idMap.get(rid);
        if (nm) links.push(nm);
      }
      return JSON.stringify({ page: name, links, count: links.length });
    },
  },

  {
    name: "search_blocks",
    description:
      "Full-text SEARCH over BLOCK CONTENTS via Logseq's indexed search. Unlike search_pages (page names only), scans the text inside blocks. Returns matching blocks with uuid, truncated content, and containing page name.",
    inputSchema: {
      query_text: z.string().describe("Full-text search term matched against block CONTENTS (not page names). e.g. 'drache', 'AC 16'."),
      limit: z.number().optional().describe("Max matching blocks to return (default 20)."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { query_text, limit }) => {
      const stripped = ((query_text as string) || "").trim();
      if (!stripped) throw new Error("query must be a non-empty string");
      let lim = limit === undefined ? 20 : (limit as number);
      if (lim < 1) lim = 20;

      const raw = await client.call("logseq.Editor.search", stripped, { limit: lim });
      if (!raw || typeof raw !== "object") return JSON.stringify({ query: stripped, blocks: [], count: 0 });

      const blocksRaw = (raw as any).blocks || [];
      const idMap = await client.idToNameMap();

      const out: Array<Record<string, unknown>> = [];
      for (const b of blocksRaw) {
        if (!b || typeof b !== "object") continue;
        const uid = b["block/uuid"] || b.uuid || "";
        const content = b["block/content"] || b.content || "";
        let pageId = b["block/page"];
        if (pageId && typeof pageId === "object") pageId = pageId.id;
        const pageName = typeof pageId === "number" ? idMap.get(pageId) || "" : "";
        out.push({ uuid: uid, page: pageName, content: truncate(content, 200) });
      }
      return JSON.stringify({ query: stripped, blocks: out, count: out.length });
    },
  },

  {
    name: "namespace_stats",
    description:
      "Granular statistics for a single namespace subtree: total descendant pages, max depth, depth distribution, and immediate child sub-namespaces with page counts. Use before traversing a large hierarchy.",
    inputSchema: {
      namespace: z.string().describe("Namespace to analyse (e.g. 'schauplätze' or 'kreaturen'). Case-insensitive."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { namespace }) => {
      const ns = ((namespace as string) || "").trim().replace(/^\/+|\/+$/g, "");
      if (!ns) throw new Error("namespace must be a non-empty string");

      const nsLower = ns.toLowerCase();
      const descendants = (await client.getAllPages()).filter((page) => {
        if (!page.name || isJournal(page)) return false;
        const nameLower = page.name.toLowerCase();
        return nameLower === nsLower || nameLower.startsWith(nsLower + "/");
      });

      const depthDist = new Map<number, number>();
      let maxDepth = 0;
      const childNs = new Map<string, number>();
      const prefixLen = nsLower.length + 1;

      for (const page of descendants) {
        const nameLower = (page.name || "").toLowerCase();
        const remainder = nameLower.startsWith(nsLower + "/") ? page.name!.slice(prefixLen) : "";
        const depth = remainder ? remainder.split("/").length : 0;
        depthDist.set(depth, (depthDist.get(depth) || 0) + 1);
        if (depth > maxDepth) maxDepth = depth;
        if (remainder) {
          const topChild = remainder.split("/", 1)[0];
          const key = `${ns}/${topChild}`;
          childNs.set(key, (childNs.get(key) || 0) + 1);
        }
      }

      return JSON.stringify({
        namespace: ns,
        total_descendants: descendants.length,
        max_depth: maxDepth,
        depth_distribution: [...depthDist.entries()].sort((a, b) => a[0] - b[0]).map(([d, c]) => ({ depth: d, pages: c })),
        child_namespaces: [...childNs.entries()].sort((a, b) => b[1] - a[1]),
      });
    },
  },

  {
    name: "cross_reference",
    description:
      "Find pages that link to BOTH `a` and `b` (intersection of their backlinks). Returns the shared page names only. Both pages must exist.",
    inputSchema: {
      a: z.string().describe("First page name (natural casing)."),
      b: z.string().describe("Second page name (natural casing)."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { a, b }) => {
      const na = ((a as string) || "").trim();
      const nb = ((b as string) || "").trim();
      if (!na || !nb) throw new Error("both page names must be non-empty");

      async function backlinkSet(name: string): Promise<Set<string>> {
        const refs = await client.getPageLinkedReferences(name);
        if (!refs) return new Set<string>();
        const out = new Set<string>();
        for (const [page] of refs) {
          const nm = displayName(page) || page.name || "";
          if (nm) out.add(nm);
        }
        return out;
      }

      const [setA, setB] = await Promise.all([backlinkSet(na), backlinkSet(nb)]);
      const shared = [...setA].filter((x) => setB.has(x)).sort(cmp);
      return JSON.stringify({
        a: na, b: nb, shared_backlink_pages: shared, count: shared.length,
        a_only_count: [...setA].filter((x) => !setB.has(x)).length,
        b_only_count: [...setB].filter((x) => !setA.has(x)).length,
      });
    },
  },

  {
    name: "list_blueprints",
    description:
      "List all page-blueprint templates under the 'blaupausen/' namespace. CALL THIS before page_create to discover which categories have a template, then use get_blueprint to fetch the structure.",
    inputSchema: {},
    annotations: ANNOT_READ_ONLY,
    handler: async (client) => {
      const blueprints: Array<{ category: string; page: string }> = [];
      for (const page of await client.getAllPages()) {
        if (page.name && page.name.startsWith(BLUEPRINT_NAMESPACE + "/")) {
          blueprints.push({ category: page.name.slice(BLUEPRINT_NAMESPACE.length + 1), page: displayName(page) || page.name });
        }
      }
      blueprints.sort((a, b) => cmp(a.category, b.category));
      return JSON.stringify({ namespace: BLUEPRINT_NAMESPACE, blueprints, count: blueprints.length });
    },
  },

  {
    name: "get_blueprint",
    description:
      "Fetch the full block structure of a page blueprint so it can be replicated. Returns the headed sections and placeholder prompts from `blaupausen/<category>`. Use AFTER list_blueprints, then pass the structure to page_create.",
    inputSchema: {
      category: z.string().describe("Blueprint category (e.g. 'items', 'npc', 'spells'). Matches a page under blaupausen/."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { category }) => {
      const cat = ((category as string) || "").trim().replace(/^\/+|\/+$/g, "");
      if (!cat) throw new Error("category must be a non-empty string");
      const pageName = `${BLUEPRINT_NAMESPACE}/${cat}`;
      const parsed = await client.getPageBlocksTree(pageName);
      const outline = flattenOutline(parsed, 0, 200);
      return JSON.stringify({ blueprint: pageName, category: cat, block_count: outline.length, outline });
    },
  },

  {
    name: "get_conventions",
    description:
      "Return the graph's WRITING CONVENTIONS as structured JSON: typography, structure, links, game-design rules, and statblock schema. Call this BEFORE writing any narrative content.",
    inputSchema: {},
    annotations: ANNOT_READ_ONLY,
    handler: async () => JSON.stringify(CONVENTIONS),
  },

  {
    name: "get_namespace_map",
    description:
      "Return the graph's NAMESPACE ARCHITECTURE, merging static conventions with LIVE page counts. Each entry carries purpose, page_count, sub_namespaces, and expected. Call before page_create or rename_page.",
    inputSchema: {},
    annotations: ANNOT_READ_ONLY,
    handler: async (client) => {
      const topCounts = new Map<string, number>();
      const subCounts = new Map<string, Map<string, number>>();

      for (const page of await client.getAllPages()) {
        if (!page.name || isJournal(page)) continue;
        const parts = page.name.split("/", 2);
        const top = parts[0];
        topCounts.set(top, (topCounts.get(top) || 0) + 1);
        if (parts.length >= 2) {
          if (!subCounts.has(top)) subCounts.set(top, new Map());
          const sub = parts[1];
          subCounts.get(top)!.set(sub, (subCounts.get(top)!.get(sub) || 0) + 1);
        }
      }

      const allNamespaces = new Set<string>([...topCounts.keys(), ...Object.keys(NAMESPACE_MAP)]);
      const result: Record<string, Record<string, unknown>> = {};
      for (const ns of [...allNamespaces].sort()) {
        const purpose = NAMESPACE_MAP[ns];
        const entry: Record<string, unknown> = {
          page_count: topCounts.get(ns) || 0,
          expected: ns in NAMESPACE_MAP,
        };
        if (purpose && typeof purpose === "object") {
          entry.purpose = Object.values(purpose).join("; ");
          entry.sub_namespace_purposes = purpose;
        } else if (typeof purpose === "string") {
          entry.purpose = purpose;
        } else {
          entry.purpose = null;
        }
        const subsLive = subCounts.get(ns);
        entry.sub_namespaces = subsLive
          ? [...subsLive.entries()].sort((a, b) => cmp(a[0], b[0])).map(([name, cnt]) => ({ name, page_count: cnt }))
          : [];
        result[ns] = entry;
      }
      return JSON.stringify(result);
    },
  },

  {
    name: "validate_page",
    description:
      "Lint a single page against the graph's writing conventions: DEAD LINKS, EM/EN-DASHES, SMART QUOTES, CJK characters, BULLET-PREFIX contamination, TITLE-HEADING redundancy, INDENTED HEADINGS. Returns violations with severity and a suggested fix.",
    inputSchema: {
      name: z.string().describe("Page name to validate (natural casing)."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { name }) => {
      const parsed = await client.getPageBlocksTree(name as string);

      const existingNames = new Set<string>();
      for (const page of await client.getAllPages()) {
        if (page.name) existingNames.add(page.name.toLowerCase());
      }

      const violations: Array<Record<string, unknown>> = [];

      for (const link of extractOutgoingLinks(parsed)) {
        if (!existingNames.has(link.toLowerCase())) {
          violations.push({
            severity: "high",
            rule: "dead_link",
            detail: `[[${link}]] - target page does not exist`,
            fix: "create the target page, or write as plain text without [[]]",
          });
        }
      }

      function scanBlock(block: BlockEntity, depth: number): void {
        const content = block.content || "";
        if (depth === 0 && content.trim().toLowerCase() === (name as string).trim().toLowerCase()) {
          violations.push({
            severity: "low",
            rule: "title_heading",
            detail: `first block repeats page name '${name}'`,
            fix: "remove the redundant title; Logseq displays the file name",
          });
        }
        const stripped = content.replace(/^\s+/, "");
        if (stripped.startsWith("- ") || stripped.startsWith("* ")) {
          violations.push({
            severity: "medium",
            rule: "bullet_prefix",
            detail: `block starts with bullet marker: ${content.slice(0, 50)}`,
            fix: "remove leading '- ' or '* '; every Logseq block is already a bullet",
          });
        }
        if (depth > 0 && stripped.startsWith("#")) {
          violations.push({
            severity: "medium",
            rule: "indented_heading",
            detail: `heading at depth ${depth} (indented): ${content.slice(0, 60)}`,
            fix: "move heading to root level (depth 0); preserve # count but remove indentation",
          });
        }

        const prose = stripLinksAndImages(content);
        if (prose.includes(EM_DASH) || prose.includes(EN_DASH)) {
          const ch = prose.includes(EM_DASH) ? EM_DASH : EN_DASH;
          violations.push({
            severity: "medium",
            rule: "em_en_dash",
            detail: `found '${ch}' in: ${content.slice(0, 60)}`,
            fix: "replace with '. ' (sentence), ', ' (apposition), '-' (range), or space (stats)",
          });
        }
        for (const sq of SMART_QUOTES) {
          if (prose.includes(sq)) {
            violations.push({
              severity: "low",
              rule: "smart_quote",
              detail: `found smart quote '${sq}' in: ${content.slice(0, 60)}`,
              fix: "use ASCII '\"' or \"'\"",
            });
          }
        }
        const cjkMatch = CJK_RE.exec(prose);
        if (cjkMatch) {
          violations.push({
            severity: "high",
            rule: "cjk_character",
            detail: `found CJK character '${cjkMatch[0]}' in: ${content.slice(0, 60)}`,
            fix: "transliterate or translate; no Chinese characters in wiki content",
          });
        }

        for (const child of block.children || []) scanBlock(child, depth + 1);
      }

      for (const block of parsed) scanBlock(block, 0);

      return JSON.stringify({
        page: name,
        violations,
        count: violations.length,
        passed: violations.length === 0,
      });
    },
  },

  {
    name: "orphan_report",
    description:
      "Report pages with ZERO incoming backlinks, classified by orphan policy: 'allowed' (reference material), 'forbidden' (should be linked from a hub), 'review' (everything else). Runs many API calls; may take ~10-20s on a large graph.",
    inputSchema: {
      limit: z.number().optional().describe("Max orphan pages to return (0=all). Default 100."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { limit }) => {
      const lim = limit === undefined ? 100 : (limit as number);
      const pages = (await client.getAllPages()).filter((page) => page.name && !isJournal(page));

      const results = await Promise.all(
        pages.map(async (page) => {
          const refs = await client.getPageLinkedReferences(page.name!);
          if (refs && refs.length > 0) return null;
          return { name: displayName(page) || page.name!, classification: classifyOrphan(page.name!) };
        }),
      );

      let orphans = results.filter((r): r is { name: string; classification: string } => r !== null);
      orphans.sort((a, b) => cmp(a.classification, b.classification) || cmp(a.name.toLowerCase(), b.name.toLowerCase()));
      const total = orphans.length;
      const byClass: Record<string, number> = {};
      for (const o of orphans) byClass[o.classification] = (byClass[o.classification] || 0) + 1;
      if (lim > 0) orphans = orphans.slice(0, lim);

      return JSON.stringify({
        orphans,
        shown: orphans.length,
        total_orphans: total,
        by_classification: byClass,
      });
    },
  },

  {
    name: "similar_pages",
    description:
      "Find near-duplicate page names via fuzzy string matching (Ratcliff-Obershelp ratio). Catches casing-induced duplicates, spelling variants, and near-collisions. Threshold 0.85 is strict enough to catch typos but loose enough for near-misses.",
    inputSchema: {
      threshold: z.number().optional().describe("Similarity ratio threshold 0-1 (default 0.85). Higher = stricter match."),
      limit: z.number().optional().describe("Max pairs to return (0=all). Default 50."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { threshold, limit }) => {
      const thr = threshold === undefined ? 0.85 : (threshold as number);
      const lim = limit === undefined ? 50 : (limit as number);
      if (thr < 0 || thr > 1) throw new Error("threshold must be between 0 and 1");

      const names: string[] = [];
      for (const page of await client.getAllPages()) {
        if (page.name && !isJournal(page)) names.push(displayName(page) || page.name);
      }

      const namesSorted = names.sort((a, b) => cmp(a.toLowerCase(), b.toLowerCase()));
      const pairs: Array<{ a: string; b: string; similarity: number }> = [];
      const n = namesSorted.length;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const ratio = sequenceRatio(namesSorted[i].toLowerCase(), namesSorted[j].toLowerCase());
          if (ratio >= thr && ratio < 1.0) {
            pairs.push({ a: namesSorted[i], b: namesSorted[j], similarity: Math.round(ratio * 1000) / 1000 });
          }
        }
        if (lim > 0 && pairs.length >= lim) break;
      }

      pairs.sort((a, b) => b.similarity - a.similarity);
      const out = lim > 0 ? pairs.slice(0, lim) : pairs;
      return JSON.stringify({ pairs: out, count: out.length });
    },
  },
];
