# agent-kernel — a minimal kernel for agents you build from within

A tiny kernel where the **processor is a language model**: ten primitives, a split-screen TUI to
**see the states**, and one idea — you **extend the machine from within**, in its own medium,
instead of assembling an agent from modules outside. The LLM is the *processor*, the context
window is *C* (working memory), everything else is deterministic harness. A paradigm to look at,
not a product: build-from-within vs the framework-assembly everyone already knows.

## The model

```
the machine  = { C, M }                  # its own state — this is what you'd serialize/snapshot
  C          = held, append-only context # working memory; one per running frame
  M          = durable name→value store  # survives power-off (mirrored to m.json); searched, not held
the world    = E                         # OUTSIDE the machine, not part of its state — reached only
                                         # via perceive/act. here E has one channel: the terminal

llm          = one LLM call = one step   # C → (text, operations); the ONLY stochastic part
step         = SEE → PARSE → RUN → APPEND → GATE

primitives (10, four concepts):
  memory       remember · recall · search · forget
  environment  perceive · act
  gate         wait
  abstraction  invoke · return      # the call stack — routines as subroutines
  computation  exec                 # the deterministic coprocessor
```

| primitive | does |
|---|---|
| `remember(addr,value)` | C→M : write durable memory |
| `recall(addr)` | M→C : read by exact key |
| `search(query)` | M→C : find data/routines relevant to a query |
| `forget(addr)` | remove an entry from M — the only deleting op (how you change your mind) |
| `perceive(channel)` | E→C : read input that arrived on a channel |
| `act(channel,value)` | C→E : emit (e.g. speak to the operator) |
| `wait()` | halt until the operator sends input |
| `invoke(name,args)` | run a routine from M as a subroutine; returns a value |
| `return(value)` | finish a subroutine, hand a value to its caller |
| `exec(code,args)` | run deterministic JS on the coprocessor — exact, no LLM |

## Key ideas

- **Non-determinism is quarantined** to the single `llm()` call. Hold / parse / run / append /
  the whole datapath are exact, deterministic harness.
- **No program counter, no arithmetic opcodes.** What the LLM recalls/perceives next is simply
  where it goes; all "compute" is semantic (inside the step) or offloaded to `exec`.
- **Frames = the call stack.** `invoke` runs a routine in its **own fresh C** (so a subroutine
  never clutters the caller) while **sharing M and the ports**; `return` hands a value back. The
  JS call stack mirrors the frame stack. Composition (a routine invoking routines) holds several
  levels deep.
- **Build from within.** A routine is just an entry in M — remember a prompt under a name (that
  *is* the routine), then `invoke` it. A prompt-routine runs as a sub-agent (flexible); an entry
  stored as `exec:(args) => ...` runs as **code** instantly on the coprocessor (exact, free).
  `invoke` is polymorphic — callers don't change when a routine is hardened from prompt to code.
  Soft routines are portable: they live in `m.json`, so copying it carries your capabilities.
- **Selective projection.** The frame shows only the *size* of M, never its keys — the directory
  is **queried with `search`**, not held resident. This scales to any library size (O(1) per
  step), keeps the context clean, and makes invoking a routine deliberate instead of reflexive.
  (The search backend is lexical today; it swaps to embeddings/hybrid behind `Memory.search`.)

## Interface

A split-screen TUI built on **Ink** (React for terminals) — Yoga flexbox + width-aware borders,
so the frame never drifts when emoji/wide text appears. Needs a real terminal (TTY).

```
╭ conversation · agents ──────╮╭ machine · model ─────────────╮
│ you ▸ make a card for Anna  ││ ▸ 13  greet·d2  ● run  2.5s   │  ← action stream
│ ◆ machine ▸ ...             ││ │ invoke upper → "HELLO.."    │
│   ▶ invoke greet(Anna)      ││ ▸ 14  main  ● run  2.4s ↑3k   │
│     ◀ greet → "HELLO ANNA"  │╰──────────────────────────────╯
│   ↳ card ▸ HELLO ANNA --- …  │╭ state ───────────────────────╮
│                             ││ M·6  upper greet signoff …    │  ← live, in place
╰─────────────────────────────╯│ C·main 23 msgs ~1.2k  steps19 │
                                ╰──────────────────────────────╯
╭ ❯ ────────────────────────────────────────────────────────────╮
│ ❯ ▮                            your turn · tab:focus ↑↓ C-c     │
╰────────────────────────────────────────────────────────────────╯
```

- **Left** — conversation + the agent call tree (sub-routines nested by depth).
- **Right, top** — the action stream: each step's operations, color-coded, nested by frame.
- **Right, bottom — state** — live: current M keys + main context size + step count (in place).
- **Input** — operator input + status.

Keys: type to talk · `Tab` cycles focus (input → left → right) · with a pane focused, `↑↓` /
`PgUp PgDn` scroll and `G` jumps to latest · `Ctrl-C` quits.

## Run

```bash
git clone https://github.com/turing-machines/agent-kernel
cd agent-kernel
npm install
# ANTHROPIC_API_KEY is read from your shell, or copy .env.example → .env
cp seed.json m.json   # optional: load the bundled demo routines
npm start             # run in a real terminal (the TUI needs a TTY)
```

## Commands (type in the input box)

```
/mem        dump memory M (all cells, full values) to the stream
/c [n]      dump last n messages of the main context
/wipe       clear durable memory M — fresh machine
/quit       power off
```

Anything else is operator input fed to the machine on the terminal channel.

## Things to try

- Tell it your name, then restart (`/quit`, `npm start`) — it `search`es M and greets you with
  continuity. Durable identity lives in `m.json`.
- "make me a card for Anna" — watch it `search` M, find the `card` routine, and `invoke` it;
  `card` invokes `greet` and `signoff`, which invoke the code routine `upper`. A 3-deep call tree.
- Remember a new routine ("remember a routine `shout` that uppercases its input via exec"), then
  invoke it — extend the machine without leaving it.
- Just chat — it should *not* run routines reflexively; invocation is deliberate (search → invoke).

## Config (.env)

| var | default | meaning |
|---|---|---|
| `MODEL` | `claude-sonnet-4-6` | the processor (the LLM) |
| `MAX_TOKENS` | `1024` | per-step output (context write) budget |
| `MAX_BURST` | `16` | max main-frame steps without yielding to the operator (cost guard) |
| `MAX_STEPS` | `12` | per-subroutine step budget (runaway guard) |
| `MAX_DEPTH` | `5` | invoke recursion-depth guard |
| `MEM_FILE` | `m.json` | durable disk image for M |

## Files

```
llm.ts        the processor (one LLM call = one step) — the only stochastic seam
frame.ts      a running context; the step loop, op dispatch, invoke/return frames; World
memory.ts     M — durable key→value store + search/forget (mirrored to m.json)
terminal.ts   E — the terminal channel's input side
exec.ts       the deterministic coprocessor (sandboxed JS) + code-routine marker
tools.ts      the 10 primitives, as native tool definitions
system.ts     the resident system text (the agent + how to use the machine)
render.ts     pure formatters → ANSI strings (no I/O, no UI deps)
ui-store.ts   bridge: machine logic pushes lines here; the React app subscribes
app.tsx       the Ink (React) split-screen UI — the only module that knows Ink
index.ts      wiring: world + frame 0 + the run loop + render(<App/>)
```
