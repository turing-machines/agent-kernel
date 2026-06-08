import vm from 'node:vm';

// The deterministic coprocessor. Runs a JS routine `(args) => result` in an isolated context
// with a timeout and NO host access (no require/process/fs). The exact, cheap path: one call,
// no LLM, no sub-frame. This is the computation leg — the system is about semantics; exact
// math/string/data work offloads here instead of being faked by the model.
export function runCode(code: string, args: string): string {
    try {
        const script = `(${code})(${JSON.stringify(args)})`;
        const out = vm.runInNewContext(script, Object.create(null), { timeout: 1000 });
        return out === undefined || out === null ? '' : String(out);
    } catch (e: unknown) {
        return `ERR exec: ${e instanceof Error ? e.message : String(e)}`;
    }
}

// A routine stored in M is "hard" (code) when its value carries this marker; otherwise it is a
// "soft" prompt routine run by a sub-frame.
export const CODE_MARKER = 'exec:';
export const isCode = (routine: string) => routine.startsWith(CODE_MARKER);
export const codeBody = (routine: string) => routine.slice(CODE_MARKER.length);
