/** Persistent, bounded-context summary tree following Taelin's UniiChat recipe.
 * Originals never change. This index is lossy; zoom always reads the original.
 * SQL names intentionally do not overlap Pi's pi_* tables.
 */
export interface MemorySql {
  exec(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): Record<string, unknown>[] };
}
export interface Part {
  level: number;
  index: number;
}
export interface CompressionInput {
  source: string;
  context: string;
  kind: "leaf" | "merge";
  id: number;
  count: number;
}
export type Compressor = (input: CompressionInput) => Promise<string>;
export interface MemoryOptions {
  highBytes?: number;
  lowBytes?: number;
  nodeBytes?: number;
}
type View = { parts: Part[]; merging: boolean };
const encoder = new TextEncoder();
export const utf8Bytes = (s: string) => encoder.encode(s).length;
const flat = (s: string) => s.replace(/[\r\n]+/g, " ");
const start = (p: Part) => p.index * 2 ** p.level;
const end = (p: Part) => start(p) + 2 ** p.level;
const placeholder = "(not summarized yet: zoom it)";
/** Eligible pair with greatest age measured from its LAST message, oldest tie first. */
export function mostDue(
  parts: readonly Part[],
  total: number,
  built: (p: Part) => boolean,
): number {
  let best = -1,
    score = -Infinity;
  for (let k = 0; k + 1 < parts.length; k++) {
    const a = parts[k],
      b = parts[k + 1];
    if (a.level !== b.level || a.index % 2 !== 0 || b.index !== a.index + 1)
      continue;
    const due = (total - (end(b) - 1)) / 2 ** a.level;
    if (due > score && built({ level: a.level + 1, index: a.index / 2 })) {
      best = k;
      score = due;
    }
  }
  return best;
}
export class MemoryStore {
  private readonly high: number;
  private readonly low: number;
  private readonly nodeLimit: number;
  private settling?: Promise<{
    built: number;
    failed: number;
    pending: number;
  }>;
  private readonly sql: MemorySql;
  constructor(sql: MemorySql, options: MemoryOptions = {}) {
    this.sql = sql;
    this.high = options.highBytes ?? 128_000;
    this.low = options.lowBytes ?? 64_000;
    this.nodeLimit = options.nodeBytes ?? 512;
    if (!(this.low > 0 && this.high > this.low && this.nodeLimit > 0))
      throw new Error("Invalid memory budgets");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS mem_log (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, date TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS mem_nodes (level INTEGER NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(level,idx))",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS mem_jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, level INTEGER NOT NULL, idx INTEGER NOT NULL, UNIQUE(level,idx))",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS mem_state (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    for (const name of ["chat", "compact"])
      sql.exec(
        "INSERT OR IGNORE INTO mem_state(name,value) VALUES (?,?)",
        name,
        JSON.stringify({ parts: [], merging: false }),
      );
  }
  private rows(q: string, ...args: (string | number | null)[]) {
    return this.sql.exec(q, ...args).toArray();
  }
  private total() {
    return Number(
      this.rows("SELECT COALESCE(MAX(id)+1,0) AS n FROM mem_log")[0].n,
    );
  }
  private view(name: string): View {
    return JSON.parse(
      String(
        this.rows("SELECT value FROM mem_state WHERE name=?", name)[0].value,
      ),
    );
  }
  private save(name: string, v: View) {
    this.sql.exec(
      "UPDATE mem_state SET value=? WHERE name=?",
      JSON.stringify(v),
      name,
    );
  }
  private node(p: Part): string | undefined {
    const r = this.rows(
      "SELECT text FROM mem_nodes WHERE level=? AND idx=?",
      p.level,
      p.index,
    )[0];
    return r ? String(r.text) : undefined;
  }
  private queue(p: Part) {
    if (this.node(p) === undefined)
      this.sql.exec(
        "INSERT OR IGNORE INTO mem_jobs(level,idx) VALUES (?,?)",
        p.level,
        p.index,
      );
  }
  private commitNode(p: Part, text: string) {
    this.sql.exec(
      "INSERT OR IGNORE INTO mem_nodes(level,idx,text) VALUES (?,?,?)",
      p.level,
      p.index,
      text,
    );
    this.sql.exec(
      "DELETE FROM mem_jobs WHERE level=? AND idx=?",
      p.level,
      p.index,
    );
    if (
      this.node({
        level: p.level,
        index: p.index % 2 ? p.index - 1 : p.index + 1,
      }) !== undefined
    )
      this.queue({ level: p.level + 1, index: Math.floor(p.index / 2) });
  }
  /** Caller serializes appends with its Durable Object. For tools, cap output before append. */
  append(kind: string, text: string, date = new Date().toISOString()): number {
    if (/^(thoughts?|thinking|reasoning)$/i.test(kind))
      throw new Error("Private reasoning must not be logged");
    const id = this.total();
    this.sql.exec(
      "INSERT INTO mem_log(id,kind,text,date) VALUES (?,?,?,?)",
      id,
      kind,
      text,
      date,
    );
    const part = { level: 0, index: id };
    for (const name of ["chat", "compact"]) {
      const v = this.view(name);
      v.parts.push(part);
      this.save(name, v);
    }
    const source = `${kind}: ${text}`;
    if (utf8Bytes(source) <= this.nodeLimit) this.commitNode(part, source);
    else this.queue(part);
    this.fitViews();
    return id;
  }
  private line(p: Part) {
    return `${start(p)}+${2 ** p.level}|${flat(this.node(p) ?? placeholder)}`;
  }
  private size(v: View) {
    return utf8Bytes(
      `<chat>\n${v.parts.map((p) => this.line(p)).join("\n")}\n</chat>`,
    );
  }
  private fit(name: string, high: number, low: number, force = false) {
    const v = this.view(name);
    const original = v.parts.length;
    if (force || this.size(v) > high) v.merging = true;
    while (v.merging && this.size(v) > low) {
      const k = mostDue(
        v.parts,
        this.total(),
        (p) => this.node(p) !== undefined,
      );
      if (k < 0) break;
      const a = v.parts[k];
      v.parts.splice(k, 2, { level: a.level + 1, index: a.index / 2 });
    }
    if (this.size(v) <= low) v.merging = false;
    this.save(name, v);
    return v.parts.length < original;
  }
  private fitViews() {
    const changed = this.fit("chat", this.high, this.low);
    this.fit("compact", this.high / 4, this.low / 4, changed);
  }
  renderView(): string {
    return `<chat>\n${this.view("chat")
      .parts.map((p) => this.line(p))
      .join("\n")}\n</chat>`;
  }
  private compressionContext(p: Part) {
    const stop = p.level === 0 ? start(p) : end(p);
    const lines: string[] = [];
    for (const q of this.view("compact").parts) {
      if (end(q) > stop || this.node(q) === undefined) break;
      lines.push(this.line(q));
    }
    return `<chat>\n${lines.join("\n")}\n</chat>`;
  }
  /** At most eight contextual compressions concurrently. Failures remain queued for next turn. */
  settle(
    compress: Compressor,
    maxJobs = 256,
  ): Promise<{ built: number; failed: number; pending: number }> {
    if (this.settling) return this.settling;
    this.settling = this.run(compress, maxJobs).finally(() => {
      this.settling = undefined;
    });
    return this.settling;
  }
  private async run(compress: Compressor, maxJobs: number) {
    let built = 0,
      failed = 0,
      attempted = 0;
    const failedKeys = new Set<string>();
    while (attempted < maxJobs) {
      // Query ready queues, never walk the historical tree. The first eight
      // unbuilt leaves impose the recipe's causal window even after failures.
      const leaves = this.rows(
        "SELECT seq,level,idx FROM mem_jobs WHERE level=0 ORDER BY idx LIMIT 8",
      );
      const merges = this.rows(
        "SELECT seq,level,idx FROM mem_jobs WHERE level>0 ORDER BY seq LIMIT ?",
        maxJobs + failedKeys.size,
      );
      const jobs = [...leaves, ...merges]
        .sort((a, b) => Number(a.seq) - Number(b.seq))
        .map((r) => ({ level: Number(r.level), index: Number(r.idx) }))
        .filter((p) => !failedKeys.has(`${p.level}:${p.index}`))
        .slice(0, Math.min(8, maxJobs - attempted));
      if (!jobs.length) break;
      attempted += jobs.length;
      await Promise.all(
        jobs.map(async (p) => {
          try {
            let source: string;
            if (!p.level) {
              const r = this.rows(
                "SELECT kind,text FROM mem_log WHERE id=?",
                p.index,
              )[0];
              source = `${r.kind}: ${r.text}`;
            } else {
              const a = this.node({ level: p.level - 1, index: 2 * p.index });
              const b = this.node({
                level: p.level - 1,
                index: 2 * p.index + 1,
              });
              if (a === undefined || b === undefined)
                throw new Error("Children not built");
              source = `${a}\n${b}`;
            }
            let summary = source;
            if (utf8Bytes(source) > this.nodeLimit) {
              let shortest: string | undefined;
              const input: CompressionInput = {
                source,
                context: this.compressionContext(p),
                kind: p.level ? "merge" : "leaf",
                id: start(p),
                count: 2 ** p.level,
              };
              for (let retry = 0; retry < 5; retry++) {
                const extra = retry
                  ? `\nPrevious summary was ${utf8Bytes(summary)} UTF-8 bytes. Rewrite shorter; limit ${this.nodeLimit} bytes. Previous: ${summary}`
                  : "";
                summary = flat(
                  (
                    await compress({ ...input, source: input.source + extra })
                  ).trim(),
                );
                if (!summary) throw new Error("Empty summary");
                if (
                  shortest === undefined ||
                  utf8Bytes(summary) < utf8Bytes(shortest)
                )
                  shortest = summary;
                if (utf8Bytes(summary) <= this.nodeLimit) break;
              }
              summary = shortest!;
              // The recipe allows slightly oversized shortest attempts, but never expansion.
              if (utf8Bytes(summary) >= utf8Bytes(source))
                throw new Error("Summary did not compress");
            }
            this.commitNode(p, summary);
            built++;
          } catch {
            failed++;
            failedKeys.add(`${p.level}:${p.index}`);
          }
        }),
      );
      this.fitViews();
    }
    return { built, failed, pending: this.stats().pending };
  }
  zoom(id: number, count: number, offset = 0) {
    if (
      !Number.isSafeInteger(id) ||
      id < 0 ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      !Number.isInteger(Math.log2(count)) ||
      id % count ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error(
        "zoom requires aligned id, power-of-two count, and nonnegative offset",
      );
    if (id + count > this.total())
      throw new Error("Memory range does not exist");
    if (count === 1) {
      const r = this.rows(
        "SELECT kind,text,date FROM mem_log WHERE id=?",
        id,
      )[0];
      const text = String(r.text);
      return {
        id,
        count,
        kind: String(r.kind),
        date: String(r.date),
        text: text.slice(offset, offset + 2_000),
        nextOffset: offset + 2_000 < text.length ? offset + 2_000 : null,
      };
    }
    const level = Math.log2(count) - 1;
    return {
      id,
      count,
      children: [0, 1].map((n) => {
        const p = { level, index: id / (count / 2) + n };
        return {
          id: start(p),
          count: count / 2,
          text: this.node(p) ?? placeholder,
        };
      }),
    };
  }
  date(id: number) {
    const r = this.rows("SELECT date FROM mem_log WHERE id=?", id)[0];
    if (!r) throw new Error("Message does not exist");
    return String(r.date);
  }
  stats() {
    return {
      messages: this.total(),
      nodes: Number(this.rows("SELECT COUNT(*) AS n FROM mem_nodes")[0].n),
      pending: Number(this.rows("SELECT COUNT(*) AS n FROM mem_jobs")[0].n),
      viewBytes: this.size(this.view("chat")),
    };
  }
}
export { MemoryStore as DurableMemory };
