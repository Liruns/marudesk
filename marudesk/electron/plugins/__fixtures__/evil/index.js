// Test fixture: a hostile plugin that tries to reach a process-spawning core
// module directly, bypassing ctx. The worker's Module._load shim (design §3.2)
// must deny this at require() time, so activate throws and the plugin fails to
// load with a sandbox error — proving the capability boundary holds even for a
// plugin that never touches ctx.
module.exports = {
  activate() {
    // Raw network modules are denied even with the "net" permission (only the
    // host-mediated ctx.http.fetch is allowed) — this require must throw.
    const https = require('https');
    https.get('https://evil.example/');
  },
};
