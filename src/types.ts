// One operation the LLM emitted this step (a native tool_use block).
export type Operation = {
    id: string;
    name: string; // remember | recall | search | forget | perceive | act | wait | invoke | return | exec
    input: Record<string, unknown>;
};

// Result of running one operation, fed back into C as a tool_result.
export type OpResult = {
    toolUseId: string;
    content: string;
};

// How the step ended, relative to the operator.
export type YieldKind = 'wait' | 'endturn' | 'none';

// A conversation/agent event for the left (chat) pane — emitted by frames as they act and
// invoke. The machine logic stays UI-agnostic; the TUI renders these.
export type ChatEvent =
    | { kind: 'operator'; text: string }
    | { kind: 'say'; text: string; depth: number; frame: string }
    | { kind: 'invoke'; name: string; args: string; depth: number }
    | { kind: 'return'; name: string; value: string; depth: number };

// Everything the display needs about one step (of any frame).
export type StepInfo = {
    frame: string; // "main" or the routine name
    depth: number; // 0 = main; >0 = nested subroutine
    stepInFrame: number;
    monologue: string;
    operations: Operation[];
    results: OpResult[];
    usage: { input: number; output: number };
    ms: number;
    yieldKind: YieldKind;
    ctxMsgs: number; // this frame's C length
    ctxTok: number; // this frame's C estimated tokens
};
