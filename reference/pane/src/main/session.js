'use strict';
// Last-session snapshot (session.json): open tab URLs + active index + window bounds.
const { readJSON, writeJSON } = require('./store');

const FILE = 'session.json';
let timer = null;

module.exports = {
  save: (data) => { clearTimeout(timer); timer = setTimeout(() => writeJSON(FILE, data), 500); },
  saveNow: (data) => { clearTimeout(timer); writeJSON(FILE, data); },
  load: () => readJSON(FILE, null),
  clear: () => { clearTimeout(timer); writeJSON(FILE, null); },
};
