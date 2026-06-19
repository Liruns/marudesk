// The 2px trickle loading bar (DESIGN §15) — ease only, never hangs.
import { $ } from '../lib/dom.js';

export function initLoadingBar() {
  const bar = $('#loadingbar');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let trickle = null;
  let reset = null;
  let fade = null; // the inner width→0 timer; tracked so start() can cancel a pending reset

  const clearTimers = () => { clearInterval(trickle); clearTimeout(reset); clearTimeout(fade); };

  function start() {
    clearTimers();
    bar.style.transition = 'width 0.15s linear, opacity 0.2s ease';
    bar.style.opacity = '1';
    // DESIGN §15.5: under reduced-motion the trickle becomes a simple two-step fill — no creep.
    if (reduced) { bar.style.width = '80%'; return; }
    let w = 8;
    bar.style.width = w + '%';
    trickle = setInterval(() => {
      w += (80 - w) * 0.12; // ease toward the 80% wall
      bar.style.width = w.toFixed(1) + '%';
      if (w > 79.5) clearInterval(trickle);
    }, 180);
  }

  function stop() {
    clearTimers();
    // Completion leg eases 80→100% (DESIGN §15: ease-standard over motion-standard),
    // then fades. Tokens resolve from :root; reduced-motion drops the transition (base.css).
    bar.style.transition = 'width var(--motion-standard) var(--ease-standard), opacity 0.2s ease';
    bar.style.width = '100%';
    reset = setTimeout(() => {
      bar.style.opacity = '0';
      fade = setTimeout(() => { bar.style.width = '0%'; }, 220);
    }, 300); // hold for the completion leg before fading out
  }

  window.pane.onLoading((d) => (d.loading ? start() : stop()));
}
