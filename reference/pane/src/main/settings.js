'use strict';
// Persisted user settings (settings.json).
const { readJSON, writeJSON } = require('./store');

const FILE = 'settings.json';
const DEFAULTS = { restoreSession: true };
let settings = null;

function load() { if (!settings) settings = { ...DEFAULTS, ...readJSON(FILE, {}) }; return settings; }

module.exports = {
  getAll: () => ({ ...load() }),
  get: (key) => load()[key],
  set: (key, value) => { load()[key] = value; writeJSON(FILE, settings); },
};
