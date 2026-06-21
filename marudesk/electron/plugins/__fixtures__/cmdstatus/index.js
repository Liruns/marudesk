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
    // Emits N ctx.log lines in one call so the host's bounded log ring can be
    // exercised (the in-app plugin debug view). Each line is uniquely numbered so
    // the harness can assert the oldest were dropped once the cap is exceeded.
    ctx.registerTool({
      name: 'log_many',
      description: 'Emit N numbered ctx.log lines.',
      inputSchema: { type: 'object', properties: { count: { type: 'number' } } },
      async handler(input) {
        const count = typeof input.count === 'number' ? input.count : 1;
        for (let i = 0; i < count; i += 1) ctx.log(`line-${i}`);
        return { text: JSON.stringify({ emitted: count }) };
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
