// E — the terminal channel's INPUT side: a buffer the user pushes into and the machine
// drains via perceive; wait blocks on waitForInput until a line arrives. Output (the machine
// acting on the terminal) is emitted as a 'say' ChatEvent and rendered by the UI — so this
// stays a pure, UI-agnostic input device.
export class Terminal {
    private buffer: string[] = [];
    private waiter: (() => void) | null = null;

    // user text enters here — the one and only input path
    push(line: string) {
        this.buffer.push(line);
        const w = this.waiter;
        this.waiter = null;
        if (w) w();
    }

    hasInput(): boolean {
        return this.buffer.length > 0;
    }

    // E->C : drain buffered input into the context
    drain(): string {
        if (!this.buffer.length) return '';
        const lines = this.buffer.join('\n');
        this.buffer = [];
        return lines;
    }

    // gate: halt until input is available (used by wait and by the run loop)
    waitForInput(): Promise<void> {
        if (this.buffer.length) return Promise.resolve();
        return new Promise(res => { this.waiter = res; });
    }
}
