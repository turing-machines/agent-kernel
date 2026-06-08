// Display formatting helpers (plain string shaping; color/markup lives in render.ts + tui.ts).

// truncate a single-line preview of a (possibly long, multiline) value
export function preview(s: string, max = 60): string {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}
