export const INSPECT_OVERLAY_SCRIPT = String.raw`
(() => {
  if (window.__marudeskInspectActive) return;
  window.__marudeskInspectActive = true;

  const ACCENT = '#5E6AD2';
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    'z-index:2147483646',
    'border:2px solid ' + ACCENT,
    'background:rgba(94,106,210,0.10)',
    'transition:none',
    'box-sizing:border-box',
    'top:0;left:0;width:0;height:0;display:none',
  ].join(';');

  const tooltip = document.createElement('div');
  tooltip.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    'z-index:2147483647',
    'background:#0F1011',
    'color:#F4F4F5',
    'border:1px solid #2A2B2F',
    'border-radius:4px',
    'padding:4px 8px',
    'font:12px ui-sans-serif,system-ui,-apple-system,Inter,sans-serif',
    'font-variant-numeric:tabular-nums',
    'top:0;left:0;display:none',
    'max-width:360px',
    'white-space:nowrap',
    'overflow:hidden',
    'text-overflow:ellipsis',
  ].join(';');

  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(tooltip);

  function buildSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return '';
    if (el.id) return '#' + cssEscape(el.id);
    const path = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && path.length < 8) {
      let part = node.tagName.toLowerCase();
      if (node.classList && node.classList.length) {
        const classes = Array.from(node.classList).slice(0, 2).map(cssEscape).join('.');
        if (classes) part += '.' + classes;
      } else if (node.parentElement) {
        const siblings = Array.from(node.parentElement.children).filter(
          (c) => c.tagName === node.tagName,
        );
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
      }
      path.unshift(part);
      node = node.parentElement;
    }
    return path.join(' > ');
  }

  function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function summarize(el) {
    const rect = el.getBoundingClientRect();
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    const text = (el.textContent || '').trim().slice(0, 120);
    return {
      id: 'cap_' + Math.random().toString(36).slice(2, 10),
      timestamp: Date.now(),
      url: location.href,
      selector: buildSelector(el),
      tagName: el.tagName.toLowerCase(),
      text,
      attributes: attrs,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  function moveOverlay(el) {
    const rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    tooltip.style.display = 'block';
    const sel = buildSelector(el);
    tooltip.textContent = el.tagName.toLowerCase() + (sel ? ' · ' + sel : '');
    const tipTop = rect.top - 24 < 8 ? rect.bottom + 4 : rect.top - 24;
    tooltip.style.top = tipTop + 'px';
    tooltip.style.left = Math.max(8, rect.left) + 'px';
  }

  function hideOverlay() {
    overlay.style.display = 'none';
    tooltip.style.display = 'none';
  }

  function onMove(e) {
    const target = e.target;
    if (!target || target === overlay || target === tooltip) return;
    moveOverlay(target);
  }

  function onClick(e) {
    const target = e.target;
    if (!target || target === overlay || target === tooltip) return;
    e.preventDefault();
    e.stopPropagation();
    if (window.__marudeskBridge && window.__marudeskBridge.capture) {
      window.__marudeskBridge.capture(summarize(target));
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (window.__marudeskBridge && window.__marudeskBridge.exit) {
        window.__marudeskBridge.exit();
      }
    }
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', hideOverlay, true);

  window.__marudeskInspectTeardown = function () {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', hideOverlay, true);
    overlay.remove();
    tooltip.remove();
    window.__marudeskInspectActive = false;
    window.__marudeskInspectTeardown = null;
  };
})();
`;

export const INSPECT_OVERLAY_TEARDOWN = String.raw`
(() => {
  if (window.__marudeskInspectTeardown) {
    window.__marudeskInspectTeardown();
  }
})();
`;
