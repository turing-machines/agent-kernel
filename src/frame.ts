import type Anthropic from '@anthropic-ai/sdk';
import { llm } from './llm.js';
import { Memory } from './memory.js';
import { Terminal } from './terminal.js';
import { runCode, isCode, codeBody } from './exec.js';
import { TOOLS } from './tools.js';
import { flattenContext, FOLD_SYSTEM } from './fold.js';
import type { Operation, OpResult, StepInfo, YieldKind, ChatEvent } from './types.js';

// Shared environment for all frames: the resident system text, the shared durable memory M,
// the shared terminal E, two observers (machine trace + chat events) and the guards.
export type World = {
    system: string;
    mem: Memory;
    term: Terminal;
    onStep: (info: StepInfo) => void; // right pane: machine trace
    onEvent: (ev: ChatEvent) => void; // left pane: conversation / agent activity
    maxSteps: number; // per-frame step budget (subroutine runaway guard)
    maxDepth: number; // invoke recursion guard
    foldBudget: number; // real input tokens of C before older context is folded out
    foldKeepTail: number; // recent messages kept verbatim on fold
    recapEpisodes: number; // how many recent episode notes to surface as "session so far"
    episodeN: number; // running counter for episode/* keys (mutable, shared)
};

// A Frame is one running context. Frame 0 is the resident main agent (user-driven);
// invoke() pushes a child frame seeded with a routine from M, runs it to return(), and the
// returned value lands in the parent's context. Frames SHARE M and the terminal; each gets a
// FRESH C (working memory). The JS call stack mirrors the frame stack.
export class Frame {
    C: Anthropic.MessageParam[] = []; // this frame's own working memory (fresh per call)
    private done = false;
    private returnValue = '';
    private stepInFrame = 0;

    constructor(private world: World, readonly depth: number, readonly name: string) {}

    // seed frame 0 (the resident agent)
    powerOn() {
        this.C.push({
            role: 'user',
            content: '[POWER ON] Terminal connected. User present. You are the processor — run.',
        });
    }

    // seed a subroutine frame with the routine (recalled from M) and its args
    private seed(routine: string, args: string) {
        this.C.push({
            role: 'user',
            content:
                `[SUBROUTINE] You are running the routine "${this.name}" in your own fresh working memory. ` +
                `You have the full toolset and share durable memory M and the ports.\n\n` +
                `ROUTINE:\n${routine}\n\n` +
                `INPUT: ${args || '(none)'}\n\n` +
                `Do the routine's work, then call return(value) with the result. Keep it tight.`,
        });
    }

    // run a subroutine frame to completion (until return, or the step budget); returns its value
    async run(): Promise<string> {
        while (!this.done && this.stepInFrame < this.world.maxSteps) await this.step();
        return this.done
            ? this.returnValue
            : `(routine "${this.name}" did not return within ${this.world.maxSteps} steps)`;
    }

    // one step: SEE -> PARSE -> RUN -> APPEND -> emit. Returns step info (used by the top driver).
    async step(): Promise<StepInfo> {
        this.stepInFrame++;
        const t0 = Date.now();

        // Paging: when C grows past the budget, fold its oldest part into the running summary and
        // archive the detail as an episode in M. Automatic (the agent doesn't manage it) — like an
        // OS paging memory. Keeps C small and coherent on long sessions without losing anything.
        const fold = await this.maybeFold();

        // Selective projection: the frame shows only the SIZE of M, never its keys — the directory
        // is queried with search(), not held resident. This scales to any library size (O(1) here),
        // keeps the context clean, and makes invoking a routine deliberate (search → find → invoke)
        // instead of reflexive. Also surface whether the terminal has input pending.
        const memHint = this.world.mem.size
            ? `${this.world.mem.size} entries (data and routines) — not shown here; use search("...") to find relevant ones, then recall/invoke by name`
            : 'empty';
        const pending = this.world.term.hasInput() ? 'YES — read it with perceive("terminal")' : 'none';
        const system =
            `${this.world.system}\n\n` +
            `DURABLE MEMORY M: ${memHint}\n` +
            `TERMINAL pending input: ${pending}`;

        // Consolidation tier: the recent episode notes (compressed, persisted in M) ride in the
        // MESSAGE stream as a leading turn — not baked into the system prompt. They are recalled
        // history, not instructions, and keeping them out of system leaves tools+system a stable
        // (cacheable) prefix that a fold doesn't churn. Older episodes stay searchable in M.
        const recap = this.recentEpisodes();
        const resp = await llm(this.messagesForStep(recap), system); // SEE
        const llmMs = Date.now() - t0;

        // PARSE
        const monologue = resp.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map(b => b.text)
            .join('\n')
            .trim();
        const operations: Operation[] = resp.content
            .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
            .map(b => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));

        // APPEND the LLM turn verbatim
        this.C.push({ role: 'assistant', content: resp.content });

        // RUN each operation
        const results: OpResult[] = [];
        let waited = false;
        for (const op of operations) {
            results.push(await this.exec(op));
            if (op.name === 'wait') waited = true;
        }
        if (results.length) {
            this.C.push({
                role: 'user',
                content: results.map(r => ({ type: 'tool_result' as const, tool_use_id: r.toolUseId, content: r.content })),
            });
        }

        const yieldKind: YieldKind = waited ? 'wait' : operations.length === 0 ? 'endturn' : 'none';
        const info: StepInfo = {
            frame: this.name,
            depth: this.depth,
            stepInFrame: this.stepInFrame,
            monologue,
            operations,
            results,
            usage: resp.usage,
            ms: llmMs,
            yieldKind,
            ctxMsgs: this.C.length,
            ctxTok: this.cTokens(), // size of C ALONE (the uncompressed working set) — the fold metric
            fold: fold ?? undefined,
            // ~token split of what's actually sent: the tool catalog, the resident instructions,
            // the consolidation recap, and the live working context. Only `work` is foldable.
            breakdown: {
                tools: Math.round(JSON.stringify(TOOLS).length / 4),
                system: Math.round(system.length / 4),
                recap: Math.round(recap.length / 4),
                work: this.cTokens(),
            },
        };
        this.world.onStep(info);
        return info;
    }

    // Fold the oldest part of C into a COMPRESSED episode note in M, when C is over budget.
    // The note (not the raw transcript) is what's archived — so M never bloats and episodes can't
    // nest. One LLM call per fold; the episode counter advances only on success. C shrinks only
    // after the note is safely stored, so a transient summariser failure just retries next step.
    private async maybeFold(): Promise<{ key: string; msgs: number } | null> {
        // Trigger on the size of C ALONE — the uncompressed working set. NOT the whole prompt:
        // the system text and the recap (already-consolidated episode notes) don't shrink when we
        // fold C, so counting them would fire fold pointlessly — and immediately at boot, the
        // moment the recap loads. We measure only what folding actually reduces.
        if (this.cTokens() < this.world.foldBudget) return null;
        const keep = this.world.foldKeepTail;
        if (this.C.length <= keep + 1) return null;

        const head = this.C.slice(0, this.C.length - keep);
        try {
            const note = await this.summarize(flattenContext(head));
            if (!note) return null; // empty summary — don't burn an episode or drop context
            const key = `episode/${this.world.episodeN + 1}`;
            this.world.mem.set(key, note);
            this.world.episodeN += 1;
            this.C = this.C.slice(this.C.length - keep); // keep the recent tail verbatim
            return { key, msgs: head.length };
        } catch {
            return null; // transient summariser failure — C intact, retries next step
        }
    }

    // Compress a flattened slice of context into a compact, self-contained episode note.
    private async summarize(headText: string): Promise<string> {
        const resp = await llm(
            [{ role: 'user', content: `Consolidate this slice of the session into a compact note:\n\n${headText}` }],
            FOLD_SYSTEM,
            { tools: false }, // pure-text summary — no tool surface
        );
        return resp.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map(b => b.text)
            .join('\n')
            .trim();
    }

    // ~tokens of C alone (chars/4). The fold metric: the uncompressed working set, NOT the prompt.
    private cTokens(): number {
        return Math.round(JSON.stringify(this.C).length / 4);
    }

    // The most recent episode notes, in order — the persisted "session so far" preamble. Each note
    // is capped so one oversized note (e.g. a raw episode from an older build) can't bloat the recap.
    private recentEpisodes(): string {
        const cap = (s: string) => (s.length > 600 ? s.slice(0, 599) + '…' : s);
        const eps = this.world.mem
            .keys()
            .map(k => /^episode\/(\d+)$/.exec(k))
            .filter((m): m is RegExpExecArray => m !== null)
            .map(m => ({ key: m[0], n: parseInt(m[1], 10) }))
            .sort((a, b) => a.n - b.n)
            .slice(-this.world.recapEpisodes);
        return eps.map(e => `${e.key}: ${cap(this.world.mem.get(e.key) ?? '')}`).join('\n');
    }

    // Assemble the messages for one step (a transient view of C — never mutates C).
    private messagesForStep(recap: string): Anthropic.MessageParam[] {
        let msgs: Anthropic.MessageParam[] = this.C;

        // Front: the recap rides as a leading USER turn — it's recalled history, not system
        // instructions. Merged into C's first turn when that's already user, else prepended.
        if (recap) {
            const note = `[Recalled from earlier — consolidated notes of older context; full detail is searchable in M]\n${recap}`;
            const first = msgs[0];
            msgs =
                first && first.role === 'user'
                    ? [
                          {
                              role: 'user',
                              content:
                                  typeof first.content === 'string'
                                      ? `${note}\n\n${first.content}`
                                      : [{ type: 'text', text: note }, ...first.content],
                          },
                          ...msgs.slice(1),
                      ]
                    : [{ role: 'user', content: note }, ...msgs];
        }

        // Back: the model can't continue from a trailing assistant turn. If the last reply was
        // plain text (no tool call → no tool_result), add a minimal user nudge so the call is valid.
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant') msgs = [...msgs, { role: 'user', content: '(continue)' }];

        return msgs;
    }

    private async exec(op: Operation): Promise<OpResult> {
        const a = op.input as { addr?: string; value?: string; channel?: string; name?: string; args?: string; code?: string; query?: string };
        const ok = (content: string): OpResult => ({ toolUseId: op.id, content });
        const previewVal = (v: string) => (v.length > 80 ? v.slice(0, 79) + '…' : v);
        switch (op.name) {
            case 'remember':
                this.world.mem.set(String(a.addr), String(a.value ?? ''));
                return ok(`OK remembered "${a.addr}"`);
            case 'recall':
                return ok(this.world.mem.get(String(a.addr)) ?? '(empty)');
            case 'search': {
                const hits = this.world.mem.search(String(a.query ?? ''));
                return ok(hits.length ? hits.map(h => `- ${h.key}: ${previewVal(h.value)}`).join('\n') : '(no matches in memory)');
            }
            case 'forget':
                return ok(this.world.mem.delete(String(a.addr)) ? `OK forgot "${a.addr}"` : `(no such key "${a.addr}")`);
            case 'act':
                this.world.onEvent({ kind: 'say', text: String(a.value ?? ''), depth: this.depth, frame: this.name });
                return ok('OK');
            case 'perceive': {
                const drained = this.world.term.drain();
                return ok(drained ? `USER:\n${drained}` : '(no input)');
            }
            case 'wait':
                await this.world.term.waitForInput();
                return ok('(input ready — read it with perceive)');
            case 'invoke': {
                const name = String(a.name);
                const args = String(a.args ?? '');
                const routine = this.world.mem.get(name);
                if (routine === undefined) return ok(`ERR no routine at "${name}"`);
                this.world.onEvent({ kind: 'invoke', name, args, depth: this.depth });
                // Hard routine (code): dispatch to the coprocessor — instant, no frame, no LLM.
                if (isCode(routine)) {
                    const value = runCode(codeBody(routine), args);
                    this.world.onEvent({ kind: 'return', name, value, depth: this.depth });
                    return ok(value);
                }
                // Soft routine (prompt): push a sub-frame that runs it.
                if (this.depth >= this.world.maxDepth) return ok(`ERR max invoke depth ${this.world.maxDepth} reached`);
                const child = new Frame(this.world, this.depth + 1, name);
                child.seed(routine, args);
                const value = await child.run(); // push frame, run to return, value flows back into C
                this.world.onEvent({ kind: 'return', name, value, depth: this.depth });
                return ok(value);
            }
            case 'return':
                if (this.depth === 0) return ok('(return ignored at top level — main is resident)');
                this.done = true;
                this.returnValue = String(a.value ?? '');
                return ok('OK returned');
            case 'exec':
                return ok(runCode(String(a.code ?? ''), String(a.args ?? '')));
            default:
                return ok(`ERR unknown operation "${op.name}"`);
        }
    }
}
