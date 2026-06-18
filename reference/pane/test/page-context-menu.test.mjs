// The in-page right-click menu's template logic (src/main/page-context-menu.js). buildTemplate is
// pure — it returns an Electron menu template from the context-menu params — so the branch choice,
// separator hygiene, label text, and click wiring are all checkable here without an Electron runtime.
// (The module requires('electron') at load, which is a harmless path string under plain Node.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplate, menuLabel } from '../src/main/page-context-menu.js';

// A fake PageView: spies on the webContents/nav actions and records emitted events, so a click()
// handler can be invoked and asserted. Defaults model a plain, no-history page.
function fakePage(over = {}) {
  const calls = [];
  const emits = [];
  const rec = (name) => (...a) => calls.push([name, ...a]);
  const page = {
    webContents: {
      downloadURL: rec('downloadURL'), copyImageAt: rec('copyImageAt'),
      cut: rec('cut'), copy: rec('copy'), paste: rec('paste'), selectAll: rec('selectAll'),
      replaceMisspelling: rec('replaceMisspelling'),
      session: { addWordToSpellCheckerDictionary: rec('addWord') },
    },
    canGoBack: () => over.canGoBack === true,
    canGoForward: () => over.canGoForward === true,
    back: rec('back'), forward: rec('forward'), reload: rec('reload'),
    emit: (...a) => emits.push(a),
  };
  return { page, calls, emits };
}

// Default context-menu params: a plain page area (no link/media/selection, not editable).
const P = (over = {}) => ({
  x: 12, y: 34, mediaType: 'none', hasImageContents: false,
  linkURL: '', srcURL: '', selectionText: '', isEditable: false,
  misspelledWord: '', dictionarySuggestions: [], editFlags: {}, ...over,
});

const labels = (t) => t.map((i) => (i.type === 'separator' ? '---' : i.label));
const item = (t, label) => t.find((i) => i.label === label);

// ── Separator hygiene (holds for every scenario) ──────────────────────────────
function assertSepHygiene(t) {
  const L = labels(t);
  assert.notEqual(L[0], '---', 'no leading separator');
  assert.notEqual(L[L.length - 1], '---', 'no trailing separator');
  for (let i = 1; i < L.length; i++) {
    assert.ok(!(L[i] === '---' && L[i - 1] === '---'), 'no doubled separators');
  }
  assert.equal(L[L.length - 1], 'Inspect Element', 'Inspect Element is always last');
}

test('plain page → navigation verbs (gated) + Inspect', () => {
  const { page } = fakePage({ canGoBack: true, canGoForward: false });
  const t = buildTemplate(P(), page);
  assert.deepEqual(labels(t), ['Back', 'Forward', 'Reload', '---', 'Inspect Element']);
  assert.equal(item(t, 'Back').enabled, true);
  assert.equal(item(t, 'Forward').enabled, false); // no forward history
  assertSepHygiene(t);
});

test('link → open (background) + copy address, no page-nav verbs', () => {
  const { page, emits } = fakePage();
  const t = buildTemplate(P({ linkURL: 'https://ex.com/a' }), page);
  assert.deepEqual(labels(t), ['Open Link in New Tab', 'Copy Link Address', '---', 'Inspect Element']);
  assert.equal(item(t, 'Back'), undefined); // linkURL present → plain-page branch suppressed
  item(t, 'Open Link in New Tab').click();
  assert.deepEqual(emits[0], ['open-tab', 'https://ex.com/a', { background: true }]);
  assertSepHygiene(t);
});

test('link with an unsafe / privileged scheme → no "Open in New Tab", but Copy Address stays', () => {
  // The OPENABLE boundary: attacker-controlled hrefs may only open http(s)/blob in a fresh tab.
  // pane:// (privileged) + javascript: (injection) + chrome:// — and data: (a top-level spoof vector)
  // + file: (a local-filesystem bridge) — must NOT get the navigating affordance. Copy stays for all.
  for (const url of [
    'pane://settings/', 'javascript:alert(1)', 'about:blank', 'chrome://gpu',
    'data:text/html,<script>alert(1)</script>', 'file:///C:/Windows/System32/drivers/etc/hosts',
  ]) {
    const { page } = fakePage();
    const t = buildTemplate(P({ linkURL: url }), page);
    assert.equal(item(t, 'Open Link in New Tab'), undefined, `${url} must not be openable in-app`);
    assert.ok(item(t, 'Copy Link Address'), `${url} is still copyable`);
  }
});

test('link/image with a blob: URL → openable (a live opaque-origin object URL is web content)', () => {
  const blob = 'blob:https://ex.com/9f1c-uuid';
  const { page: lp, emits: le } = fakePage();
  const lt = buildTemplate(P({ linkURL: blob }), lp);
  assert.ok(item(lt, 'Open Link in New Tab'), 'blob: link is openable');
  item(lt, 'Open Link in New Tab').click();
  assert.deepEqual(le[0], ['open-tab', blob, { background: true }]);

  const { page: ip } = fakePage();
  const it = buildTemplate(P({ mediaType: 'image', hasImageContents: true, srcURL: blob }), ip);
  assert.ok(item(it, 'Open Image in New Tab'), 'blob: image is openable');
});

test('image with an unsafe / privileged src → no "Open in New Tab", but Save/Copy stay', () => {
  for (const src of ['pane://assets/x.png', 'data:image/png;base64,AAAA', 'file:///C:/secret.png']) {
    const { page } = fakePage();
    const t = buildTemplate(P({ mediaType: 'image', hasImageContents: true, srcURL: src }), page);
    assert.equal(item(t, 'Open Image in New Tab'), undefined, `${src} must not be openable in-app`);
    assert.ok(item(t, 'Save Image'), `${src} is still savable`);
    assert.ok(item(t, 'Copy Image Address'), `${src} address is still copyable`);
  }
});

test('image → open/save/copy/copy-address; Save Image uses the download pipeline', () => {
  const { page, calls, emits } = fakePage();
  const t = buildTemplate(P({ mediaType: 'image', hasImageContents: true, srcURL: 'https://ex.com/i.png' }), page);
  assert.deepEqual(labels(t), [
    'Open Image in New Tab', 'Save Image', 'Copy Image', 'Copy Image Address', '---', 'Inspect Element',
  ]);
  item(t, 'Save Image').click();
  assert.deepEqual(calls[0], ['downloadURL', 'https://ex.com/i.png']);
  item(t, 'Copy Image').click();
  assert.deepEqual(calls[1], ['copyImageAt', 12, 34]); // params.x/y
  item(t, 'Open Image in New Tab').click();
  assert.deepEqual(emits[0], ['open-tab', 'https://ex.com/i.png', { background: true }]);
  assertSepHygiene(t);
});

test('linked image → both link and image sections, single separators between', () => {
  const { page } = fakePage();
  const t = buildTemplate(P({ linkURL: 'https://ex.com/a', mediaType: 'image', hasImageContents: true, srcURL: 'https://ex.com/i.png' }), page);
  assert.deepEqual(labels(t), [
    'Open Link in New Tab', 'Copy Link Address', '---',
    'Open Image in New Tab', 'Save Image', 'Copy Image', 'Copy Image Address', '---',
    'Inspect Element',
  ]);
  assertSepHygiene(t);
});

test('editable field → edit verbs gated by editFlags', () => {
  const { page, calls } = fakePage();
  const t = buildTemplate(P({ isEditable: true, editFlags: { canCut: false, canCopy: true, canPaste: true, canSelectAll: true } }), page);
  assert.deepEqual(labels(t), ['Cut', 'Copy', 'Paste', 'Select All', '---', 'Inspect Element']);
  assert.equal(item(t, 'Cut').enabled, false);
  assert.equal(item(t, 'Paste').enabled, true);
  item(t, 'Copy').click();
  assert.deepEqual(calls[0], ['copy']);
  assertSepHygiene(t);
});

test('editable + misspelling → suggestions, Add to Dictionary, then edit verbs', () => {
  const { page, calls } = fakePage();
  const t = buildTemplate(P({
    isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tech'],
    editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
  }), page);
  assert.deepEqual(labels(t), [
    'the', 'tech', 'Add to Dictionary', '---',
    'Cut', 'Copy', 'Paste', 'Select All', '---', 'Inspect Element',
  ]);
  item(t, 'the').click();
  assert.deepEqual(calls[0], ['replaceMisspelling', 'the']);
  item(t, 'Add to Dictionary').click();
  assert.deepEqual(calls[1], ['addWord', 'teh']);
  assertSepHygiene(t);
});

test('non-editable selection → Copy + Search (foreground), label truncates & escapes', () => {
  const { page, calls, emits } = fakePage();
  const long = '  the quick   brown fox jumps over the lazy dog & then some more words  ';
  const t = buildTemplate(P({ selectionText: long }), page);
  const L = labels(t);
  assert.equal(L[0], 'Copy');
  assert.equal(L[2], '---');
  assert.equal(L[3], 'Inspect Element');
  const searchLabel = L[1];
  assert.ok(searchLabel.startsWith('Search for “'), 'search item present');
  assert.ok(searchLabel.includes('…'), 'long selection is truncated');
  if (process.platform === 'win32') {
    assert.ok(searchLabel.includes('&&'), 'on Win32 a literal & is doubled for the native menu mnemonic');
  }
  assert.ok(!/\s{2,}/.test(searchLabel), 'runs of whitespace are collapsed');
  // Copy uses the webContents; Search bubbles a foreground tab with the trimmed query.
  item(t, 'Copy').click();
  assert.deepEqual(calls[0], ['copy']);
  item(t, searchLabel).click();
  assert.equal(emits[0][0], 'open-tab');
  assert.equal(emits[0][1], 'https://www.google.com/search?q=' + encodeURIComponent(long.trim()));
  assert.deepEqual(emits[0][2], { background: false });
});

test('selection inside an editable field → edit verbs win (not the search item)', () => {
  const { page } = fakePage();
  const t = buildTemplate(P({ isEditable: true, selectionText: 'hi', editFlags: { canCopy: true } }), page);
  assert.ok(item(t, 'Cut'), 'editable branch chosen');
  assert.equal(labels(t).some((l) => l.startsWith('Search for')), false, 'no search item in editable');
});

test('non-image media (e.g. video) → Inspect only, no stray separators', () => {
  const { page } = fakePage();
  const t = buildTemplate(P({ mediaType: 'video' }), page);
  assert.deepEqual(labels(t), ['Inspect Element']); // no section matched → just Inspect, no separator
});

test('Inspect Element bubbles page-local coords', () => {
  const { page, emits } = fakePage();
  const t = buildTemplate(P({ x: 7, y: 99 }), page);
  item(t, 'Inspect Element').click();
  assert.deepEqual(emits[0], ['inspect', 7, 99]);
});

test('Reload click drives the page', () => {
  const { page, calls } = fakePage();
  const t = buildTemplate(P(), page);
  item(t, 'Reload').click();
  assert.deepEqual(calls[0], ['reload']);
});

test('menuLabel: collapses whitespace, caps length at the boundary, escapes & on Win32', () => {
  assert.equal(menuLabel('  the   quick  brown  '), 'the quick brown', 'whitespace collapsed + trimmed');
  assert.equal(menuLabel('a'.repeat(48)), 'a'.repeat(48), 'exactly max passes through unclipped');
  const clipped = menuLabel('a'.repeat(49));
  assert.equal(clipped, 'a'.repeat(47) + '…', 'over max → (max-1) chars + ellipsis');
  assert.equal(clipped.length, 48, 'the clipped label fits the cap');
  // & escaping is a Win32 native-mnemonic concern; off-Win32 the glyph is shown literally (NIT #6).
  if (process.platform === 'win32') {
    assert.equal(menuLabel('a & b'), 'a && b', 'Win32 doubles & for the mnemonic');
  } else {
    assert.equal(menuLabel('a & b'), 'a & b', 'off-Win32 leaves & literal');
  }
});
