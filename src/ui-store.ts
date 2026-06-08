// Bridge between the (UI-agnostic) machine logic and the Ink React app. The loop/world push
// pre-formatted ANSI lines here; the React app subscribes and re-reads. Operator input flows
// back via submit(). No blessed/Ink types leak into the logic.
export class UiStore {
    readonly model: string;
    chatLines: string[] = [];
    traceLines: string[] = [];
    stateText = '';
    statusText = '';

    private listeners = new Set<() => void>();
    private submitHandler: (line: string) => void = () => {};

    constructor(model: string) {
        this.model = model;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private emit() {
        for (const l of this.listeners) l();
    }

    chat(line: string) { this.chatLines.push(line); this.emit(); }
    trace(line: string) { this.traceLines.push(line); this.emit(); }
    state(text: string) { this.stateText = text; this.emit(); }
    status(text: string) { this.statusText = text; this.emit(); }

    onSubmit(handler: (line: string) => void) { this.submitHandler = handler; }
    submit(line: string) { this.submitHandler(line); }
}
