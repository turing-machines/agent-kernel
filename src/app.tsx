import React, { useEffect, useReducer, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { UiStore } from './ui-store.js';

// Track terminal size. Ink lays out with Yoga; we only need row/col counts to size the panes.
function useDimensions() {
    const { stdout } = useStdout();
    const [d, setD] = useState({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
    useEffect(() => {
        const onResize = () => setD({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
        stdout.on('resize', onResize);
        return () => { stdout.off('resize', onResize); };
    }, [stdout]);
    return d;
}

// Re-render whenever the store emits.
function useStore(store: UiStore) {
    const [, force] = useReducer((x: number) => x + 1, 0);
    useEffect(() => store.subscribe(force), [store]);
}

type Focus = 'input' | 'left' | 'right';

// A bordered, wrapping, auto-following pane of FIXED height. The inner content box is also a
// fixed height with overflow hidden, so it never grows with text (no overflow); the latest lines
// are bottom-pinned and older ones clip. `offset` scrolls back. Yoga + string-width fix the
// border to the real size, so it never drifts.
function Pane(props: {
    title: string;
    color: string;
    width: number;
    boxH: number;
    lines: string[];
    focused: boolean;
    offset: number;
}) {
    const { title, color, width, boxH, lines, focused, offset } = props;
    const contentH = Math.max(1, boxH - 3); // minus border (2) + title (1)
    const total = lines.length;
    const off = Math.min(offset, Math.max(0, total - 1));
    const end = total - off;
    const start = Math.max(0, end - contentH - 6);
    const visible = lines.slice(start, end);
    return (
        <Box flexDirection="column" width={width} height={boxH} borderStyle="round" borderColor={focused ? color : 'gray'} paddingX={1}>
            <Box width="100%">
                <Text bold color={color}>
                    {title}
                    {off > 0 ? <Text dimColor>{`  ▲ ${off}`}</Text> : focused ? <Text dimColor>{'  ●'}</Text> : ''}
                </Text>
            </Box>
            <Box flexDirection="column" width="100%" height={contentH} overflow="hidden" justifyContent="flex-end">
                {visible.map((l, i) => (
                    <Text key={start + i}>{l}</Text>
                ))}
            </Box>
        </Box>
    );
}

export function App({ store }: { store: UiStore }) {
    useStore(store);
    const { exit } = useApp();
    const { cols, rows } = useDimensions();
    const [input, setInput] = useState('');
    const [focus, setFocus] = useState<Focus>('input');
    const [leftOff, setLeftOff] = useState(0);
    const [rightOff, setRightOff] = useState(0);

    const inputH = 3;
    const stateH = 5;
    const leftW = Math.floor(cols / 2);
    const rightW = cols - leftW;
    // Reserve one line so a full-height frame never scrolls the terminal (off-by-one guard).
    const panesH = Math.max(6, rows - inputH - 1);
    const traceH = Math.max(3, panesH - stateH);

    useInput((ch, key) => {
        if (key.ctrl && ch === 'c') return exit();
        if (key.tab) { setFocus(f => (f === 'input' ? 'left' : f === 'left' ? 'right' : 'input')); return; }

        if (focus === 'left' || focus === 'right') {
            const setOff = focus === 'left' ? setLeftOff : setRightOff;
            if (key.upArrow) return setOff(o => o + 1);
            if (key.downArrow) return setOff(o => Math.max(0, o - 1));
            if (key.pageUp) return setOff(o => o + 10);
            if (key.pageDown) return setOff(o => Math.max(0, o - 10));
            if (ch === 'G') return setOff(0); // jump to latest
            return;
        }

        // focus === 'input'
        if (key.return) { const v = input; setInput(''); if (v.trim()) store.submit(v); return; }
        if (key.backspace || key.delete) { setInput(s => s.slice(0, -1)); return; }
        if (ch && !key.ctrl && !key.meta) setInput(s => s + ch);
    });

    return (
        <Box flexDirection="column" width={cols}>
            <Box flexDirection="row" height={panesH}>
                <Pane title="conversation · agents" color="cyan" width={leftW} boxH={panesH}
                    lines={store.chatLines} focused={focus === 'left'} offset={leftOff} />
                <Box flexDirection="column" width={rightW} height={panesH}>
                    <Pane title={`machine · ${store.model}`} color="blue" width={rightW} boxH={traceH}
                        lines={store.traceLines} focused={focus === 'right'} offset={rightOff} />
                    <Box flexDirection="column" width={rightW} height={stateH} borderStyle="round" borderColor="yellow" paddingX={1}>
                        <Text bold color="yellow">state</Text>
                        <Text>{store.stateText}</Text>
                    </Box>
                </Box>
            </Box>
            <Box width={cols} height={inputH} borderStyle="round" borderColor={focus === 'input' ? 'magenta' : 'gray'} paddingX={1}>
                <Text color="magenta" bold>{'❯ '}</Text>
                <Text>{input}</Text>
                {focus === 'input' ? <Text inverse>{' '}</Text> : null}
                <Box flexGrow={1} />
                <Text dimColor>{store.statusText} · tab:focus ↑↓:scroll C-c:quit</Text>
            </Box>
        </Box>
    );
}
