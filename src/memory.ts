import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface MemoryEntry {
  id: string;
  /** Optional stable key — remembering the same key again replaces the entry. */
  key?: string;
  text: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  /** Entry expires this many hours after updatedAt; omit for no expiry. */
  ttlHours?: number;
}

type MemoryOp = MemoryEntry | { deleted: string; ts: string };

const ID_RE = /^[a-f0-9]{12}$/;
export const MEMORY_TEXT_LIMIT = 16_384;

/**
 * Shared recall store for cross-agent memory: notes any agent (MCP, proxy
 * HTTP, CLI) can write and every other agent can search, so a fact learned
 * once is never re-derived — paying its tokens once instead of per session.
 *
 * Persistence is an append-only JSONL op log (entry snapshots + tombstones),
 * replayed last-write-wins on load. Appends are atomic per line, so the
 * daemon, MCP processes, and the CLI can write concurrently without
 * clobbering each other the way a read-modify-write JSON file would. The log
 * is re-read on every operation (same pattern as the MCP ledger reads) so
 * each surface always sees fresh data and none needs the daemon running.
 */
export class Memory {
  constructor(private path: string) {}

  private load(now = Date.now()): Map<string, MemoryEntry> {
    const byId = new Map<string, MemoryEntry>();
    const idByKey = new Map<string, string>();
    if (!existsSync(this.path)) return byId;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let op: MemoryOp;
      try {
        op = JSON.parse(line);
      } catch {
        continue;
      }
      if ("deleted" in op) {
        byId.delete(op.deleted);
        continue;
      }
      if (typeof op.id !== "string" || typeof op.text !== "string") continue;
      if (op.key) {
        const prev = idByKey.get(op.key);
        if (prev !== undefined && prev !== op.id) byId.delete(prev);
        idByKey.set(op.key, op.id);
      }
      byId.set(op.id, op);
    }
    for (const [id, e] of byId) {
      if (e.ttlHours !== undefined && Date.parse(e.updatedAt) + e.ttlHours * 3_600_000 <= now) {
        byId.delete(id);
      }
    }
    return byId;
  }

  private append(op: MemoryOp): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(op) + "\n", "utf8");
  }

  remember(input: {
    text: string;
    key?: string;
    tags?: string[];
    ttlHours?: number;
  }): MemoryEntry {
    const text = input.text.trim();
    if (!text) throw new Error("memory: text must be non-empty");
    if (text.length > MEMORY_TEXT_LIMIT) {
      throw new Error(`memory: text exceeds ${MEMORY_TEXT_LIMIT} chars — memory is for distilled notes, not raw content (use the compression store for that)`);
    }
    const now = new Date().toISOString();
    let createdAt = now;
    if (input.key) {
      const existing = [...this.load().values()].find((e) => e.key === input.key);
      if (existing) createdAt = existing.createdAt;
    }
    const entry: MemoryEntry = {
      id: randomBytes(6).toString("hex"),
      ...(input.key && { key: input.key }),
      text,
      ...(input.tags && input.tags.length > 0 && { tags: input.tags }),
      createdAt,
      updatedAt: now,
      ...(input.ttlHours !== undefined && { ttlHours: input.ttlHours }),
    };
    this.append(entry);
    return entry;
  }

  forget(id: string): boolean {
    if (!ID_RE.test(id)) return false;
    if (!this.load().has(id)) return false;
    this.append({ deleted: id, ts: new Date().toISOString() });
    return true;
  }

  list(): MemoryEntry[] {
    return [...this.load().values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  /**
   * Keyword search: case-insensitive whole-ish word overlap against text, key,
   * and tags, ranked by matched-term count then recency. Deterministic and
   * dependency-free on purpose — notes are short, so term overlap beats the
   * cost of embeddings here.
   */
  recall(query: string, opts?: { tag?: string; limit?: number }): MemoryEntry[] {
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
    const limit = opts?.limit ?? 5;
    let candidates = this.list();
    if (opts?.tag) candidates = candidates.filter((e) => e.tags?.includes(opts.tag!));
    if (terms.length === 0) return candidates.slice(-limit).reverse();

    const scored = candidates
      .map((entry) => {
        const hay = [entry.text, entry.key ?? "", ...(entry.tags ?? [])].join(" ").toLowerCase();
        const score = terms.filter((t) => hay.includes(t)).length;
        return { entry, score };
      })
      .filter((s) => s.score > 0);
    scored.sort(
      (a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt),
    );
    return scored.slice(0, limit).map((s) => s.entry);
  }
}

/** One-line rendering used by every surface, so recall output stays compact. */
export function formatEntry(e: MemoryEntry): string {
  const tags = e.tags?.length ? ` #${e.tags.join(" #")}` : "";
  const key = e.key ? ` (key: ${e.key})` : "";
  return `[${e.id}]${key}${tags} ${e.text}`;
}
