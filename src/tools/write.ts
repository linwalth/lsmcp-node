import { z } from "../schema";
import { ANNOT_APPEND, ANNOT_DELETE, ANNOT_READ_ONLY, ANNOT_RENAME, ANNOT_UPDATE_IDEMPOTENT } from "./shared";
import type { ToolReg } from "./shared";
import type { LogseqClient } from "../client";
import type { BlockEntity, PageEntity } from "../types";
import { coercePage, displayName, dumpBlock, dumpPage, isJournal } from "../types";

interface WriteBlock {
  content: string;
  properties?: Record<string, unknown>;
  children?: WriteBlock[];
}

function normalizeBlocks(blocks: unknown): WriteBlock[] {
  if (blocks === null || blocks === undefined) return [];
  const arr = Array.isArray(blocks) ? blocks : [blocks];
  const normalized: WriteBlock[] = [];
  for (const node of arr) {
    if (typeof node === "string") {
      normalized.push({ content: node });
      continue;
    }
    if (!node || typeof node !== "object") throw new Error("blocks must be strings, objects, or lists of them");
    const n = node as Record<string, unknown>;
    const content = n.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("block content must be a non-empty string");
    const properties = n.properties;
    if (properties !== undefined && properties !== null && typeof properties !== "object") {
      throw new Error("block properties must be a dict");
    }
    normalized.push({
      content,
      properties: (properties as Record<string, unknown>) || undefined,
      children: n.children ? normalizeBlocks(n.children) : undefined,
    });
  }
  return normalized;
}

function toBatchBlock(block: WriteBlock): Record<string, unknown> {
  const node: Record<string, unknown> = { content: block.content };
  if (block.properties) node.properties = block.properties;
  if (block.children) node.children = block.children.map(toBatchBlock);
  return node;
}

function countBatchNodes(nodes: Array<Record<string, unknown>>): number {
  let total = 0;
  for (const node of nodes) {
    total += 1;
    const children = node.children as Array<Record<string, unknown>> | undefined;
    if (children) total += countBatchNodes(children);
  }
  return total;
}

function mutationOpts(block: WriteBlock): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  if (block.properties) opts.properties = block.properties;
  return opts;
}

function extractUuid(rawResult: unknown, method: string): string {
  if (!rawResult || typeof rawResult !== "object") throw new Error(`${method} returned an invalid response`);
  const uuid = (rawResult as any).uuid;
  if (typeof uuid !== "string" || !uuid) throw new Error(`${method} did not return a block uuid`);
  return uuid;
}

function countBlocks(blocks: BlockEntity[]): number {
  let total = 0;
  for (const block of blocks) total += 1 + countBlocks(block.children || []);
  return total;
}

function containsBlockUuid(blocks: BlockEntity[], uuid: string): boolean {
  for (const block of blocks) {
    if (block.uuid === uuid || containsBlockUuid(block.children || [], uuid)) return true;
  }
  return false;
}

function collectSubtreeUuids(block: BlockEntity): Set<string> {
  const uuids = new Set<string>();
  if (block.uuid) uuids.add(block.uuid);
  for (const child of block.children || []) {
    for (const u of collectSubtreeUuids(child)) uuids.add(u);
  }
  return uuids;
}

function findNested(
  blocks: BlockEntity[],
  uuid: string,
  parentUuid: string | null,
): [BlockEntity, string | null, BlockEntity[]] | null {
  for (const block of blocks) {
    if (block.uuid === uuid) return [block, parentUuid, blocks];
    const nested = findNested(block.children || [], uuid, block.uuid ?? null);
    if (nested) return nested;
  }
  return null;
}

function findBlockWithParent(blocks: BlockEntity[], uuid: string): [BlockEntity, string | null, BlockEntity[]] | null {
  return findNested(blocks, uuid, null);
}

function verifyBlockMoved(
  blockTree: BlockEntity[],
  opts: { movedUuid: string; targetUuid: string; position: string; subtreeUuids: Set<string> },
): void {
  const { movedUuid, targetUuid, position, subtreeUuids } = opts;
  const matches = [...subtreeUuids].filter((u) => containsBlockUuid(blockTree, u));
  if (matches.length !== subtreeUuids.size) {
    throw new Error(`moved subtree lost descendants after move: ${movedUuid}`);
  }

  const movedResult = findBlockWithParent(blockTree, movedUuid);
  const targetResult = findBlockWithParent(blockTree, targetUuid);
  if (!movedResult || !targetResult) {
    throw new Error(`move verification failed for block: ${movedUuid}`);
  }

  const [movedBlock, movedParentUuid, movedSiblings] = movedResult;
  const [targetBlock, targetParentUuid, targetSiblings] = targetResult;

  if (position === "child") {
    if (movedParentUuid !== targetUuid) throw new Error(`move verification failed for block: ${movedUuid}`);
    return;
  }
  if (movedParentUuid !== targetParentUuid || movedSiblings !== targetSiblings) {
    throw new Error(`move verification failed for block: ${movedUuid}`);
  }

  const movedIndex = movedSiblings.indexOf(movedBlock);
  const targetIndex = targetSiblings.indexOf(targetBlock);
  if (position === "before" && movedIndex >= targetIndex) throw new Error(`move verification failed for block: ${movedUuid}`);
  if (position === "after" && movedIndex <= targetIndex) throw new Error(`move verification failed for block: ${movedUuid}`);
}

async function appendTreeToPage(client: LogseqClient, pageName: string, blocks: WriteBlock[], prepend = false): Promise<number> {
  if (!blocks.length) return 0;
  const anchorMethod = prepend ? "logseq.Editor.prependBlockInPage" : "logseq.Editor.appendBlockInPage";
  const first = blocks[0];
  const result = await client.call(anchorMethod, pageName, first.content, mutationOpts(first));
  const anchorUuid = extractUuid(result, anchorMethod);
  let appended = 1;

  if (first.children) {
    const batch = first.children.map(toBatchBlock);
    await client.call("logseq.Editor.insertBatchBlock", anchorUuid, batch, { sibling: false });
    appended += countBatchNodes(batch);
  }
  if (blocks.length > 1) {
    const batch = blocks.slice(1).map(toBatchBlock);
    await client.call("logseq.Editor.insertBatchBlock", anchorUuid, batch, { sibling: true });
    appended += countBatchNodes(batch);
  }
  return appended;
}

async function getPageOrError(client: LogseqClient, pageName: string): Promise<PageEntity> {
  const page = await client.getPage(pageName);
  if (!page) throw new Error(`page not found: ${pageName}`);
  return page;
}

async function getPageOrNone(client: LogseqClient, pageName: string): Promise<PageEntity | null> {
  return client.getPage(pageName);
}

async function getPageBlocks(client: LogseqClient, pageName: string): Promise<BlockEntity[]> {
  return client.getPageBlocksTree(pageName);
}

async function getBlockOrError(client: LogseqClient, uuid: string): Promise<BlockEntity> {
  const block = await client.getBlock(uuid, true);
  if (!block) throw new Error(`block not found: ${uuid}`);
  return block;
}

function parseIsoDate(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`invalid date: ${value}`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) throw new Error(`invalid date: ${value}`);
  return d;
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function todayDate(): Date {
  const override = (process.env.LOGSEQ_MCP_TEST_TODAY || "").trim();
  if (override) {
    try {
      return parseIsoDate(override);
    } catch {
      throw new Error(`invalid LOGSEQ_MCP_TEST_TODAY: ${override}`);
    }
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function resolveJournalPageName(dateStr?: string): string {
  const journalDate = dateStr === undefined || dateStr === null ? todayDate() : parseIsoDate(dateStr);
  return toIsoDate(journalDate);
}

async function ensureJournalPage(
  client: LogseqClient,
  pageName: string,
): Promise<{ page: PageEntity; created: boolean; blocks: BlockEntity[] }> {
  let page = await getPageOrNone(client, pageName);
  let created = false;
  if (!page) {
    const createdPage = await client.call("logseq.Editor.createPage", pageName, {}, { createFirstBlock: false });
    if (!createdPage) throw new Error(`failed to create journal page: ${pageName}`);
    created = true;
    page = coercePage(createdPage);
  }
  if (!isJournal(page)) throw new Error(`resolved page is not a journal page: ${pageName}`);
  const blocks = await getPageBlocks(client, pageName);
  return { page, created, blocks };
}

const JOURNAL_RANGE_MAX_DAYS = 366;

function iterInclusiveDates(start: Date, end: Date): Date[] {
  const dayCount = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  if (dayCount > JOURNAL_RANGE_MAX_DAYS) {
    throw new Error(`journal range exceeds maximum span of ${JOURNAL_RANGE_MAX_DAYS} days`);
  }
  const out: Date[] = [];
  for (let i = 0; i < dayCount; i++) {
    out.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }
  return out;
}

async function pageIdToName(client: LogseqClient, ref: unknown): Promise<string | null> {
  let id: number | undefined;
  if (typeof ref === "number") id = ref;
  else if (ref && typeof ref === "object") id = (ref as any).id;
  if (typeof id !== "number") return null;
  const map = await client.idToNameMap();
  return map.get(id) || null;
}

export const writeTools: ToolReg[] = [
  {
    name: "page_create",
    description:
      "Create a new Logseq page with optional properties and initial blocks. BLUEPRINT WORKFLOW: call list_blueprints then get_blueprint before creating. CONVENTIONS: call get_conventions before composing content. NAMESPACE: consult get_namespace_map to place the page correctly.",
    inputSchema: {
      name: z.string().describe("New page name with natural casing (e.g. 'Meeting Notes 2026'). Do NOT lowercase — casing becomes the display name."),
      properties: z.record(z.any()).optional().nullable().describe("Optional page-level properties as a key/value object. Omit or null for none."),
      blocks: z.any().optional().nullable().describe("Optional initial blocks. Same format as block_append: strings or objects {content, properties?, children?}."),
    },
    annotations: ANNOT_APPEND,
    handler: async (client, { name, properties, blocks }) => {
      const normalizedBlocks = normalizeBlocks(blocks);
      const pageProperties = (properties as Record<string, unknown>) || {};
      const pageName = name as string;

      const created = await client.call("logseq.Editor.createPage", pageName, pageProperties, { createFirstBlock: false });
      if (!created) throw new Error(`failed to create page: ${pageName}`);

      if (pageName !== pageName.toLowerCase()) {
        try {
          await client.call("logseq.Editor.renamePage", pageName, pageName);
        } catch {
          console.error(`[lsmcp-node] post-create rename (display-name fix) failed for ${pageName}`);
        }
      }

      const appendedCount = await appendTreeToPage(client, pageName, normalizedBlocks);
      const blockTree = await getPageBlocks(client, pageName);
      const page = coercePage(created);
      const pageView = dumpPage(page);
      pageView.name = displayName(page);

      return JSON.stringify({
        page: pageView,
        created: true,
        blocks: blockTree.map(dumpBlock),
        block_count: countBlocks(blockTree),
        appended: appendedCount,
      });
    },
  },

  {
    name: "block_append",
    description:
      "Append blocks to an existing page. REQUIRES `page` — never inferred. For journal/day pages use journal_append. CONVENTIONS: call get_conventions before appending narrative content.",
    inputSchema: {
      page: z.string().describe("Existing target page name with natural casing (e.g. 'Meeting Notes'). NOT a journal date — use journal_append for that."),
      blocks: z.any().describe("Block(s) to insert. Accepts a string, an object {content, properties?, children?}, or a list mixing both."),
    },
    annotations: ANNOT_APPEND,
    handler: async (client, { page, blocks }) => {
      const normalizedBlocks = normalizeBlocks(blocks);
      await getPageOrError(client, page as string);
      const appendedCount = await appendTreeToPage(client, page as string, normalizedBlocks);
      const blockTree = await getPageBlocks(client, page as string);
      return JSON.stringify({
        page,
        appended: appendedCount,
        blocks: blockTree.map(dumpBlock),
        block_count: countBlocks(blockTree),
      });
    },
  },

  {
    name: "block_prepend",
    description:
      "Prepend blocks to the TOP of an existing page (above all existing content). Same block formats as block_append. Blocks appear at the top in the order supplied.",
    inputSchema: {
      page: z.string().describe("Existing target page name with natural casing. NOT a journal date."),
      blocks: z.any().describe("Block(s) to insert. Accepts a string, an object {content, properties?, children?}, or a list mixing both."),
    },
    annotations: ANNOT_APPEND,
    handler: async (client, { page, blocks }) => {
      const normalizedBlocks = normalizeBlocks(blocks);
      await getPageOrError(client, page as string);
      const prependedCount = await appendTreeToPage(client, page as string, normalizedBlocks, true);
      const blockTree = await getPageBlocks(client, page as string);
      return JSON.stringify({
        page,
        prepended: prependedCount,
        blocks: blockTree.map(dumpBlock),
        block_count: countBlocks(blockTree),
      });
    },
  },

  {
    name: "block_update",
    description:
      "Overwrite the content of an existing block identified by UUID. Replaces the ENTIRE block body. Performs a readback after the update and warns (but still returns) if the stored content diverges. Do NOT prefix with bullet markers.",
    inputSchema: {
      uuid: z.string().describe("UUID of the target block (NOT a page name). Obtain it from get_page/get_block/page_outline."),
      content: z.string().describe("New markdown content for the block. Replaces the entire block body. Do NOT prefix with '- ' or '* '."),
    },
    annotations: ANNOT_UPDATE_IDEMPOTENT,
    handler: async (client, { uuid, content }) => {
      await client.call("logseq.Editor.updateBlock", uuid, content);
      const block = await getBlockOrError(client, uuid as string);
      if (block.content !== content) {
        console.error(`[lsmcp-node] block_update readback mismatch for ${uuid}`);
      }
      return JSON.stringify({ uuid: block.uuid, content: block.content });
    },
  },

  {
    name: "block_delete",
    description:
      "Delete a block and its entire subtree by UUID. Permanently removes the block AND all child blocks. No undo. Verify the UUID beforehand with get_block if unsure.",
    inputSchema: {
      uuid: z.string().describe("UUID of the target block (NOT a page name)."),
    },
    annotations: ANNOT_DELETE,
    handler: async (client, { uuid }) => {
      await getBlockOrError(client, uuid as string);
      await client.call("logseq.Editor.removeBlock", uuid);
      return JSON.stringify({ ok: true, uuid });
    },
  },

  {
    name: "delete_page",
    description:
      "Delete a page by name. PERMANENT and irreversible. Removes the page and all of its blocks. No undo/trash. Verify the page exists first if uncertain.",
    inputSchema: {
      name: z.string().describe("Target page name with natural casing. Resolved case-insensitively."),
    },
    annotations: ANNOT_DELETE,
    handler: async (client, { name }) => {
      await getPageOrError(client, name as string);
      await client.call("logseq.Editor.deletePage", name);
      return JSON.stringify({ ok: true, name });
    },
  },

  {
    name: "rename_page",
    description:
      "Rename a page from old_name to new_name. Pass new_name with natural casing — do NOT lowercase or slugify. NAMESPACE: consult get_namespace_map to ensure correct placement.",
    inputSchema: {
      old_name: z.string().describe("Current page name (natural casing). Must already exist."),
      new_name: z.string().describe("Desired new page name with natural casing. Becomes the display name; do NOT lowercase. Must not already exist."),
    },
    annotations: ANNOT_RENAME,
    handler: async (client, { old_name, new_name }) => {
      const on = old_name as string;
      const nn = new_name as string;
      if (!on.trim()) throw new Error("old_name must be a non-empty string");
      if (!nn.trim()) throw new Error("new_name must be a non-empty string");
      if (on === nn) throw new Error("new_name must differ from old_name");

      const existing = await getPageOrNone(client, nn);
      if (existing) throw new Error(`page already exists: ${nn}`);

      await client.call("logseq.Editor.renamePage", on, nn);

      const page = await getPageOrError(client, nn);
      if (page.name?.toLowerCase() !== nn.toLowerCase() && displayName(page) !== nn) {
        console.error(`[lsmcp-node] rename_page readback name mismatch: expected ${nn}`);
      }
      return JSON.stringify({ ok: true, old_name: on, new_name: nn });
    },
  },

  {
    name: "move_block",
    description:
      "Move a block (with its subtree) to a new position relative to a target block. position: 'before' (preceding sibling), 'after' (following sibling), or 'child' (child of target). May move across pages. Verifies the move afterwards.",
    inputSchema: {
      uuid: z.string().describe("UUID of the block to move."),
      target_uuid: z.string().describe("UUID of the target block."),
      position: z.string().describe("'before', 'after', or 'child'."),
    },
    annotations: ANNOT_UPDATE_IDEMPOTENT,
    handler: async (client, { uuid, target_uuid, position }) => {
      const pos = position as string;
      if (!["before", "after", "child"].includes(pos)) throw new Error("position must be one of: after, before, child");

      const block = await getBlockOrError(client, uuid as string);
      const target = await getBlockOrError(client, target_uuid as string);

      const destPageName = (await pageIdToName(client, target.page)) || (await pageIdToName(client, block.page));
      if (!destPageName) throw new Error(`page block tree unavailable for move: ${uuid}`);

      const subtreeUuids = collectSubtreeUuids(block);

      const opts: Record<string, unknown> = {};
      if (pos === "before") opts.before = true;
      else if (pos === "child") opts.children = true;

      await client.call("logseq.Editor.moveBlock", uuid, target_uuid, opts);

      const destTree = await getPageBlocks(client, destPageName);
      verifyBlockMoved(destTree, { movedUuid: uuid as string, targetUuid: target_uuid as string, position: pos, subtreeUuids });

      return JSON.stringify({ ok: true, uuid, target_uuid, position: pos });
    },
  },

  {
    name: "journal_today",
    description:
      "Get-or-create TODAY'S journal page and return its block tree. Takes no arguments. Use journal_append for a specific date, or journal_range to read a span.",
    inputSchema: {},
    annotations: ANNOT_UPDATE_IDEMPOTENT,
    handler: async (client) => {
      const pageName = resolveJournalPageName();
      const { page, created, blocks } = await ensureJournalPage(client, pageName);
      return JSON.stringify({
        page: dumpPage(page),
        created,
        blocks: blocks.map(dumpBlock),
        block_count: countBlocks(blocks),
      });
    },
  },

  {
    name: "journal_append",
    description:
      "Append blocks to a journal page for a given DATE, creating it if needed. `date` selects WHICH day's journal (ISO yyyy-MM-dd), unlike block_append which targets a named page. Accepts the same block formats as block_append.",
    inputSchema: {
      date: z.string().describe("ISO calendar date as yyyy-MM-dd (e.g. '2026-09-22')."),
      blocks: z.any().describe("Block(s) to insert. Accepts a string, an object {content, properties?, children?}, or a list mixing both."),
    },
    annotations: ANNOT_APPEND,
    handler: async (client, { date, blocks }) => {
      const pageName = resolveJournalPageName(date as string);
      const normalizedBlocks = normalizeBlocks(blocks);
      await ensureJournalPage(client, pageName);
      const appendedCount = await appendTreeToPage(client, pageName, normalizedBlocks);
      const blockTree = await getPageBlocks(client, pageName);
      return JSON.stringify({
        page: pageName,
        appended: appendedCount,
        blocks: blockTree.map(dumpBlock),
        block_count: countBlocks(blockTree),
      });
    },
  },

  {
    name: "journal_range",
    description:
      "Return journal entries for all EXISTING journal pages between two dates (inclusive). Days with no journal page are skipped. Range capped at 366 days.",
    inputSchema: {
      start_date: z.string().describe("Start date inclusive, ISO yyyy-MM-dd (e.g. '2026-09-01')."),
      end_date: z.string().describe("End date inclusive, ISO yyyy-MM-dd (e.g. '2026-09-22'). Must be on or after start_date."),
    },
    annotations: ANNOT_READ_ONLY,
    handler: async (client, { start_date, end_date }) => {
      let start: Date;
      let end: Date;
      try {
        start = parseIsoDate(start_date as string);
      } catch {
        throw new Error(`invalid start_date: ${start_date}`);
      }
      try {
        end = parseIsoDate(end_date as string);
      } catch {
        throw new Error(`invalid end_date: ${end_date}`);
      }
      if (start.getTime() > end.getTime()) throw new Error("start_date must be on or before end_date");

      const dates = iterInclusiveDates(start, end);

      const results = await Promise.all(
        dates.map(async (day) => {
          const dayStr = toIsoDate(day);
          const page = await getPageOrNone(client, dayStr);
          if (!page) return null;
          if (!isJournal(page)) throw new Error(`resolved page is not a journal page: ${dayStr}`);
          const blockTree = await getPageBlocks(client, dayStr);
          return {
            page: dumpPage(page),
            blocks: blockTree.map(dumpBlock),
            block_count: countBlocks(blockTree),
          };
        }),
      );
      const entries = results.filter((r): r is NonNullable<typeof r> => r !== null);

      return JSON.stringify({
        start_date,
        end_date,
        days: dates.length,
        entries,
        entry_count: entries.length,
      });
    },
  },
];
