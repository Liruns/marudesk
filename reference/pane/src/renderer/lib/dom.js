// Tiny DOM helpers shared across feature modules.
export const $ = (sel, root = document) => root.querySelector(sel);
export const on = (el, type, handler, opts) => el.addEventListener(type, handler, opts);
