'use strict';
// Runs on the pane://error page. Navigation re-points this same view via paneInternal.navigate.
const q = new URLSearchParams(location.search);
const failedUrl = q.get('url') || '';
const code = q.get('code') || '';
const desc = q.get('desc') || '';

let host = failedUrl;
try { host = new URL(failedUrl).host || failedUrl; } catch { /* keep raw */ }

const CAUSES = {
  '-105': `${host} doesn't resolve. Check the address.`,
  '-106': 'You appear to be offline.',
  '-102': `${host} refused the connection.`,
  '-7': `${host} took too long to respond.`,
  '-118': `${host} took too long to respond.`,
  '-109': `${host} is unreachable.`,
  '-201': `${host} has a certificate problem.`,
  '-202': `${host} has a certificate problem.`,
};
const fallback = desc ? desc.replace(/^ERR_/, '').replace(/_/g, ' ').toLowerCase() : 'The connection failed.';

document.getElementById('cause').textContent = CAUSES[code] || fallback;
document.getElementById('url').textContent = failedUrl;

const go = (url) => { if (window.paneInternal) window.paneInternal.navigate(url); else location.href = url; };
document.getElementById('retry').addEventListener('click', () => { if (failedUrl) go(failedUrl); });
document.getElementById('search').addEventListener('click', () => {
  go('https://www.google.com/search?q=' + encodeURIComponent(host || failedUrl));
});

// Certificate errors (Chromium net codes -200..-299): state the risk plainly and offer a
// deliberately un-styled "Proceed anyway" that trusts this host for the tab, then reloads (DESIGN §14).
const codeNum = Number(code);
if (codeNum <= -200 && codeNum >= -299) {
  document.getElementById('cause').textContent = `This connection isn't private. ${host} has a certificate problem.`;
  const proceed = document.getElementById('proceed');
  proceed.hidden = false;
  proceed.addEventListener('click', async () => {
    try { if (window.paneInternal && window.paneInternal.cert) await window.paneInternal.cert.allow(host); } catch { /* fall through to navigate */ }
    if (failedUrl) go(failedUrl);
  });
}
