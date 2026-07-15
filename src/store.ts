import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ID_RE = /^[a-f0-9]{12}$/;

/**
 * Content-addressed store for pre-compression originals. Compression is
 * reversible: every compressed block carries its id, and the original can be
 * fetched via `GET /retrieve/<id>` on the daemon or `limitbreak retrieve <id>`.
 */
export class Store {
  constructor(private dir: string) {}

  save(text: string): string {
    const id = createHash("sha256").update(text).digest("hex").slice(0, 12);
    const path = join(this.dir, `${id}.txt`);
    try {
      mkdirSync(this.dir, { recursive: true });
      if (!existsSync(path)) writeFileSync(path, text, "utf8");
    } catch {
      // Storage failure must not break the call; retrieval just won't work.
    }
    return id;
  }

  load(id: string): string | null {
    if (!ID_RE.test(id)) return null;
    const path = join(this.dir, `${id}.txt`);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }
}
