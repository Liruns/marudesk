// Test fixture: exercises the host-mediated ctx.exec + ctx.setStatus surface and
// the onSessionStart / onSessionEnd lifecycle callbacks. The plugin never touches
// child_process itself (the sandbox denies it) — exec routes through the host with
// the `cmd` permission. State accumulated per-conversation is reset in onSessionEnd
// to prove a stateful plugin can avoid leaking across conversations.
let sessionLog = [];

module.exports = {
  activate(ctx) {
    ctx.registerTool({
      name: 'run_and_count',
      description: 'Runs a CLI via ctx.exec, pushes a status, and reports the lifecycle log length.',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      async handler(input) {
        ctx.setStatus('progress', 'running the command…');
        const res = await ctx.exec(typeof input.command === 'string' ? input.command : 'node -e "process.stdout.write(\'hi\')"');
        ctx.setStatus('progress', ''); // clear
        return {
          text: JSON.stringify({
            exitCode: res.exitCode,
            output: res.output,
            sessions: sessionLog.length,
          }),
        };
      },
    });
  },
  onSessionStart(info) {
    sessionLog.push(info.sessionId);
  },
  onSessionEnd() {
    // A stateful plugin resets per-conversation state here instead of leaking it.
    sessionLog = [];
  },
};
