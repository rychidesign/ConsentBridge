// A minimal fake browser page for running ConsentBridge in node:vm.
// It implements only what the script uses and throws on selectors it can't match,
// so a test can't pass by accident. Extend it when the script needs more.
import vm from 'node:vm';

const dataName = (key) => 'data-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

class FakeElement {
  constructor(tagName, attributes = {}, children = []) {
    this.tagName = tagName.toUpperCase();
    this.attrs = new Map(Object.entries(attributes).map(([name, value]) => [name, String(value)]));
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.checked = false;
    this.textContent = '';
    this.listeners = [];
    this.dataset = new Proxy({}, {
      get: (_, key) => (typeof key === 'string' ? this.getAttribute(dataName(key)) ?? undefined : undefined),
      set: (_, key, value) => { this.setAttribute(dataName(key), value); return true; },
    });
    children.forEach((child) => this.appendChild(child));
  }

  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }

  get type() { return this.getAttribute('type') ?? ''; }
  set type(value) { this.setAttribute('type', value); }
  get src() { return this.getAttribute('src') ?? ''; }
  set src(value) { this.setAttribute('src', value); }

  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, ref) {
    const index = ref ? this.children.indexOf(ref) : this.children.length;
    if (index === -1) throw new Error('fake page: insertBefore reference is not a child');
    child.parentNode = this;
    this.children.splice(index, 0, child);
    return child;
  }
  get nextSibling() {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  addEventListener(type, listener) { this.listeners.push({ type, listener }); }
  click() {
    const event = { type: 'click', target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.listeners.filter((l) => l.type === 'click').forEach((l) => l.listener(event));
    return event;
  }
}

// Supports `tag`, `[attr]` and `[attr="value"]`, combined (e.g. `script[type="text/plain"][data-x]`).
function matcher(selector) {
  const parts = /^([a-z]*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/.exec(selector);
  if (!parts) throw new Error(`fake page: unsupported selector ${selector}`);
  const tag = parts[1].toUpperCase();
  const attrs = [...parts[2].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
  return (el) => (!tag || el.tagName === tag)
    && attrs.every(([, name, value]) => el.hasAttribute(name) && (value === undefined || el.getAttribute(name) === value));
}

class FakeDocument {
  constructor(body) {
    this.readyState = 'loading';
    this.currentScript = null;
    this.head = new FakeElement('head');
    this.body = new FakeElement('body', {}, body);
    this.documentElement = new FakeElement('html', {}, [this.head, this.body]);
    this.listeners = [];
    this.cookies = new Map();
  }

  createElement(tagName) { return new FakeElement(tagName); }
  querySelectorAll(selector) {
    const matches = matcher(selector);
    const found = [];
    const walk = (el) => { if (matches(el)) found.push(el); el.children.forEach(walk); };
    walk(this.documentElement);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getElementsByTagName(tagName) { return this.querySelectorAll(tagName.toLowerCase()); }

  addEventListener(type, listener) { this.listeners.push({ type, listener }); }
  dispatch(type) { this.listeners.filter((l) => l.type === type).forEach((l) => l.listener({ type })); }

  // Cookies are keyed by name, domain and path, like in a browser. max-age <= 0 deletes.
  get cookie() { return [...this.cookies.values()].map((c) => `${c.name}=${c.value}`).join('; '); }
  set cookie(text) {
    const [pair, ...attrs] = text.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    const cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
    for (const attr of attrs) {
      const [key, value = ''] = attr.split('=');
      cookie[key.toLowerCase()] = value;
    }
    const key = `${cookie.name};${cookie.domain ?? ''};${cookie.path ?? ''}`;
    if (cookie['max-age'] !== undefined && Number(cookie['max-age']) <= 0) this.cookies.delete(key);
    else this.cookies.set(key, cookie);
  }
}

export const h = (tagName, attributes, ...children) => new FakeElement(tagName, attributes, children);

// Builds a page with the ConsentBridge script tag in <head> and `body` elements in <body>.
// `storage` seeds localStorage; `blockStorage` makes every localStorage access throw.
export function createPage({ script = {}, body = [], storage = {}, blockStorage = false, hostname = 'www.example.com', protocol = 'https:' } = {}) {
  const document = new FakeDocument(body);
  const scriptTag = document.head.appendChild(h('script', { src: 'consentbridge.min.js', ...script }));
  const items = new Map(Object.entries(storage));
  const localStorage = {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
  };
  const logs = [];
  const console = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug']
    .map((level) => [level, (...args) => logs.push({ level, args })]));

  const window = { document, console, location: { hostname, protocol } };
  Object.defineProperty(window, 'localStorage', {
    get() { if (blockStorage) throw new Error('SecurityError: localStorage is blocked'); return localStorage; },
  });
  window.window = window;
  vm.createContext(window);

  return {
    window, document, storage: items, logs,
    // Runs code as a script element. `document.currentScript` is the ConsentBridge tag unless
    // `currentScript` says otherwise (null for an inline script).
    exec(code, filename, currentScript = scriptTag) {
      document.currentScript = currentScript;
      vm.runInContext(code, window, { filename });
      document.currentScript = null;
      return this;
    },
    // Ends parsing: readyState becomes interactive and DOMContentLoaded fires.
    ready() {
      document.readyState = 'interactive';
      document.dispatch('DOMContentLoaded');
      return this;
    },
    click(selector) {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`fake page: nothing matches ${selector}`);
      return el.click();
    },
  };
}
