import type Anthropic from '@anthropic-ai/sdk';
import { llm } from './llm.js';
import { Memory } from './memory.js';
import { Terminal } from './terminal.js';
import { runCode, isCode, codeBody } from './exec.js';
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
};

// A Frame is one running context. Frame 0 is the resident main agent (operator-driven);
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
            content: '[POWER ON] Terminal connected. Operator present. You are the processor — run.',
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

        const resp = await llm(this.C, system); // SEE
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
            ctxTok: Math.round(JSON.stringify(this.C).length / 4),
        };
        this.world.onStep(info);
        return info;
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
                return ok(drained ? `OPERATOR:\n${drained}` : '(no input)');
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
