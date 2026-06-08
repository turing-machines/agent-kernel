import type Anthropic from '@anthropic-ai/sdk';

// The built-in base operations — the agent's five primitive verbs, exposed to the LLM as native
// tools. These (plus the implicit THINK = the step itself) are the whole machine.
// Their *definitions* live in C (carried each step); their *execution* is deterministic harness
// code (machine.ts). The agent loop: perceive → (think) → act, over durable remember/recall.
export const TOOLS: Anthropic.Tool[] = [
    {
        name: 'remember',
        description: 'REMEMBER (C->M): write a value to durable memory M under a name. Survives power-off; the only memory that outlives the volatile context C.',
        input_schema: {
            type: 'object',
            properties: {
                addr: { type: 'string', description: 'memory key / name' },
                value: { type: 'string', description: 'value to remember' },
            },
            required: ['addr', 'value'],
        },
    },
    {
        name: 'recall',
        description: 'RECALL (M->C): read a value back from durable memory M by name into the context. Returns the stored value, or "(empty)" if unset.',
        input_schema: {
            type: 'object',
            properties: { addr: { type: 'string', description: 'memory key / name' } },
            required: ['addr'],
        },
    },
    {
        name: 'search',
        description: 'SEARCH memory M: find data or routines relevant to a query. Your durable memory is large and is NOT shown to you wholesale (only its size) — so search it when a task might be served by something you remember (a fact about the user, a routine to invoke). Returns matching keys with a short preview. Then recall or invoke the ones you want by name.',
        input_schema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'what to look for (words, a topic, a capability)' } },
            required: ['query'],
        },
    },
    {
        name: 'forget',
        description: 'FORGET: remove an entry from durable memory M — the only operation that deletes. Use it to drop outdated, wrong, or superseded facts and routines: in an append-only memory, forgetting is the only real way to change your mind. Irreversible — forget deliberately, when something is genuinely no longer true or wanted, not casually.',
        input_schema: {
            type: 'object',
            properties: { addr: { type: 'string', description: 'memory key to forget' } },
            required: ['addr'],
        },
    },
    {
        name: 'perceive',
        description: 'PERCEIVE (E->C): observe the environment — read buffered input from a channel into the context. Returns the input, or "(no input)".',
        input_schema: {
            type: 'object',
            properties: { channel: { type: 'string', description: 'channel name, e.g. "terminal"' } },
            required: ['channel'],
        },
    },
    {
        name: 'act',
        description: 'ACT (C->E): act on the environment — write text to a channel. Use channel "terminal" to speak to the user.',
        input_schema: {
            type: 'object',
            properties: {
                channel: { type: 'string', description: 'channel name, e.g. "terminal"' },
                value: { type: 'string', description: 'text to emit' },
            },
            required: ['channel', 'value'],
        },
    },
    {
        name: 'wait',
        description: 'WAIT: halt until the user provides input. Does not return it — read what they typed with perceive("terminal").',
        input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'invoke',
        description: 'INVOKE (call): run a routine stored in memory M as a subroutine in its own fresh working memory. The subroutine shares M and the ports, does its work, and returns a value back to you. Use this to call routines you (or the user) have remembered. Routines may invoke other routines.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'memory key where the routine (a prompt) is stored' },
                args: { type: 'string', description: 'inputs to pass to the routine (optional)' },
            },
            required: ['name'],
        },
    },
    {
        name: 'return',
        description: 'RETURN: finish the current subroutine and hand a value back to whoever invoked it. Only meaningful inside a subroutine frame.',
        input_schema: {
            type: 'object',
            properties: { value: { type: 'string', description: 'the result to return to the caller' } },
            required: ['value'],
        },
    },
    {
        name: 'exec',
        description: 'EXEC: run deterministic code on the coprocessor — pass a JS function "(args) => result" and an input string; returns the result exactly, with NO LLM and NO sub-agent. Use for exact work (math, string ops, parsing). To make a reusable code routine, remember its value as "exec:(args) => ..." and invoke it by name like any routine — it runs instantly as code instead of a sub-agent.',
        input_schema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'a JS function expression: (args) => result' },
                args: { type: 'string', description: 'input string passed to the function (optional)' },
            },
            required: ['code'],
        },
    },
];
