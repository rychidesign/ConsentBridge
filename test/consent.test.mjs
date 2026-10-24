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

// Banner, settings modal, a footer link and one blocked script per category.
const consentUi = () => [
  h('div', { 'data-cb-banner': '' },
    h('button', { 'data-cb-action': 'accept-all' }),
    h('button', { 'data-cb-action': 'reject-all' }),
    h('button', { 'data-cb-action': 'open-settings' })),
  h('div', { 'data-cb-modal': 'settings' },
    ...CATEGORIES.map((c) => h('input', { type: 'checkbox', 'data-cb-category': c })),
    h('button', { 'data-cb-action': 'save-settings' })),
  h('a', { 'data-cb-action': 'reopen-settings' }),
  ...CATEGORIES.map((c) => h('script', { type: 'text/plain', 'data-cb-consent-category': c, src: `https://example.com/${c}.js` })),
];

// Values from the script's realm are normalized so deepEqual compares plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const isArguments = (entry) => Object.prototype.toString.call(entry) === '[object Arguments]';

// The inline snippet as sites paste it, and the code inside its <script> tag.
const SNIPPET = readFileSync('src/snippet.html', 'utf8');
const SNIPPET_CODE = /^<script>\n([\s\S]*)<\/script>\n$/.exec(SNIPPET)[1];

// Runs the inline snippet, then the script. `ready` says when DOMContentLoaded fires:
// 'after' the script (default), 'before' it, or never (false).
function open(code, file, { snippet = true, ready = 'after', ...options } = {}) {
  const page = createPage({ body: consentUi(), ...options });
  if (snippet) page.exec(SNIPPET_CODE, 'src/snippet.html', null);
  if (ready === 'before') page.ready();
  page.exec(code, file);
  if (ready === 'after') page.ready();
  const $ = (selector) => page.document.querySelector(selector);
  return Object.assign(page, {
    $,
    action: (name) => page.click(`[data-cb-action="${name}"]`),
    consent: () => plain(Array.from(page.window.dataLayer).filter(isArguments).map((args) => Array.from(args))).filter((args) => args[0] === 'consent'),
    events: (name) => plain(page.window.dataLayer.filter((entry) => !isArguments(entry) && entry.event === name)),
    activated: () => CATEGORIES.filter((c) => $(`script[data-cb-consent-category="${c}"]`).getAttribute('data-cb-activated') === 'true'),
    stored: () => JSON.parse(page.storage.get('consentbridge')),
    errors: () => page.logs.filter((l) => l.level === 'error'),
  });
}

test('the inline snippet stays under 2,000 characters', () => {
  assert.ok(SNIPPET.length < 2000, `${SNIPPET.length} characters`);
});

for (const file of ['src/consentbridge.js', 'dist/consentbridge.min.js']) {
  const code = readFileSync(file, 'utf8');
  const load = (options) => open(code, file, options);

  describe(file, () => {
    test('first visit: only the snippet default, banner shown, nothing stored or activated', () => {
      const page = load();
      assert.deepEqual(page.consent(), [['consent', 'default', { ...DENIED, wait_for_update: 500 }]]);
      assert.equal(page.$('[data-cb-banner]').style.display, 'block');
      assert.equal(page.storage.size, 0);
      assert.deepEqual(page.activated(), []);
      assert.deepEqual(page.errors(), []);
    });

    test('accept all: everything granted, saved and activated', () => {
      const page = load();
      page.action('accept-all');
      assert.deepEqual(page.consent().at(-1), ['consent', 'update', GRANTED]);
      assert.deepEqual(page.events('consent_state_updated'), [{ event: 'consent_state_updated', consent_source: 'ui', updated_consent_state: GRANTED }]);
      assert.deepEqual(page.stored().state, GRANTED);
      assert.deepEqual(page.activated(), CATEGORIES);
      assert.equal(page.$('[data-cb-banner]').style.display, 'none');

      // The activated copy runs as a normal script and loses the consent attributes.
      const original = page.$('script[data-cb-consent-category="analytics"]');
      assert.equal(original.nextSibling.type, 'text/javascript');
      assert.equal(original.nextSibling.src, 'https://example.com/analytics.js');
      assert.equal(original.nextSibling.hasAttribute('data-cb-consent-category'), false);
    });

    test('loads no tags of its own and activates marked scripts even with a GTM ID set', () => {
      const page = load({ script: { 'data-cb-gtm-id': 'GTM-TEST', 'data-cb-ga4-id': 'G-TEST' } });
      page.action('accept-all');
      assert.deepEqual(page.activated(), CATEGORIES);
      // Own script tag, the blocked originals and their activated copies, nothing else.
      assert.equal(page.document.getElementsByTagName('script').length, 1 + 2 * CATEGORIES.length);
    });

    test('reject all: nothing granted or activated, settings reopen unchecked', () => {
      const page = load();
      page.action('reject-all');
      assert.deepEqual(page.consent().at(-1), ['consent', 'update', DENIED]);
      assert.equal(page.stored().allDenied, true);
      assert.deepEqual(page.activated(), []);

      page.action('reopen-settings');
      assert.equal(page.$('[data-cb-modal="settings"]').style.display, 'flex');
      assert.deepEqual(page.document.querySelectorAll('[data-cb-category]').map((c) => c.checked), [false, false, false]);
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
      const storage = Object.fromEntries(first.storage);
      const marketing = { ...DENIED, ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' };

      for (const ready of ['after', 'before']) {
        const page = load({ storage, ready });
        assert.deepEqual(page.consent(), [['consent', 'default', { ...DENIED, wait_for_update: 500 }], ['consent', 'update', marketing]], ready);
        assert.deepEqual(page.events('consent_state_updated'), [{ event: 'consent_state_updated', consent_source: 'storage', updated_consent_state: marketing }], ready);
        assert.deepEqual(page.activated(), ['marketing'], ready);
        assert.equal(page.$('[data-cb-banner]').style.display, 'none', ready);
        assert.deepEqual(page.errors(), [], ready);
      }

      // The choice applies as soon as the script runs; only the banner waits for the DOM.
      const early = load({ storage, ready: false });
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

    test('blocked localStorage: banner shown and a choice still applies', () => {
      const page = load({ blockStorage: true });
      assert.equal(page.$('[data-cb-banner]').style.display, 'block');
      page.action('accept-all');
      assert.deepEqual(page.consent().at(-1), ['consent', 'update', GRANTED]);
      assert.deepEqual(page.activated(), CATEGORIES);
    });
  });
}
