import { coerceBlock, coercePage, displayName } from "./types";
import type { BlockEntity, PageEntity } from "./types";

const CACHEABLE_METHODS = new Set<string>([
  "logseq.App.getCurrentGraph",
  "logseq.Editor.getAllPages",
  "logseq.Editor.getPage",
  "logseq.Editor.getPageBlocksTree",
  "logseq.Editor.getBlock",
  "logseq.Editor.getPagesFromNamespace",
  "logseq.Editor.getPagesTreeFromNamespace",
  "logseq.Editor.getPageLinkedReferences",
]);

const WRITE_MARKERS = [
  "createPage", "updateBlock", "removeBlock", "deletePage", "renamePage",
  "moveBlock", "insertBatchBlock", "appendBlockInPage", "prependBlockInPage",
  "insertBlock", "editBlock", "exitEditingMode",
];

function isWriteMethod(method: string): boolean {
  return WRITE_MARKERS.some((marker) => method.includes(marker));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

export class LogseqClient {
  private readonly url: string;
  private readonly token: string;
  private readonly cacheTtl: number;
  private readonly timeoutMs: number;
  private readonly sem = new Semaphore(4);
  private cache = new Map<string, CacheEntry>();

  constructor() {
    this.url = process.env.LOGSEQ_API_URL || "http://127.0.0.1:12315";
    const token = process.env.LOGSEQ_API_TOKEN;
    if (!token) {
      throw new Error(
        "LOGSEQ_API_TOKEN environment variable is required. " +
          "Set it in your MCP client config or shell environment.",
      );
    }
    this.token = token;
    const ttl = parseFloat(process.env.LOGSEQ_CACHE_TTL_SECONDS || "60");
    this.cacheTtl = ttl > 0 ? ttl * 1000 : 0;
    this.timeoutMs = parseFloat(process.env.LOGSEQ_API_TIMEOUT || "30") * 1000;
  }

  invalidateCache(): void {
    this.cache.clear();
  }

  private cacheKey(method: string, args: unknown[]): string {
    return method + "\u0000" + JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? String(v) : v));
  }

  async call(method: string, ...args: unknown[]): Promise<any> {
    const cacheable = this.cacheTtl > 0 && CACHEABLE_METHODS.has(method);
    let key = "";
    if (isWriteMethod(method)) {
      this.cache.clear();
    } else if (cacheable) {
      key = this.cacheKey(method, args);
      const entry = this.cache.get(key);
      if (entry && entry.expires > Date.now()) return entry.value;
    }

    const payload = JSON.stringify({ method, args });
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` };

    await this.sem.acquire();
    try {
      let backoff = 100;
      let lastErr: unknown = null;
      let sawTransportFailure = false;
      // Only retry idempotent (read) calls. Replaying a write after a 5xx or a
      // timeout could duplicate blocks (createPage/appendBlockInPage/...).
      const maxAttempts = isWriteMethod(method) ? 1 : 4;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          await sleep(backoff);
          backoff *= 2;
        }
        let resp: Response;
        try {
          resp = await fetch(`${this.url}/api`, {
            method: "POST",
            headers,
            body: payload,
            signal: AbortSignal.timeout(this.timeoutMs),
          });
        } catch (err) {
          lastErr = err;
          sawTransportFailure = true;
          continue;
        }
        if (resp.status >= 500) {
          lastErr = new Error(`Logseq API error ${resp.status}: ${await resp.text()}`);
          continue;
        }
        if (resp.status !== 200) {
          throw new Error(`Logseq API error ${resp.status}: ${await resp.text()}`);
        }
        const result = await resp.json();
        if (cacheable) {
          this.cache.set(key, { expires: Date.now() + this.cacheTtl, value: result });
        }
        return result;
      }

      if (sawTransportFailure) {
        throw new Error(`Logseq is not running or unreachable at ${this.url}`);
      }
      throw new Error(lastErr instanceof Error ? lastErr.message : String(lastErr));
    } finally {
      this.sem.release();
    }
  }

  async getAllPages(): Promise<PageEntity[]> {
    const raw = await this.call("logseq.Editor.getAllPages");
    return Array.isArray(raw) ? raw.map(coercePage) : [];
  }

  async getPage(name: string): Promise<PageEntity | null> {
    const raw = await this.call("logseq.Editor.getPage", name);
    return raw ? coercePage(raw) : null;
  }

  async getPageBlocksTree(name: string): Promise<BlockEntity[]> {
    const raw = await this.call("logseq.Editor.getPageBlocksTree", name);
    return Array.isArray(raw) ? raw.map(coerceBlock) : [];
  }

  async getBlock(uuid: string, includeChildren = true): Promise<BlockEntity | null> {
    const raw = await this.call("logseq.Editor.getBlock", uuid, { includeChildren });
    return raw ? coerceBlock(raw) : null;
  }

  async getPageLinkedReferences(name: string): Promise<Array<[PageEntity, BlockEntity[]]> | null> {
    const raw = await this.call("logseq.Editor.getPageLinkedReferences", name);
    if (!Array.isArray(raw)) return null;
    return raw
      .filter((ref) => Array.isArray(ref) && ref.length >= 2)
      .map((ref) => [coercePage(ref[0]), (Array.isArray(ref[1]) ? ref[1] : []).map(coerceBlock)]);
  }

  async idToNameMap(): Promise<Map<number, string>> {
    const pages = await this.getAllPages();
    const map = new Map<number, string>();
    for (const page of pages) {
      if (page.id && page.name) map.set(page.id, displayName(page) || page.name);
    }
    return map;
  }
}
