// Roving keyboard navigation for a popover menu (DESIGN §6 a11y). Items are the panel's
// [role="menuitem"] children that aren't .disabled. Wire once per panel with initMenuNav();
// call focusFirstItem() right after opening. Arrow/Home/End move focus; Enter/Space activate
// via a synthetic click (so the row's existing handler runs); Escape is left to the caller.
export function initMenuNav(panel) {
  panel.addEventListener('keydown', (e) => {
    const items = [...panel.querySelectorAll('[role^="menuitem"]:not(.disabled)')];
    if (!items.length) return;
    const cur = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(cur + 1 + items.length) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(cur - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (cur >= 0) items[cur].click(); }
  });
  // Focus follows the pointer so the keyboard highlight and hover are the same single row.
  panel.addEventListener('mousemove', (e) => {
    const item = e.target.closest('[role^="menuitem"]:not(.disabled)');
    if (item && item !== document.activeElement) item.focus();
  });
}

export function focusFirstItem(panel) {
  const first = panel.querySelector('[role^="menuitem"]:not(.disabled)');
  if (first) first.focus();
}
