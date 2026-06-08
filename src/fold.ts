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

// The fold model compresses aged-out context into a short running summary. It replaces raw
// history, so it must keep anything load-bearing — names, values, decisions, current intent.
export const FOLD_SYSTEM =
    `You compress an agent's working context into a short running summary so it can keep going ` +
    `without holding the full history. Be concise and factual: capture who the user is and what ` +
    `they want, key facts established, decisions made, routines used, and the current state / next ` +
    `intent. A few sentences. Keep names and concrete values verbatim. This summary replaces the raw ` +
    `history — do not drop anything load-bearing.`;
