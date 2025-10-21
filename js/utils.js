(() => {
  'use strict';
  const $ = (sel) => {
    const nodes = document.querySelectorAll(sel);
    if (nodes.length <= 1) {
      return nodes[0] || null;
    }

    return Array.from(nodes);
  };

  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const pad2 = (n) => String(n).padStart(2, '0');
  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  window.DOMUtils = { $, $$, pad2, escapeHtml };
})();
