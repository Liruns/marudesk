// Transient confirmation pill (DESIGN §10: confirmations are "quiet and brief… fades").
// Driven by main → CH.TOAST (e.g. Ctrl+D bookmark toggle).
let el, hideTimer, goneTimer;

export function initToast() {
  el = document.createElement('div');
  el.id = 'toast';
  el.hidden = true;
  document.body.append(el);
  window.pane.onToast((msg) => show(msg));
}

function show(msg) {
  clearTimeout(hideTimer);
  clearTimeout(goneTimer);
  el.textContent = msg;
  el.hidden = false;
  void el.offsetWidth; // reflow so the transition runs
  el.classList.add('show');
  hideTimer = setTimeout(() => {
    el.classList.remove('show');
    goneTimer = setTimeout(() => { el.hidden = true; }, 200);
  }, 1400);
}
