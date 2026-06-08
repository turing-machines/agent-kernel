import type Anthropic from '@anthropic-ai/sdk';

// Flatten a slice of context (text / tool_use / tool_result blocks) into a plain transcript,
// so it can be summarised by a fold call and archived as an episode.
export function flattenContext(messages: Anthropic.MessageParam[]): string {
    return messages
        .map(m => {
            const who = m.role === 'assistant' ? 'AGENT' : 'INPUT';
            const body =
                typeof m.content === 'string'
                    ? m.content
                    : m.content
                          .map(b => {
                              if (b.type === 'text') return b.text;
                              if (b.type === 'tool_use') return `«${b.name} ${JSON.stringify(b.input)}»`;
                              if (b.type === 'tool_result') return `→ ${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}`;
                              return '';
                          })
                          .filter(Boolean)
                          .join(' ');
            return `${who}: ${body}`;
        })
        .join('\n');
}

// The fold model compresses an aged-out slice of context into one compact, self-contained note.
// The note REPLACES the raw slice in durable memory, so it must keep what's load-bearing while
// throwing away mechanical noise — and stay short, since several notes form the running recap.
export const FOLD_SYSTEM =
    `You write a compact note that consolidates a slice of an assistant's working session, so the ` +
    `session can continue without holding the raw history. Capture only what is load-bearing: who ` +
    `the user is, facts they shared, decisions and preferences, what was built or done, and where ` +
    `things stand now. Keep names and concrete values verbatim. Ignore mechanical plumbing ` +
    `(power-on lines, wait/perceive turns, tool acknowledgements). A few sentences, third person, ` +
    `self-contained. This note replaces the raw slice — don't drop anything that matters.`;
