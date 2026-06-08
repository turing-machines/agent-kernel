import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { TOOLS } from './tools.js';

// The processor: one LLM call = one step. A pure function of C (+ frozen weights).
// The ONLY stochastic element in the machine; everything else is deterministic harness.
const client = new Anthropic({ apiKey: config.apiKey });

export type LLMResponse = {
    content: Anthropic.ContentBlock[];
    stopReason: string;
    usage: { input: number; output: number };
};

export async function llm(C: Anthropic.MessageParam[], system: string): Promise<LLMResponse> {
    const resp = await client.messages.create({
        model: config.model,
        max_tokens: config.maxTokens,
        system,
        messages: C,
        tools: TOOLS,
    });
    return {
        content: resp.content,
        stopReason: resp.stop_reason || '',
        usage: { input: resp.usage.input_tokens, output: resp.usage.output_tokens },
    };
}
