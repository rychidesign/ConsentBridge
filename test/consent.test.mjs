// Regression tests for the consent flow. Each scenario runs against the source and the built file.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPage, h } from './fake-page.mjs';

const SIGNALS = ['analytics_storage', 'ad_storage', 'ad_user_data', 'ad_personalization', 'functionality_storage'];
const all = (value) => Object.fromEntries(SIGNALS.map((s) => [s, value]));
const DENIED = all('denied');
const GRANTED = all('granted');
const CATEGORIES = ['analytics', 'marketing', 'preferences'];

const settingsModal = (tag = 'div', attributes = {}) => h(tag, { 'data-cb-modal': 'settings', ...attributes },
  ...CATEGORIES.map((c) => h('input', { type: 'checkbox', 'data-cb-category': c })),
  h('button', { 'data-cb-action': 'save-settings' }),
  h('button', { 'data-cb-action': 'close-modal' }));

// Banner, settings modal, a footer link and one blocked script per category.
const consentUi = (modal = settingsModal()) => [
  h('div', { 'data-cb-banner': '' },
    h('button', { 'data-cb-action': 'accept-all' }),
    h('button', { 'data-cb-action': 'reject-all' }),
    h('button', { 'data-cb-action': 'open-settings' })),
  modal,
  h('a', { 'data-cb-action': 'reopen-settings' }),
  ...CATEGORIES.map((c) => h('script', { type: 'text/plain', 'data-cb-consent-category': c, src: `https://example.com/${c}.js` })),
];

// Values from the script's realm are normalized so deepEqual compares plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const isArguments = (entry) => Object.prototype.toString.call(entry) === '[object Arguments]';

// The inline snippet as sites paste it, and the code inside its <script> tag.
const SNIPPET = readFileSync('src/snippet.html', 'utf8');
const SNIPPET_CODE = /^<script>\n([\s\S]*)<\/script>\n$/.exec(SNIPPET)[1];

const DAY = 24 * 60 * 60 * 1000;
const record = (state, ageDays = 1) => ({ v: 1, state, timestamp: Date.now() - ageDays * DAY });

// A cookie jar holding consent cookies set on www.example.com. Each entry is a record, a string,
// or { raw } for a value stored without encoding, plus optional extra cookie attributes.
function jarWith(...cookies) {
  const jar = new Map();
  const { document } = createPage({ cookies: jar });
  for (const [value, attributes = ''] of cookies) {
    const encoded = value.raw ?? encodeURIComponent(typeof value === 'string' ? value : JSON.stringify(value));
    document.cookie = `consentbridge=${encoded}; path=/${attributes}`;
  }
  return jar;
}

// Runs the inline snippet, then the script. `ready` says when DOMContentLoaded fires:
// 'after' the script (default), 'before' it, or never (false). `setup` runs first.
function open(code, file, { snippet = true, ready = 'after', setup = () => {}, ...options } = {}) {
  const page = createPage({ body: consentUi(), ...options });
  setup(page);
  // Every cb:consent event, and whether window.ConsentBridge existed when it fired.
  const cbEvents = [];
  page.document.addEventListener('cb:consent', (event) => cbEvents.push({ detail: plain(event.detail), api: Boolean(page.window.ConsentBridge) }));
  if (snippet) page.exec(SNIPPET_CODE, 'src/snippet.html', null);
  if (ready === 'before') page.ready();
  page.exec(code, file);
  if (ready === 'after') page.ready();
  const $ = (selector) => page.document.querySelector(selector);
  return Object.assign(page, {
    $,
    cbEvents: () => cbEvents.map((e) => e.detail),
    apiReadyForEvents: () => cbEvents.every((e) => e.api),
    action: (name) => page.click(`[data-cb-action="${name}"]`),
    consent: () => plain(Array.from(page.window.dataLayer).filter(isArguments).map((args) => Array.from(args))).filter((args) => args[0] === 'consent'),
    events: (name) => plain(page.window.dataLayer.filter((entry) => !isArguments(entry) && entry.event === name)),
    activated: () => CATEGORIES.filter((c) => $(`script[data-cb-consent-category="${c}"]`).getAttribute('data-cb-activated') === 'true'),
    consentCookies: () => [...page.cookies.values()].filter((c) => c.name === 'consentbridge'),
    stored: () => {
      const [cookie, ...more] = page.document.visibleCookies().filter((c) => c.name === 'consentbridge');
      assert.equal(more.length, 0, 'more than one consent cookie');
      return JSON.parse(decodeURIComponent(cookie.value));
    },
    problems: () => page.logs.filter((l) => l.level === 'warn' || l.level === 'error'),
  });
}

test('the inline snippet stays under 2,000 characters', () => {
  assert.ok(SNIPPET.length < 2000, `${SNIPPET.length} characters`);
});

test('the README and the Webflow guide show the current inline snippet', () => {
  const lines = (text) => text.split('\n').map((line) => line.trim()).join('\n');
  for (const doc of ['README.md', 'docs/webflow.md']) {
    assert.ok(lines(readFileSync(doc, 'utf8')).includes(lines(SNIPPET.trimEnd())), doc);
  }
});

for (const file of ['src/consentbridge.js', 'dist/consentbridge.min.js']) {
  const code = readFileSync(file, 'utf8');
  const load = (options) => open(code, file, options);

  describe(file, () => {
    test('first visit: only the snippet default, banner shown, nothing stored or activated', () => {
      const page = load();
      assert.deepEqual(page.consent(), [['consent', 'default', { ...DENIED, wait_for_update: 500 }]]);
      assert.equal(page.$('[data-cb-banner]').style.display, 'block');
      assert.equal(page.cookies.size, 0);
      assert.deepEqual(page.activated(), []);
      assert.deepEqual(page.problems(), []);
    });

    test('accept all: everything granted, saved and activated', () => {
      const page = load();
      page.action('accept-all');
      assert.deepEqual(page.consent().at(-1), ['consent', 'update', GRANTED]);
      assert.deepEqual(page.events('consent_state_updated'), [{ event: 'consent_state_updated', consent_source: 'ui', updated_consent_state: GRANTED }]);
      assert.deepEqual(page.stored().state, GRANTED);
      assert.equal(page.stored().v, 1);
      assert.deepEqual(page.activated(), CATEGORIES);
      assert.equal(page.$('[data-cb-banner]').style.display, 'none');

      // The activated copy runs as a normal script and loses the consent attributes.
      const original = page.$('script[data-cb-consent-category="analytics"]');
      assert.equal(original.nextSibling.type, 'text/javascript');
      assert.equal(original.nextSibling.src, 'https://example.com/analytics.js');
      assert.equal(original.nextSibling.hasAttribute('data-cb-consent-category'), false);
    });

    test('window.ConsentBridge and cb:consent report the state', () => {
      const none = { analytics: false, marketing: false, preferences: false };
      const every = { analytics: true, marketing: true, preferences: true };
      const page = load();
      const api = page.window.ConsentBridge;
      // The first event reports the default, and the API exists before it fires.
      assert.deepEqual(page.cbEvents(), [{ decided: false, categories: none, signals: DENIED, source: 'default', changed: [] }]);
      assert.deepEqual(plain(api.getState()), { decided: false, categories: none, signals: DENIED });
      assert.equal(api.hasConsent('analytics'), false);

      page.action('accept-all');
      assert.deepEqual(page.cbEvents().at(-1), { decided: true, categories: every, signals: GRANTED, source: 'ui', changed: CATEGORIES });
      assert.equal(api.hasConsent('marketing'), true);

      api.rejectAll();
      assert.deepEqual(page.cbEvents().at(-1), { decided: true, categories: none, signals: DENIED, source: 'api', changed: CATEGORIES });
      assert.equal(page.events('consent_state_updated').at(-1).consent_source, 'api');
      assert.deepEqual(page.stored().state, DENIED);

      api.open();
      assert.equal(page.$('[data-cb-modal="settings"]').style.display, 'flex');
      api.acceptAll();
      assert.equal(page.$('[data-cb-modal="settings"]').style.display, 'none');
      // The same choice again still fires, with nothing changed.
      api.acceptAll();
      assert.deepEqual(page.cbEvents().at(-1).changed, []);
      // Unknown names, including inherited properties, are never granted.
      assert.equal(api.hasConsent('constructor'), false);
      assert.equal(api.hasConsent('unknown'), false);
      assert.equal(page.apiReadyForEvents(), true);

      // A returning visitor's first event comes from storage.
      const next = load({ cookies: page.cookies });
      assert.deepEqual(next.cbEvents(), [{ decided: true, categories: every, signals: GRANTED, source: 'storage', changed: CATEGORIES }]);
    });

    test('the integration pattern from the README gets the state once', () => {
      // A listener added before the script runs, as in a site's head code.
      const page = createPage({ body: consentUi() });
      const seen = [];
      const run = () => seen.push(page.window.ConsentBridge.getState().decided);
      if (page.window.ConsentBridge) run(); else page.document.addEventListener('cb:consent', run, { once: true });
      page.exec(code, file).ready();
      page.click('[data-cb-action="accept-all"]');
      assert.deepEqual(seen, [false]);
    });

    test('loading the script twice runs it once', () => {
      const page = load();
      page.exec(code, file);
      assert.equal(page.cbEvents().length, 1);
      assert.deepEqual(page.problems().map((l) => l.level), ['warn']);
      page.action('accept-all');
      assert.equal(page.consent().filter((c) => c[1] === 'update').length, 1);
    });

    test('a category named like an Object property is just unknown', () => {
      const page = load({ body: [...consentUi(), h('script', { type: 'text/plain', 'data-cb-consent-category': 'constructor', src: 'https://example.com/x.js' })] });
      page.action('accept-all');
      assert.equal(page.$('script[data-cb-consent-category="constructor"]').hasAttribute('data-cb-activated'), false);
    });

    test('loads no tags of its own and activates marked scripts even with a GTM ID set', () => {
      const page = load({ script: { 'data-cb-gtm-id': 'GTM-TEST', 'data-cb-ga4-id': 'G-TEST' } });
      page.action('accept-all');
      assert.deepEqual(page.activated(), CATEGORIES);
      // Own script tag, the blocked originals and their activated copies, nothing else.
      assert.equal(page.document.getElementsByTagName('script').length, 1 + 2 * CATEGORIES.length);
    });

    test('activated scripts keep document order and can need several categories', () => {
      const page = load({ body: [...consentUi(),
        h('script', { type: 'text/plain', 'data-cb-consent-category': ' analytics  marketing ', src: 'https://example.com/both.js' }),
        h('script', { type: 'text/plain', 'data-cb-consent-category': 'analytics', src: 'https://example.com/async.js', async: '' }),
        h('script', { type: 'text/plain', 'data-cb-consent-category': 'unknown', src: 'https://example.com/unknown.js' }),
      ] });
      const copies = () => page.document.querySelectorAll('script').filter((s) => s.type === 'text/javascript').map((s) => [s.src.split('/').pop(), s.async]);
      page.action('open-settings');
      page.$('[data-cb-category="analytics"]').checked = true;
      page.action('save-settings');
      assert.deepEqual(copies(), [['analytics.js', false], ['async.js', true]]);
      page.action('accept-all');
      assert.deepEqual(copies(), [['analytics.js', false], ['marketing.js', false], ['preferences.js', false], ['both.js', false], ['async.js', true]]);
    });

    test('reject all: nothing granted or activated, settings reopen unchecked', () => {
      const page = load();
      page.action('reject-all');
      assert.deepEqual(page.consent().at(-1), ['consent', 'update', DENIED]);
      assert.deepEqual(page.stored().state, DENIED);
      assert.deepEqual(page.activated(), []);

      page.action('reopen-settings');
      assert.equal(page.$('[data-cb-modal="settings"]').style.display, 'flex');
      assert.deepEqual(page.document.querySelectorAll('[data-cb-category]').map((c) => c.checked), [false, false, false]);
    });

    test('actions work on pages without a banner and on elements added later', () => {
      const first = load();
      first.action('accept-all');
      // A page with the settings modal and a footer link, but no banner.
      const [, settings] = consentUi();
      const page = load({ cookies: first.cookies, body: [settings, h('footer', {}, h('a', { 'data-cb-action': 'reopen-settings' }, h('span', {})))] });
      // A click on an element inside the link counts too.
      page.$('[data-cb-action="reopen-settings"]').children[0].click();
      assert.equal(page.$('[data-cb-modal="settings"]').style.display, 'flex');
      assert.deepEqual(page.document.querySelectorAll('[data-cb-category]').map((c) => c.checked), [true, true, true]);

      const added = page.document.body.appendChild(h('button', { 'data-cb-action': 'reject-all' }));
      assert.equal(added.click().defaultPrevented, true);
      assert.deepEqual(page.consent().at(-1), ['consent', 'update', DENIED]);
      // Clicks elsewhere are left alone.
      assert.equal(page.document.body.click().defaultPrevented, false);
    });

    test('data-cb-display sets how the banner and modal show', () => {
      const ui = consentUi(settingsModal('div', { 'data-cb-display': 'block' }));
      ui[0].setAttribute('data-cb-display', 'grid');
      const page = load({ body: ui });
      assert.equal(page.$('[data-cb-banner]').style.display, 'grid');
      page.action('open-settings');
      assert.equal(page.$('[data-cb-modal="settings"]').style.display, 'block');
    });

    test('the settings modal works with the keyboard', () => {
      const page = load();
      const modal = page.$('[data-cb-modal="settings"]');
      const opener = page.$('[data-cb-action="open-settings"]');
      opener.focus();
      opener.click();
      assert.deepEqual([modal.getAttribute('role'), modal.getAttribute('aria-modal')], ['dialog', 'true']);
      assert.equal(page.document.activeElement, page.$('[data-cb-category="analytics"]'));

      page.document.dispatch('keydown', { key: 'Escape' });
      assert.equal(modal.style.display, 'none');
      assert.equal(page.document.activeElement, opener);
      assert.equal(page.consent().length, 1, 'closing without saving changes nothing');

      opener.click();
      page.action('close-modal');
      assert.equal(modal.style.display, 'none');

      // A disabled "necessary" checkbox first in the modal can't take focus, so it's skipped.
      const modalWithNecessary = settingsModal();
      modalWithNecessary.insertBefore(h('input', { type: 'checkbox', checked: '', disabled: '' }), modalWithNecessary.children[0]);
      const withNecessary = load({ body: consentUi(modalWithNecessary) });
      withNecessary.action('open-settings');
      assert.equal(withNecessary.document.activeElement, withNecessary.$('[data-cb-category="analytics"]'));
    });

    test('a <dialog> modal opens and closes through its own API', () => {
      const page = load({ body: consentUi(settingsModal('dialog')) });
      const modal = page.$('[data-cb-modal="settings"]');
      page.action('open-settings');
      assert.deepEqual([modal.open, modal.modal, modal.style.display, modal.hasAttribute('role')], [true, true, undefined, false]);
      page.action('save-settings');
      assert.equal(modal.open, false);
    });

    test('Webflow custom checkboxes show the stored choice', () => {
      // Webflow's markup: the real input sits next to the element that shows its state.
      const webflowCheckbox = (category) => h('label', { class: 'w-checkbox' },
        h('div', { class: 'w-checkbox-input w-checkbox-input--inputType-custom' }),
        h('input', { type: 'checkbox', 'data-cb-category': category }));
      const modal = h('div', { 'data-cb-modal': 'settings' }, ...CATEGORIES.map(webflowCheckbox), h('button', { 'data-cb-action': 'save-settings' }));
      const page = load({ body: consentUi(modal) });
      const shown = () => page.document.querySelectorAll('.w-checkbox-input').map((el) => el.classList.contains('w--redirected-checked'));

      page.action('accept-all');
      page.action('reopen-settings');
      assert.deepEqual(shown(), [true, true, true]);
      page.action('reject-all');
      page.action('reopen-settings');
      assert.deepEqual(shown(), [false, false, false]);
    });

    test('saved settings grant only the checked categories', () => {
      const page = load();
      page.action('open-settings');
      page.$('[data-cb-category="analytics"]').checked = true;
      page.action('save-settings');
      assert.deepEqual(page.consent().at(-1), ['consent', 'update', { ...DENIED, analytics_storage: 'granted' }]);
      assert.deepEqual(page.activated(), ['analytics']);
      assert.equal(page.$('[data-cb-modal="settings"]').style.display, 'none');
    });

    test('returning visitor: the stored choice applies without the banner', () => {
      const first = load();
      first.action('open-settings');
      first.$('[data-cb-category="marketing"]').checked = true;
      first.action('save-settings');
      const { cookies } = first;
      const marketing = { ...DENIED, ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' };

      for (const ready of ['after', 'before']) {
        const page = load({ cookies, ready });
        assert.deepEqual(page.consent(), [['consent', 'default', { ...DENIED, wait_for_update: 500 }], ['consent', 'update', marketing]], ready);
        assert.deepEqual(page.events('consent_state_updated'), [{ event: 'consent_state_updated', consent_source: 'storage', updated_consent_state: marketing }], ready);
        assert.deepEqual(page.activated(), ['marketing'], ready);
        assert.equal(page.$('[data-cb-banner]').style.display, 'none', ready);
        assert.deepEqual(page.problems(), [], ready);
      }

      // The choice applies as soon as the script runs; only the banner waits for the DOM.
      const early = load({ cookies, ready: false });
      assert.deepEqual(early.consent().at(-1), ['consent', 'update', marketing]);
      assert.equal(early.events('consent_state_updated').length, 1);
      assert.equal(early.$('[data-cb-banner]').style.display, undefined);
      early.ready();
      assert.equal(early.$('[data-cb-banner]').style.display, 'none');
    });

    test('without the inline snippet: no default, but a choice still applies', () => {
      const page = load({ snippet: false });
      assert.deepEqual(page.consent(), []);
      page.action('accept-all');
      assert.deepEqual(page.consent(), [['consent', 'update', GRANTED]]);
    });

    test('blocked cookies: banner shown and a choice still applies', () => {
      const page = load({ blockCookies: true });
      assert.equal(page.$('[data-cb-banner]').style.display, 'block');
      page.action('accept-all');
      assert.deepEqual(page.consent().at(-1), ['consent', 'update', GRANTED]);
      assert.deepEqual(page.activated(), CATEGORIES);
    });

    test('warnings reach the console without dev mode, debug output only with it', () => {
      const levels = (page) => [...new Set(page.logs.map((l) => l.level))];
      assert.deepEqual(levels(load()), []);
      assert.deepEqual(levels(load({ cookies: jarWith(['not json{']) })), ['warn']);
      const blocked = load({ blockCookies: true });
      blocked.action('accept-all');
      assert.deepEqual(levels(blocked), ['warn']);
      assert.equal(blocked.logs.length, 2, 'one warning for the read, one for the write');
      assert.deepEqual(levels(load({ script: { 'data-cb-dev-mode': 'true' } })), ['log']);
    });

    test('dev mode warns about setup mistakes', () => {
      const dev = { 'data-cb-dev-mode': 'true' };
      const warnings = (page) => page.problems().map((l) => l.args[0]);
      assert.deepEqual(warnings(load({ script: dev })), [], 'the standard setup is clean');

      const gtm = (id) => h('script', { async: '', src: `https://www.googletagmanager.com/gtm.js?id=${id}` });
      const mistakes = () => [
        h('div', { 'data-cb-banner': '' }, h('button', { 'data-cb-action': 'accept-all' })),
        h('div', { 'data-cb-modal': 'settings' },
          h('input', { type: 'checkbox', 'data-cb-category': 'analytics', checked: '' }),
          h('input', { type: 'checkbox', 'data-cb-category': 'statistics' })),
        h('div', { 'data-cb-placeholder': 'marketing video' }),
        gtm('GTM-A'), gtm('GTM-B'), gtm('GTM-A'),
      ];
      // GTM's own snippet ran before the inline snippet.
      const gtmFirst = (page) => { page.window.dataLayer = [{ 'gtm.start': 1, event: 'gtm.js' }]; };
      const page = load({ script: dev, body: mistakes(), setup: gtmFirst });
      const expected = [/reject-all/, /"analytics" checkbox is checked/, /reopen-settings/, /"statistics" in data-cb-category/,
        /"video" in data-cb-placeholder/, /before the inline snippet/, /GTM-A is on the page more than once/];
      assert.equal(warnings(page).length, expected.length, warnings(page).join('\n'));
      expected.forEach((pattern, i) => assert.match(warnings(page)[i], pattern));

      assert.match(warnings(load({ script: dev, snippet: false })).join(), /No Consent Mode default/);
      assert.deepEqual(warnings(load({ body: mistakes(), setup: gtmFirst, snippet: false })), [], 'only in dev mode');
    });

    test('a cookie the browser drops is reported', () => {
      // As with data-cb-cookie-domain set to a public suffix: no error, no cookie.
      const page = load({ setup: (p) => Object.defineProperty(p.document, 'cookie', { get: () => '', set: () => {} }) });
      page.action('accept-all');
      assert.deepEqual(page.problems().map((l) => l.args[0]), ['[ConsentBridge] The consent cookie was not saved. Check data-cb-cookie-domain and the browser\'s cookie settings.']);
    });

    test('the cookie is host-only by default and expires with the choice', () => {
      const days = (cookie) => Number(cookie['max-age']) / 86400;
      const page = load();
      page.action('accept-all');
      const [cookie, ...more] = page.consentCookies();
      assert.equal(more.length, 0);
      assert.deepEqual([cookie.domain, cookie.host, cookie.path, cookie.samesite, cookie.secure], [undefined, 'www.example.com', '/', 'Lax', '']);
      assert.ok(Math.abs(days(cookie) - 365) < 0.001, `${days(cookie)} days`);

      // Everything denied: the cookie lasts until the banner is due again.
      const rejected = load();
      rejected.action('reject-all');
      assert.ok(Math.abs(days(rejected.consentCookies()[0]) - 182) < 0.001);

      const http = load({ protocol: 'http:' });
      http.action('accept-all');
      assert.equal(http.consentCookies()[0].secure, undefined);
    });

    test('without document.currentScript it stops with an error', () => {
      const page = createPage({ body: consentUi() }).exec(code, file, null).ready();
      assert.deepEqual(page.logs.map((l) => l.level), ['error']);
      assert.equal(page.window.dataLayer, undefined);
    });

    test('day attributes take a positive number of days, otherwise the default', () => {
      const cases = [[undefined, null, 0], ['', null, 0], ['30', 30, 0], ['0.5', 0.5, 0], [' 7 ', 7, 0], ['0', null, 1], ['-5', null, 1], ['abc', null, 1], ['Infinity', null, 1]];
      for (const [attribute, action, defaultDays] of [['data-cb-consent-max-age-days', 'accept-all', 365], ['data-cb-rejection-refresh-days', 'reject-all', 182]]) {
        for (const [value, days, warnings] of cases) {
          const page = load({ script: value === undefined ? {} : { [attribute]: value } });
          page.action(action);
          // The cookie lasts as long as the choice is valid.
          const cookieDays = Math.round(Number(page.consentCookies()[0]['max-age']) / 86.4) / 1000;
          assert.deepEqual([cookieDays, page.problems().length], [days ?? defaultDays, warnings], `${attribute}="${value}"`);
        }
      }
    });

    test('data-cb-cookie-domain shares the choice across subdomains', () => {
      const script = { 'data-cb-cookie-domain': 'example.com' };
      const www = load({ script });
      www.action('accept-all');
      assert.deepEqual(www.consentCookies().map((c) => c.domain), ['example.com']);

      const blog = load({ script, hostname: 'blog.example.com', cookies: www.cookies });
      assert.deepEqual(blog.consent().at(-1), ['consent', 'update', GRANTED]);
      assert.equal(blog.$('[data-cb-banner]').style.display, 'none');

      // Outside the domain (e.g. a staging host) the cookie stays host-only.
      const staging = load({ script, hostname: 'site.webflow.io', cookies: www.cookies });
      assert.equal(staging.$('[data-cb-banner]').style.display, 'block');
      staging.action('reject-all');
      assert.deepEqual(staging.consentCookies().map((c) => c.domain ?? c.host), ['example.com', 'site.webflow.io']);
    });

    test('with data-cb-cookie-domain, a leftover host-only cookie is removed', () => {
      const script = { 'data-cb-cookie-domain': 'example.com' };
      // Only the host-only cookie: its choice applies and moves to the shared cookie.
      const moved = load({ script, cookies: jarWith([record(GRANTED)]) });
      assert.deepEqual(moved.consent().at(-1), ['consent', 'update', GRANTED]);
      assert.deepEqual(moved.consentCookies().map((c) => c.domain), ['example.com']);

      // Both: the newer choice applies, ends up in the shared cookie, and the host-only one goes.
      for (const [hostOnly, shared] of [[record(GRANTED, 2), record(DENIED, 1)], [record(DENIED, 1), record(GRANTED, 2)]]) {
        const both = load({ script, cookies: jarWith([hostOnly], [shared, '; domain=example.com']) });
        assert.deepEqual(both.consent().at(-1), ['consent', 'update', DENIED]);
        assert.deepEqual(both.consentCookies().map((c) => c.domain), ['example.com']);
        assert.deepEqual(both.stored().state, DENIED);
      }
    });

    test('a stored choice applies only in the known format and while valid', () => {
      const applies = (value) => {
        const page = load({ cookies: jarWith([value]) });
        const applied = page.consent().length === 2;
        assert.equal(page.$('[data-cb-banner]').style.display, applied ? 'none' : 'block');
        return applied;
      };
      assert.equal(applies(record(GRANTED, 364)), true, 'within data-cb-consent-max-age-days');
      assert.equal(applies(record(DENIED, 181)), true, 'within data-cb-rejection-refresh-days');
      assert.equal(applies(record(GRANTED, 366)), false, 'expired');
      assert.equal(applies(record(DENIED, 183)), false, 'rejection due again');
      assert.equal(applies({ state: GRANTED, timestamp: Date.now() }), false, 'no schema version');
      assert.equal(applies({ ...record(GRANTED), v: 2 }), false, 'other schema version');
      assert.equal(applies('not json{'), false, 'not JSON');
    });

    test('Webflow Analyze and Optimize follow the analytics category', () => {
      // Webflow's consent API, recording the calls it gets.
      const webflow = () => {
        const calls = [];
        let choice = 'none';
        const wf = {
          ready: (callback) => callback(),
          getUserTrackingChoice: () => choice,
          allowUserTracking: () => { calls.push('allow'); choice = 'allow'; },
          denyUserTracking: () => { calls.push('deny'); choice = 'deny'; },
        };
        return { calls, wf };
      };
      const site = webflow();
      const page = load({ setup: (p) => { p.window.wf = site.wf; } });
      assert.deepEqual(site.calls, ['deny'], 'no tracking before a choice');
      page.action('open-settings');
      page.$('[data-cb-category="marketing"]').checked = true;
      page.action('save-settings');
      assert.deepEqual(site.calls, ['deny'], 'marketing alone changes nothing');
      page.action('accept-all');
      assert.deepEqual(site.calls, ['deny', 'allow']);

      // Webflow's script loading after ConsentBridge is picked up at DOM ready.
      const late = webflow();
      const next = load({ cookies: page.cookies, ready: false });
      next.window.wf = late.wf;
      next.ready();
      assert.deepEqual(late.calls, ['allow']);
    });

    test('withdrawing a granted category reloads the page after saving', () => {
      const page = load();
      page.action('open-settings');
      page.$('[data-cb-category="analytics"]').checked = true;
      page.action('save-settings');
      page.action('accept-all');
      assert.equal(page.reloads.length, 0, 'granting more never reloads');

      page.action('open-settings');
      page.$('[data-cb-category="marketing"]').checked = false;
      page.action('save-settings');
      assert.equal(page.reloads.length, 1);
      assert.match(decodeURIComponent(page.reloads[0]), /"ad_storage":"denied"/, 'saved before the reload');

      // The API reloads too, and a returning visitor's first change counts.
      const next = load({ cookies: page.cookies });
      next.window.ConsentBridge.rejectAll();
      assert.equal(next.reloads.length, 1);
      next.window.ConsentBridge.rejectAll();
      assert.equal(next.reloads.length, 1, 'nothing left to withdraw');

      const off = load({ script: { 'data-cb-reload-on-withdrawal': 'false' } });
      off.action('accept-all');
      off.action('reject-all');
      assert.equal(off.reloads.length, 0);
    });

    test('a blocked iframe loads after consent, and its placeholder hides', () => {
      // A video for marketing, a map that needs marketing and preferences.
      const embeds = () => [
        h('iframe', { 'data-cb-src': 'https://www.youtube-nocookie.com/embed/x', 'data-cb-consent-category': 'marketing' }),
        h('div', { 'data-cb-placeholder': 'marketing' }, h('button', { 'data-cb-action': 'accept-category' })),
        h('iframe', { 'data-cb-src': 'https://maps.example.com/embed', 'data-cb-consent-category': 'marketing preferences' }),
        h('div', { 'data-cb-placeholder': 'marketing preferences' }),
      ];
      const setup = (page) => embeds().forEach((el) => page.document.body.appendChild(el));
      const view = (page) => [
        ...page.document.querySelectorAll('iframe').map((el) => el.getAttribute('src')),
        ...page.document.querySelectorAll('[data-cb-placeholder]').map((el) => el.style.display ?? ''),
      ];

      const page = load({ setup });
      assert.deepEqual(view(page), [null, null, '', '']);

      // The placeholder's button grants only its own categories and saves the choice.
      page.$('[data-cb-placeholder="marketing"]').querySelector('[data-cb-action="accept-category"]').click();
      assert.deepEqual(view(page), ['https://www.youtube-nocookie.com/embed/x', null, 'none', '']);
      assert.deepEqual(page.consent().at(-1)[2], { ...DENIED, ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' });
      assert.equal(page.stored().state.ad_storage, 'granted');
      assert.deepEqual(page.activated(), ['marketing']);
      assert.equal(page.$('[data-cb-banner]').style.display, 'none');

      // A returning visitor's embeds load straight away.
      const next = load({ setup, cookies: jarWith([record(GRANTED)]) });
      assert.deepEqual(view(next), ['https://www.youtube-nocookie.com/embed/x', 'https://maps.example.com/embed', 'none', 'none']);

      // Withdrawn without a reload: the iframes go blank and the placeholders come back.
      const off = load({ setup, script: { 'data-cb-reload-on-withdrawal': 'false' } });
      off.action('accept-all');
      off.action('reject-all');
      assert.deepEqual(view(off), ['about:blank', 'about:blank', '', '']);
    });

    test('data-cb-revision asks again when it changes', () => {
      const asked = (revision, cookies) => {
        const page = load({ script: revision === undefined ? {} : { 'data-cb-revision': revision }, cookies });
        return page.$('[data-cb-banner]').style.display === 'block';
      };
      const first = load({ script: { 'data-cb-revision': ' 2024-05 ' } });
      first.action('accept-all');
      assert.equal(first.stored().revision, '2024-05');
      assert.equal(asked('2024-05', first.cookies), false);
      assert.equal(asked('2025-01', first.cookies), true);
      assert.equal(asked(undefined, first.cookies), true, 'revision removed from the page');

      // Without the attribute nothing is stored, and a site that adds one asks again.
      const plainSite = load();
      plainSite.action('accept-all');
      assert.equal('revision' in plainSite.stored(), false);
      assert.equal(asked(undefined, plainSite.cookies), false);
      assert.equal(asked('1', plainSite.cookies), true);
    });

    test('a stored record is read strictly', () => {
      const update = (...cookies) => load({ cookies: jarWith(...cookies) }).consent()[1]?.[2] ?? null;
      // Only the exact value 'granted' counts, and only for known signals.
      const loose = { analytics_storage: true, ad_storage: 'GRANTED', ad_user_data: 1, ad_personalization: 'yes', functionality_storage: 'granted', unknown_storage: 'granted' };
      assert.deepEqual(update([record(loose)]), { ...DENIED, functionality_storage: 'granted' });
      // The timestamp must be a number from the past, and the state an object.
      for (const timestamp of [String(Date.now() - DAY), Date.now() + DAY, null]) {
        assert.equal(update([{ v: 1, state: GRANTED, timestamp }]), null, String(timestamp));
      }
      assert.equal(update([{ v: 1, state: 'granted', timestamp: Date.now() }]), null);
      // Whether nothing was granted comes from the state, not from a stored flag.
      assert.equal(update([{ ...record(DENIED, 183), allDenied: false }]), null);
      // Fields this version doesn't know survive the rewrite.
      const kept = load({ cookies: jarWith([{ ...record(GRANTED), future: 'field' }]) });
      assert.equal(kept.stored().future, 'field');
    });

    test('of several consent cookies, the newest valid one wins', () => {
      const older = record(GRANTED, 2);
      const newer = record(DENIED, 1);
      for (const cookies of [
        [[older, '; domain=example.com'], [newer, '; domain=www.example.com']],
        [[newer, '; domain=www.example.com'], [older, '; domain=example.com']],
      ]) {
        assert.deepEqual(load({ cookies: jarWith(...cookies) }).consent().at(-1), ['consent', 'update', DENIED]);
      }
      // A malformed or invalid copy doesn't hide a valid one.
      for (const bad of [{ raw: '%E0%A4%A' }, 'not json{', record(GRANTED, 400)]) {
        const page = load({ cookies: jarWith([bad, '; domain=example.com'], [newer]) });
        assert.deepEqual(page.consent().at(-1), ['consent', 'update', DENIED]);
      }
    });
  });
}
