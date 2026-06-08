import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// M — durable memory: a sparse, name-addressed store mirrored to a JSON file so it survives
// power-off. Sibling to the terminal channel; the harness reads/writes both.
// All storage-backend concerns (mirroring, format) live here, not in the machine.
export class Memory {
    private cells = new Map<string, string>();

    constructor(private path: string) {
        this.load();
    }

    private load() {
        if (!existsSync(this.path)) return;
        try {
            const obj = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>;
            this.cells = new Map(Object.entries(obj));
        } catch {
            /* corrupt disk image → boot with empty M */
        }
    }

    private save() {
        writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.cells), null, 2));
    }

    get(addr: string): string | undefined {
        return this.cells.get(addr);
    }

    set(addr: string, value: string) {
        this.cells.set(addr, value);
        this.save();
    }

    // The only removing operation. In an append-only/overwrite store this is the only way to
    // truly drop a fact or routine (i.e. to change one's mind). Returns whether it existed.
    delete(addr: string): boolean {
        const had = this.cells.delete(addr);
        if (had) this.save();
        return had;
    }

    keys(): string[] {
        return [...this.cells.keys()];
    }

    // Find entries relevant to a query (lexical overlap; key matches weigh more). The directory
    // is QUERIED, not held resident — this is what lets the library grow without flooding the
    // context or tempting the agent into spurious invocations. Swap lexical → embeddings here
    // without touching callers.
    search(query: string, limit = 6): { key: string; value: string }[] {
        const terms = query.toLowerCase().split(/\W+/).filter(t => t.length > 1);
        if (!terms.length) return [];
        const scored = [...this.cells.entries()].map(([key, value]) => {
            const key_l = key.toLowerCase();
            const hay = key_l + ' ' + value.toLowerCase();
            let score = 0;
            for (const t of terms) {
                if (hay.includes(t)) score += 1;
                if (key_l.includes(t)) score += 2;
            }
            return { key, value, score };
        });
        return scored
            .filter(e => e.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(({ key, value }) => ({ key, value }));
    }

    entries(): [string, string][] {
        return [...this.cells.entries()];
    }

    get size(): number {
        return this.cells.size;
    }

    // operator console power: wipe the durable disk (no operation can delete)
    clear() {
        this.cells.clear();
        this.save();
    }
}
