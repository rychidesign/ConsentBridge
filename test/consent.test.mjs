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

function open(code, file, options = {}) {
  const page = createPage({ body: consentUi(), ...options }).run(code, file);
  const $ = (selector) => page.document.querySelector(selector);
  return Object.assign(page, {
    $,
    action: (name) => page.click(`[data-cb-action="${name}"]`),
    consent: () => page.window.dataLayer.filter(isArguments).map((args) => plain(Array.from(args))).filter((args) => args[0] === 'consent'),
    events: (name) => plain(page.window.dataLayer.filter((entry) => !isArguments(entry) && entry.event === name)),
    activated: () => CATEGORIES.filter((c) => $(`script[data-cb-consent-category="${c}"]`).getAttribute('data-cb-activated') === 'true'),
    stored: () => JSON.parse(page.storage.get('consentbridge')),
    errors: () => page.logs.filter((l) => l.level === 'error'),
  });
}

const signalsOf = ({ wait_for_update, ...signals }) => signals;

for (const file of ['src/consentbridge.js', 'dist/consentbridge.min.js']) {
  const code = readFileSync(file, 'utf8');
  const load = (options) => open(code, file, options);

  describe(file, () => {
    test('first visit: everything denied, banner shown, nothing stored or activated', () => {
      const page = load();
      const calls = page.consent();
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].slice(0, 2), ['consent', 'default']);
      assert.deepEqual(signalsOf(calls[0][2]), DENIED);
      assert.equal(page.$('[data-cb-banner]').style.display, 'block');
      assert.equal(page.storage.size, 0);
      assert.deepEqual(page.activated(), []);
      assert.deepEqual(page.errors(), []);
    });

    test('accept all: everything granted, saved and activated', () => {
      const page = load();
      page.action('accept-all');
      assert.deepEqual(page.consent().at(-1), ['consent', 'update', GRANTED]);
      assert.deepEqual(page.events('consent_state_updated').map((e) => e.updated_consent_state), [GRANTED]);
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

      const page = load({ storage: Object.fromEntries(first.storage) });
      assert.deepEqual(page.consent().at(-1), ['consent', 'update', { ...DENIED, ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' }]);
      assert.deepEqual(page.activated(), ['marketing']);
      assert.equal(page.$('[data-cb-banner]').style.display, 'none');
      assert.deepEqual(page.errors(), []);
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
