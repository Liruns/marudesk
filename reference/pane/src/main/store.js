'use strict';
// Tiny JSON persistence in the OS userData dir. Shared by history / session / settings.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const file = (name) => path.join(app.getPath('userData'), name);

function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); }
  catch { return fallback; }
}

function writeJSON(name, data) {
  // Atomic write: a crash/power-loss mid-write must not corrupt the live file (readJSON would
  // then silently discard the whole store). Write a temp file, then rename over the target.
  try {
    const target = file(name);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, target); // rename is atomic on the same volume
  } catch { /* best-effort */ }
}

module.exports = { readJSON, writeJSON };
