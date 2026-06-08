import 'dotenv/config';

// Machine configuration, read once at boot.
export const config = {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.MODEL || 'claude-sonnet-4-6',
    maxTokens: parseInt(process.env.MAX_TOKENS || '1024', 10),
    maxBurst: parseInt(process.env.MAX_BURST || '16', 10),
    maxSteps: parseInt(process.env.MAX_STEPS || '12', 10), // per-frame step budget (subroutine guard)
    maxDepth: parseInt(process.env.MAX_DEPTH || '5', 10), // invoke recursion guard
    memFile: process.env.MEM_FILE || 'm.json', // durable disk image for M
};
