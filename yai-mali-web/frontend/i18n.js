'use strict';
// EN | ไทย switch for the Yai Mali pages. English is the default; the choice is kept in localStorage and shared
// by every page. Load this file without defer in <head>, then each page's dictionary (YaiI18n.add), then the page.
//
// The pages are written in English. In Thai mode every visible text node and the placeholder, aria-label,
// title and alt attributes are swapped for their Thai entry, including text the page renders later (a
// MutationObserver). Switching back restores the exact English. A string joined with " · " is translated
// part by part. Nothing under [translate="no"] is touched: chat bubbles, transcripts and clue values stay
// exactly as typed or heard, and Yai always speaks Thai.
(() => {
  const KEY = 'yai-lang';
  const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  const NO = '[translate="no"]';                              // never touched, text or attributes
  const NO_TEXT = `${NO},script,style,noscript,textarea`;     // text inside these is code or user input
  const root = document.documentElement;
  const dict = new Map();
  const patterns = [];
  const texts = new WeakMap(); // Text node -> {en, th} written by us
  const attrs = new WeakMap(); // Element -> Map(attribute -> {en, th})
  const listeners = [];
  let lang = 'en';
  try { if (localStorage.getItem(KEY) === 'th') lang = 'th'; } catch {}

  function lookup(s) {
    if (dict.has(s)) return dict.get(s);
    for (const [re, to] of patterns) {
      const m = s.match(re);
      if (m) return typeof to === 'function' ? to(m, tr) : s.replace(re, to);
    }
    return null;
  }
  // Thai for one English string, keeping surrounding whitespace; unknown text is returned unchanged.
  function tr(s) {
    const lead = s.match(/^\s*/)[0];
    const core = s.slice(lead.length).trimEnd();
    if (!core) return s;
    const trail = s.slice(lead.length + core.length);
    let out = lookup(core);
    if (out === null && core.includes('·')) {
      const parts = core.split(/(\s*·\s*)/);
      const joined = parts.map((p, i) => (i % 2 || !p ? p : lookup(p) ?? p)).join('');
      if (joined !== core) out = joined;
    }
    return out === null ? s : lead + out + trail;
  }

  const off = (el, sel) => !el || !!el.closest(sel);
  function applyText(node) {
    if (off(node.parentElement, NO_TEXT)) return;
    const seen = texts.get(node);
    if (lang === 'th') {
      if (seen && node.data === seen.th) return; // our own write
      const th = tr(node.data);
      if (th === node.data) { texts.delete(node); return; }
      texts.set(node, {en: node.data, th});
      node.data = th;
    } else if (seen) {
      if (node.data === seen.th) node.data = seen.en;
      texts.delete(node);
    }
  }
  function applyAttr(el, name) {
    if (!el.hasAttribute(name) || off(el, NO)) return;
    const value = el.getAttribute(name);
    let map = attrs.get(el);
    const seen = map?.get(name);
    if (lang === 'th') {
      if (seen && value === seen.th) return; // our own write
      const th = tr(value);
      if (th === value) { map?.delete(name); return; }
      if (!map) attrs.set(el, (map = new Map()));
      map.set(name, {en: value, th});
      el.setAttribute(name, th);
    } else if (seen) {
      if (value === seen.th) el.setAttribute(name, seen.en);
      map.delete(name);
    }
  }
  const filter = {acceptNode: n => (n.nodeType === 1 && n.matches(NO) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)};
  function walk(start) {
    if (start.nodeType === 3) return applyText(start);
    if (start.nodeType !== 1 || off(start, NO)) return;
    for (const a of ATTRS) applyAttr(start, a);
    const w = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, filter);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 3) applyText(n);
      else for (const a of ATTRS) applyAttr(n, a);
    }
  }
  const observer = new MutationObserver(records => {
    if (lang !== 'th') return;
    for (const r of records) {
      if (r.type === 'characterData') applyText(r.target);
      else if (r.type === 'attributes') applyAttr(r.target, r.attributeName);
      else r.addedNodes.forEach(walk);
    }
  });
  function sync() {
    document.querySelectorAll('[data-lang]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  }
  function set(next) {
    next = next === 'th' ? 'th' : 'en';
    try { localStorage.setItem(KEY, next); } catch {}
    if (next !== lang) {
      lang = next;
      root.lang = lang;
      walk(root);
      listeners.forEach(fn => fn(lang));
    }
    sync();
  }

  window.YaiI18n = Object.freeze({
    get lang() { return lang; },
    // entries: {English: Thai}; list: [[RegExp, replacement string or (match, tr) => string]] tried in order.
    add(entries, list = []) {
      for (const [en, th] of Object.entries(entries)) dict.set(en, th);
      patterns.push(...list);
    },
    t: s => (lang === 'th' ? tr(s) : s),
    set,
    onChange(fn) { listeners.push(fn); },
  });

  root.lang = lang;
  // Hide the page until Thai is applied, so English never flashes; never longer than a second.
  if (lang === 'th') {
    root.classList.add('i18n-pending');
    setTimeout(() => root.classList.remove('i18n-pending'), 1000);
  }
  document.addEventListener('DOMContentLoaded', () => {
    walk(root);
    observer.observe(root, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS});
    root.classList.remove('i18n-pending');
    sync();
  });
  document.addEventListener('click', e => {
    const b = e.target.closest?.('[data-lang]');
    if (b) set(b.dataset.lang);
  });
})();
