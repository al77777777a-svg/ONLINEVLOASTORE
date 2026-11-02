// A tiny helper for building page parts. Text is always added as text (never as HTML),
// so nothing that comes from Railway or from a bot can ever run as code on this page.

const PROPERTY_KEYS = new Set(['checked', 'disabled', 'selected', 'hidden', 'indeterminate', 'open', 'readOnly', 'required', 'multiple']);

function addChildren(parent, list) {
  for (const child of list) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) addChildren(parent, child);
    else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val === undefined || val === null || key === 'value') continue;
      if (key === 'class') {
        if (val) el.className = val;
      } else if (key === 'dataset') {
        Object.assign(el.dataset, val);
      } else if (key === 'style') {
        for (const [name, v] of Object.entries(val)) el.style.setProperty(name, v); // allowed by the page's security policy
      } else if (key.startsWith('on') && typeof val === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), val);
      } else if (PROPERTY_KEYS.has(key)) {
        el[key] = val;
      } else if (val !== false) {
        el.setAttribute(key, val === true ? '' : String(val));
      }
    }
  }
  addChildren(el, children);
  // A value has to be set after the options of a <select> exist.
  if (props && props.value !== undefined && props.value !== null) el.value = props.value;
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

export function mount(parent, ...children) {
  parent.replaceChildren();
  addChildren(parent, children);
  return parent;
}

let counter = 0;
export const uid = (prefix = 'id') => `${prefix}-${++counter}`;

/** Run a function after the current batch of work, so a dialog or page can finish opening first. */
export const later = (fn, ms = 0) => setTimeout(fn, ms);

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older or non-secure pages: fall back to a hidden text box.
    const box = h('textarea', { 'aria-hidden': 'true', readOnly: true, style: { position: 'fixed', top: '0', left: '-9999px' } });
    box.value = text;
    document.body.appendChild(box);
    box.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    box.remove();
    return ok;
  }
}

export function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
