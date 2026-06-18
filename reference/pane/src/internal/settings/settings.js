'use strict';
// pane://settings — user preferences. The ⋮ menu is now a launcher; settings live here.
const restoreToggle = document.getElementById('restore');
const clearBtn = document.getElementById('clear');

function setRestore(next) {
  restoreToggle.classList.toggle('checked', next);
  restoreToggle.setAttribute('aria-checked', String(next));
  window.paneInternal.settings.set('restoreSession', next);
}

restoreToggle.addEventListener('click', () => setRestore(!restoreToggle.classList.contains('checked')));
restoreToggle.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setRestore(!restoreToggle.classList.contains('checked')); }
});

clearBtn.addEventListener('click', async () => {
  await window.paneInternal.history.clear();
  clearBtn.textContent = 'Cleared';
  clearBtn.disabled = true;
  setTimeout(() => { clearBtn.textContent = 'Clear'; clearBtn.disabled = false; }, 1200);
});

(async () => {
  const s = await window.paneInternal.settings.get();
  const on = !!s.restoreSession;
  restoreToggle.classList.toggle('checked', on);
  restoreToggle.setAttribute('aria-checked', String(on));
})();
