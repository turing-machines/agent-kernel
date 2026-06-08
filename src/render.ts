import { preview } from './format.js';
import type { Frame } from './frame.js';
import type { Memory } from './memory.js';
import type { ChatEvent, Operation, StepInfo } from './types.js';

// ANSI markup helpers — formatters return pre-colored strings; Ink <Text> renders them and
// measures width with string-width, so colour never throws layout/borders off.
const CODE: Record<string, string> = {
    'gray-fg': '90', 'red-fg': '31', 'green-fg': '32', 'yellow-fg': '33',
    'blue-fg': '34', 'magenta-fg': '35', 'cyan-fg': '36', 'white-fg': '37',
};
const s = (style: string, t: string) => `\x1b[${CODE[style] ?? '0'}m${t}\x1b[0m`;
const b = (style: string, t: string) => `\x1b[1;${CODE[style] ?? '0'}m${t}\x1b[0m`;
const dim = (t: string) => `\x1b[90m${t}\x1b[0m`;
const fmtTok = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

// ---- left pane: conversation / agent activity ----------------------------------------------

export function chatLine(ev: ChatEvent): string {
    const pad = '  '.repeat('depth' in ev ? ev.depth : 0);
    switch (ev.kind) {
        case 'user':
            return `\n${b('cyan-fg', 'you ▸')} ${ev.text}`;
        case 'say':
            return ev.depth === 0
                ? `\n${b('green-fg', '◆ machine ▸')} ${ev.text}`
                : `${pad}${b('magenta-fg', `↳ ${ev.frame} ▸`)} ${ev.text}`;
        case 'invoke':
            return `${pad}${s('magenta-fg', `▶ invoke ${ev.name}`)}${ev.args ? dim(`(${preview(ev.args, 30)})`) : ''}`;
        case 'return':
            return `${pad}${s('green-fg', `◀ ${ev.name}`)} ${dim('→')} ${s('cyan-fg', `"${preview(ev.value, 40)}"`)}`;
    }
}

// ---- right pane (top): the action stream ---------------------------------------------------
// One step = a header + its operations. No memory dump here (that lives in the live state box),
// so the stream stays clean and scannable; nesting shows via indentation + a per-depth bar.

function opLine(op: Operation, ret?: string): string {
    const a = op.input as { addr?: string; value?: string; channel?: string; name?: string; args?: string; code?: string; query?: string };
    const out = ret !== undefined ? `  ${dim('→')} ${s('cyan-fg', `"${preview(ret, 32)}"`)}` : '';
    const O = (color: string, name: string) => b(color, name.padEnd(8));
    const key = (t: string) => s('white-fg', t);
    switch (op.name) {
        case 'remember':
            return `${O('yellow-fg', 'remember')} ${key(String(a.addr))} ${dim(`← "${preview(String(a.value ?? ''), 26)}"`)}`;
        case 'recall':
            return `${O('cyan-fg', 'recall')} ${key(String(a.addr))}${out}`;
        case 'search':
            return `${O('cyan-fg', 'search')} ${key(`"${preview(String(a.query ?? ''), 20)}"`)}${out}`;
        case 'forget':
            return `${O('red-fg', 'forget')} ${key(String(a.addr))}${out}`;
        case 'perceive':
            return `${O('green-fg', 'perceive')} ${dim(String(a.channel))}${out}`;
        case 'act':
            return `${O('green-fg', 'act')} ${dim(`→ ${a.channel}`)}`;
        case 'wait':
            return `${O('magenta-fg', 'wait')} ${dim('halt')}`;
        case 'invoke':
            return `${O('magenta-fg', 'invoke')} ${key(String(a.name))}${a.args ? dim(` (${preview(String(a.args), 16)})`) : ''}${out}`;
        case 'return':
            return `${O('green-fg', 'return')} ${dim('↩')} ${s('cyan-fg', `"${preview(String(a.value ?? ''), 26)}"`)}`;
        case 'exec':
            return `${O('yellow-fg', 'exec')} ${dim(preview(String(a.code ?? ''), 26))}${out}`;
        default:
            return `${O('red-fg', op.name)} ${dim(JSON.stringify(a))}`;
    }
}

export function traceStep(info: StepInfo, globalN: number): string {
    const ind = '  '.repeat(info.depth);
    const bar = info.depth === 0 ? '' : dim('│ '.repeat(info.depth));
    const frameTag = info.depth === 0 ? s('cyan-fg', 'main') : `${s('magenta-fg', info.frame)}${dim('·d' + info.depth)}`;
    const yk = { wait: s('magenta-fg', '◌ wait'), endturn: s('magenta-fg', '◌ turn'), none: s('green-fg', '● run') }[info.yieldKind];
    const meta = dim(`${(info.ms / 1000).toFixed(1)}s · ↑${info.usage.input} ↓${info.usage.output}`);

    const lines: string[] = [];
    lines.push(`\n${bar}${b('blue-fg', `▸ ${globalN}`)}  ${frameTag}  ${yk}  ${meta}`);
    if (info.fold) lines.push(`${bar}  ${s('magenta-fg', '↯ fold')} ${dim(`${info.fold.msgs} msgs → ${info.fold.key}`)}`);
    if (info.monologue) lines.push(`${bar}${dim('  “' + preview(info.monologue, 58) + '”')}`);
    if (info.operations.length) {
        const ret = new Map(info.results.map(r => [r.toolUseId, r.content]));
        for (const op of info.operations) lines.push(`${bar}  ${opLine(op, ret.get(op.id))}`);
    } else {
        lines.push(`${bar}  ${dim('· (just spoke)')}`);
    }
    return lines.join('\n');
}

// ---- right pane (bottom): live state — updated in place, not appended ----------------------

export function stateLine(mem: Memory, mainMsgs: number, mainTok: number, foldBudget: number, step: number): string {
    const keys = mem.keys();
    const keyStr = keys.length ? keys.map(k => s('yellow-fg', k)).join(dim('  ')) : dim('(empty)');
    // current input tokens / fold budget — colour warms as it nears the fold, so you see it coming
    const pct = foldBudget > 0 ? mainTok / foldBudget : 0;
    const tokColor = pct >= 0.85 ? 'magenta-fg' : pct >= 0.6 ? 'yellow-fg' : 'green-fg';
    const tok = `${s(tokColor, fmtTok(mainTok))}${dim('/' + fmtTok(foldBudget) + ' tok')}`;
    const foldHint = pct >= 0.85 ? `  ${s('magenta-fg', '↯ fold soon')}` : '';
    return [
        ` ${b('yellow-fg', `M·${keys.length}`)}  ${keyStr}`,
        ` ${b('cyan-fg', 'C·main')} ${mainMsgs} msgs · ${tok}${foldHint}    ${dim('│')}    ${b('blue-fg', 'steps')} ${step}`,
    ].join('\n');
}

// ---- on-demand dumps (to the action stream) ------------------------------------------------

export function memDump(mem: Memory): string {
    const cells = mem.entries();
    const lines = [`\n${b('yellow-fg', `── M — memory [${cells.length} cells] ──`)}`];
    if (!cells.length) lines.push(dim('  (empty)'));
    for (const [k, v] of cells) lines.push(`  ${s('yellow-fg', k)}: ${dim(preview(v, 76))}`);
    return lines.join('\n');
}

export function ctxDump(frame: Frame, n: number): string {
    const slice = frame.C.slice(-n);
    const lines = [`\n${b('blue-fg', `── C (main) — last ${slice.length} of ${frame.C.length} ──`)}`];
    for (const msg of slice) {
        const role = msg.role === 'assistant' ? s('cyan-fg', 'assistant') : s('white-fg', 'user');
        const body =
            typeof msg.content === 'string'
                ? msg.content
                : msg.content
                      .map(blk => {
                          if (blk.type === 'text') return blk.text;
                          if (blk.type === 'tool_use') return `«${blk.name} ${JSON.stringify(blk.input)}»`;
                          if (blk.type === 'tool_result') return `→ ${typeof blk.content === 'string' ? blk.content : JSON.stringify(blk.content)}`;
                          return `[${blk.type}]`;
                      })
                      .join(' | ');
        lines.push(`  ${role}: ${dim(preview(body, 76))}`);
    }
    return lines.join('\n');
}
