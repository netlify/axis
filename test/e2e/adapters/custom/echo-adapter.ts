import { createAgentAdapter } from "../../../../src/adapters/base/agent-adapter.js";

export default createAgentAdapter<{ stdout: string }>({
  name: "echo",
  resolveCommand: () => ({ command: "echo", prefixArgs: [] }),
  buildArgs: (input) => [input.prompt],
  initialState: () => ({ stdout: "" }),
  streamConfig: {
    mode: "aggregate",
    onChunk: (chunk, ctx) => {
      ctx.state.stdout += chunk;
    },
  },
  getResult: (ctx) => {
    const result = ctx.state.stdout.trim() || null;
    if (result) {
      ctx.transcript.push({
        type: "assistant",
        timestamp: ctx.endTime.toISOString(),
        content: { text: result },
      });
    }
    return { result };
  },
});
