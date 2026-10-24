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
      assert.deepEqual(page.stored().state, DENIED);
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
