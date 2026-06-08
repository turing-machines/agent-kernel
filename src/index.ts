import { writeSync } from 'node:fs';
import { createElement } from 'react';
import { render } from 'ink';
import { config } from './config.js';
import { Memory } from './memory.js';
import { Terminal } from './terminal.js';
import { Frame, type World } from './frame.js';
import { SYSTEM } from './system.js';
import { UiStore } from './ui-store.js';
import { App } from './app.js';
import { traceStep, chatLine, stateLine, memDump, ctxDump } from './render.js';

if (!config.apiKey) {
    console.error('No ANTHROPIC_API_KEY (set it in your shell, or copy .env.example to .env)');
    process.exit(1);
}

// Alternate screen buffer: own the whole screen like vim/less, then restore the terminal exactly
// on exit — no scrollback pollution, no leftover frame, no main-buffer overflow.
const ALT_ENTER = '\x1b[?1049h\x1b[2J\x1b[H';
const ALT_LEAVE = '\x1b[?1049l';
let altActive = false;
// writeSync (blocking) so the leave sequence always flushes before the process exits — otherwise
// the terminal would be left stuck in the alternate buffer.
const enterAlt = () => { if (!altActive) { writeSync(1, ALT_ENTER); altActive = true; } };
const leaveAlt = () => { if (altActive) { writeSync(1, ALT_LEAVE); altActive = false; } };
process.on('exit', leaveAlt);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => { leaveAlt(); process.exit(0); });
}
process.on('uncaughtException', err => { leaveAlt(); console.error(err); process.exit(1); });

const store = new UiStore(config.model);
const mem = new Memory(config.memFile);
const term = new Terminal();
let globalStep = 0;
let mainMsgs = 0;
let mainTok = 0;
let mainInput = 0;
let mainBreakdown = { tools: 0, system: 0, recap: 0, work: 0 };

// Continue episode numbering past any episodes already in M (so restarts don't overwrite).
const lastEpisode = mem.keys().reduce((max, k) => {
    const m = /^episode\/(\d+)$/.exec(k);
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
}, 0);

// Shared world: each step appends to the action stream; the live state box is refreshed in place.
const world: World = {
    system: SYSTEM,
    mem,
    term,
    onStep: info => {
        store.trace(traceStep(info, ++globalStep));
        if (info.depth === 0) { mainMsgs = info.ctxMsgs; mainTok = info.ctxTok; mainInput = info.usage.input; mainBreakdown = info.breakdown; }
        store.state(stateLine({ mem, msgs: mainMsgs, cTok: mainTok, foldBudget: config.foldBudget, inputTok: mainInput, step: globalStep, breakdown: mainBreakdown }));
    },
    onEvent: ev => store.chat(chatLine(ev)),
    maxSteps: config.maxSteps,
    maxDepth: config.maxDepth,
    foldBudget: config.foldBudget,
    foldKeepTail: config.foldKeepTail,
    recapEpisodes: config.recapEpisodes,
    episodeN: lastEpisode,
};

const main = new Frame(world, 0, 'main'); // frame 0 — the resident agent

// User input: a /command (to the harness) or plain input (to the shared terminal — the single
// input path). Plain input is echoed to the conversation pane.
store.onSubmit(raw => {
    const t = raw.trim();
    if (t === '') return;
    if (t === '/quit' || t === '/q') process.exit(0);
    if (t === '/mem' || t === '/m') return store.trace(memDump(mem));
    if (t === '/wipe') { mem.clear(); return store.trace('\n\x1b[90mdurable memory M wiped\x1b[0m'); }
    if (t.startsWith('/c')) return store.trace(ctxDump(main, parseInt(t.slice(2).trim(), 10) || 6));
    store.chat(chatLine({ kind: 'user', text: raw }));
    term.push(raw);
});

enterAlt();
const ink = render(createElement(App, { store }));
ink.waitUntilExit().then(() => { leaveAlt(); process.exit(0); });

store.chat(`\x1b[90magent-kernel booted · ${mem.size} durable cell(s) · type below · /mem /c /wipe /quit\x1b[0m`);
store.state(stateLine({ mem, msgs: 0, cTok: 0, foldBudget: config.foldBudget, inputTok: 0, step: 0, breakdown: mainBreakdown }));
main.powerOn();

(async () => {
    let burst = 0;
    // The run loop drives frame 0; subroutine frames run to completion inside an invoke.
    for (;;) {
        const info = await main.step();
        if (info.yieldKind === 'wait') { burst = 0; continue; }
        if (info.yieldKind === 'endturn') { store.status('your turn'); await term.waitForInput(); burst = 0; continue; }
        if (++burst >= config.maxBurst) { store.status('burst guard'); await term.waitForInput(); burst = 0; }
    }
})().catch(err => {
    store.trace(`\n\x1b[31mMACHINE FAULT: ${err?.message || String(err)}\x1b[0m`);
});
