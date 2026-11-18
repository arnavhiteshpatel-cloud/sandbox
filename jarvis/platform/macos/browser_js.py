"""JavaScript injected into the user's browser tab (via AppleScript `execute javascript`).

Each snippet is a self-contained expression returning a JSON string. Elements get a stable
`data-jarvis-id` attribute so the agent can refer to them ("click w12") across turns
without coordinates. Open shadow roots and same-origin iframes are traversed.
"""

_FIND = r"""
const __jvRoots = () => { const out=[document]; const st=[document];
  while (st.length) { const r=st.pop(); r.querySelectorAll('*').forEach(el=>{ if (el.shadowRoot){ out.push(el.shadowRoot); st.push(el.shadowRoot);} }); }
  document.querySelectorAll('iframe').forEach(f=>{ try { if (f.contentDocument) out.push(f.contentDocument); } catch(e){} });
  return out; };
const __jvFind = (id) => { for (const r of __jvRoots()) { const el=r.querySelector('[data-jarvis-id="'+id+'"]'); if (el) return el; } return null; };
"""

SNAPSHOT = r"""
(() => {
__FIND__
  const MAX = __MAX__;
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[role=switch],[role=treeitem],[onclick],[contenteditable=""],[contenteditable=true]';
  const vis = el => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.05; };
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const label = el => clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText ||
      el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||
      (el.querySelector && el.querySelector('img[alt]') && el.querySelector('img[alt]').alt) || el.getAttribute('name') || '').slice(0, 140);
  const seen = new Set(); const items = [];
  for (const root of __jvRoots()) root.querySelectorAll(SEL).forEach(el => { if (!seen.has(el)) { seen.add(el); items.push(el); } });
  const vh = window.innerHeight; const out = [];
  for (const el of items) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    let id = el.getAttribute('data-jarvis-id');
    if (!id) { window.__jvSeq = (window.__jvSeq || 0) + 1; id = 'w' + window.__jvSeq; el.setAttribute('data-jarvis-id', id); }
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? ('input:' + (el.type || 'text')) : tag);
    const e = { id, role, name: label(el), in_view: r.bottom > 0 && r.top < vh, y: Math.round(r.top + window.scrollY) };
    if (tag === 'a' && el.href) e.href = el.href.slice(0, 200);
    if ('value' in el && tag !== 'button' && el.value) e.value = String(el.value).slice(0, 80);
    if (tag === 'select') { e.options = [...el.options].map(o => o.text.trim()).filter(Boolean).slice(0, 20);
      if (el.selectedIndex >= 0) e.value = (el.options[el.selectedIndex] || {}).text || e.value; }
    if (el.type === 'radio' || el.type === 'checkbox') { if (el.name) e.group = el.name.slice(0, 40); e.checked = !!el.checked; }
    if (el.disabled) e.disabled = true;
    if (el.checked) e.checked = true;
    if (!e.name && !e.href && !role.startsWith('input')) continue;
    out.push(e);
  }
  out.sort((a, b) => (b.in_view - a.in_view) || (a.y - b.y));
  const main = document.querySelector('main, [role=main], article') || document.body;
  const se = document.scrollingElement || document.documentElement;
  return JSON.stringify({
    url: location.href, title: document.title, ready: document.readyState,
    scroll: { y: Math.round(se.scrollTop), max: Math.max(0, se.scrollHeight - se.clientHeight) },
    elements: out.slice(0, MAX), total_elements: out.length,
    text: clean(main ? main.innerText : '').slice(0, __TEXT__)
  });
})()
"""

CLICK = r"""
(() => {
__FIND__
  const el = __jvFind(__ID__);
  if (!el) return JSON.stringify({ ok: false, error: 'element not found (page changed?)' });
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const name = (el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const before = location.href;
  try { el.focus({ preventScroll: true }); } catch (e) {}
  const r = el.getBoundingClientRect(); const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent('pointerdown', opts)); el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts)); el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
  return JSON.stringify({ ok: true, name, before });
})()
"""

TYPE = r"""
(() => {
__FIND__
  const el = __ID__ ? __jvFind(__ID__) : document.activeElement;
  if (!el) return JSON.stringify({ ok: false, error: 'element not found' });
  const text = __TEXT__;
  el.scrollIntoView({ block: 'center' }); el.focus();
  if (el.isContentEditable) { document.execCommand('selectAll', false); document.execCommand('insertText', false, text); }
  else if (el.tagName === 'SELECT') {
    const want = String(text).trim().toLowerCase();
    let idx = [...el.options].findIndex(o => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want);
    if (idx < 0) idx = [...el.options].findIndex(o => o.text.trim().toLowerCase().includes(want));
    if (idx < 0) return JSON.stringify({ ok: false, error: 'no option "' + text + '"; options: ' + [...el.options].map(o => o.text.trim()).join(' | ').slice(0, 300) });
    el.selectedIndex = idx;
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ ok: true, value: el.options[idx].text.trim() });
  }
  else {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return JSON.stringify({ ok: true, value: String(el.value !== undefined ? el.value : el.innerText).slice(0, 80) });
})()
"""

SCROLL = r"""
(() => {
  const dy = __DY__;
  const cands = [document.scrollingElement || document.documentElement];
  document.querySelectorAll('*').forEach(el => { const s = getComputedStyle(el);
    if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 20) cands.push(el); });
  const area = el => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * r.width; };
  let target = cands[0];
  const docCan = target.scrollHeight > target.clientHeight + 20;
  if (!docCan) { let best = 0; for (const el of cands.slice(1)) { const a = area(el); if (a > best) { best = a; target = el; } } }
  const before = target.scrollTop; target.scrollBy({ top: dy * innerHeight, behavior: 'instant' });
  return JSON.stringify({ ok: true, moved: Math.round(target.scrollTop - before), y: Math.round(target.scrollTop), max: target.scrollHeight - target.clientHeight });
})()
"""

READ = r"""
(() => {
  const clean = s => (s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const sel = String(window.getSelection ? window.getSelection() : '');
  const main = document.querySelector('main, [role=main], article') || document.body;
  return JSON.stringify({ url: location.href, title: document.title, selection: sel.slice(0, 4000), text: clean(main.innerText).slice(0, __MAX__) });
})()
"""

STATE = r"""JSON.stringify({url: location.href, title: document.title, ready: document.readyState})"""


SNAPSHOT = SNAPSHOT.replace("__FIND__", _FIND)
CLICK = CLICK.replace("__FIND__", _FIND)
TYPE = TYPE.replace("__FIND__", _FIND)
