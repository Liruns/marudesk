// Example MaruDesk plugin (docs/plugin-runtime-design.md). CommonJS — loaded by the
// isolated worker via require(). The single export is `activate(ctx)`, called once
// during load; it registers tools and slash commands. Tool handlers run later, on
// demand, each inside the agent's approval flow.
//
// ctx surface (only what the granted permissions allow):
//   ctx.registerTool({ name, description, inputSchema, handler })   // "tools"
//   ctx.registerSlashCommand({ name, description, argHint, template }) // "commands"
//   ctx.fs.read(relPath) / ctx.fs.list(relPath)                     // "fs:read"
//   ctx.log(...args)

module.exports = {
  activate(ctx) {
    // A trivial tool: echoes a greeting. No permissions needed beyond "tools".
    ctx.registerTool({
      name: 'greet',
      description: 'Return a friendly greeting for the given name.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Who to greet' } },
        required: ['name'],
      },
      async handler(input) {
        const name = input && typeof input.name === 'string' ? input.name : 'world';
        return `Hello, ${name}! — from the hello-world plugin`;
      },
    });

    // A tool that reaches the workspace through the guarded fs bridge. The host
    // resolves the path under the active workspace root and refuses escapes; this
    // call only works while the handler is running (handler-scoped, design §R2).
    ctx.registerTool({
      name: 'read_file',
      description: 'Read a workspace-relative text file and return its contents.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative file path' } },
        required: ['path'],
      },
      async handler(input) {
        const rel = input && typeof input.path === 'string' ? input.path : '';
        const text = await ctx.fs.read(rel);
        return `--- ${rel} ---\n${text}`;
      },
    });

    // A prompt slash command. `$ARGUMENTS` is substituted by the renderer with
    // whatever the user typed after the command (design §5).
    ctx.registerSlashCommand({
      name: 'hello',
      description: 'Ask the agent to greet someone',
      argHint: 'name',
      template: 'Please greet $ARGUMENTS warmly and concisely.',
    });

    ctx.log('hello-world plugin activated');
  },
};
