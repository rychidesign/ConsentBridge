# Reference

Everything ConsentBridge reads from the page and everything it exposes. For a walkthrough, start with the [README](../README.md) or the [Webflow guide](webflow.md).

- [Script tag attributes](#script-tag-attributes)
- [Element attributes](#element-attributes)
- [Actions](#actions)
- [Categories and Consent Mode signals](#categories-and-consent-mode-signals)
- [JavaScript API](#javascript-api)
- [The `cb:consent` event](#the-cbconsent-event)
- [dataLayer](#datalayer)
- [Storage](#storage)
- [Sharing the choice across subdomains](#sharing-the-choice-across-subdomains)
- [Withdrawing consent](#withdrawing-consent)
- [Asking again](#asking-again)
- [Webflow Analyze and Optimize](#webflow-analyze-and-optimize)
- [Dev mode](#dev-mode)

## Script tag attributes

Set these on the `<script>` tag that loads ConsentBridge.

| Attribute | Default | What it does |
|---|---|---|
| `data-cb-consent-max-age-days` | `365` | How long a choice is kept before the banner asks again. |
| `data-cb-rejection-refresh-days` | `182` | When the visitor granted nothing, ask again after this many days instead. |
| `data-cb-revision` | none | Any text. When it changes, every visitor is asked again. See [Asking again](#asking-again). |
| `data-cb-cookie-domain` | none | A domain like `example.com`, to share the choice with its subdomains. See [Sharing the choice across subdomains](#sharing-the-choice-across-subdomains). |
| `data-cb-reload-on-withdrawal` | `true` | `false` stops the page from reloading when the visitor withdraws consent. See [Withdrawing consent](#withdrawing-consent). |
| `data-cb-dev-mode` | `false` | `true` logs each step to the console and warns about setup mistakes. See [Dev mode](#dev-mode). |

Day attributes take a positive number; decimals work (`0.5` is twelve hours). A missing or empty attribute means the default. Anything else logs a warning and uses the default too.

```html
<script async src="https://cdn.jsdelivr.net/npm/consentbridge@1/dist/consentbridge.min.js"
  data-cb-revision="2026-03" data-cb-cookie-domain="example.com"></script>
```

## Element attributes

Elements can be anywhere on the page, including inside components. Action buttons, the modal and its checkboxes can also be added later. The banner, blocked scripts, iframes and placeholders must be in the page when it finishes loading (`DOMContentLoaded`).

| Attribute | On | What it does |
|---|---|---|
| `data-cb-banner` | The banner | Shown until the visitor makes a choice, hidden after. The value doesn't matter. |
| `data-cb-modal="settings"` | The settings modal | Opened by `open-settings` and `reopen-settings`, closed by `save-settings`, `close-modal` and Escape. |
| `data-cb-display` | The banner or modal | The CSS `display` value used to show it. Defaults: `block` for the banner, `flex` for the modal. |
| `data-cb-category` | A checkbox in the modal | `analytics`, `marketing` or `preferences`. Checked when the modal opens if the category is granted. |
| `data-cb-action` | Any clickable element | What a click does. See [Actions](#actions). |
| `data-cb-consent-category` | A `<script type="text/plain">` or an iframe with `data-cb-src` | The categories it needs, separated by spaces. All of them must be granted. |
| `data-cb-src` | An iframe | Used as `src` once the iframe's categories are granted. |
| `data-cb-placeholder` | Any element | Categories, separated by spaces. Visible until they're all granted, hidden after. |

Hide the banner and the modal in your CSS (`display: none`). ConsentBridge shows them when needed, so a returning visitor never sees the banner flash. Leave placeholders visible.

### The banner and the modal

A native `<dialog>` opens and closes through its own API: the modal with `showModal()`, the banner with `show()`. `data-cb-display` doesn't apply to it. The browser handles focus, Escape and the backdrop.

Any other element is shown by setting `style.display`. For the modal, ConsentBridge also:

- adds `role="dialog"` and `aria-modal="true"` unless the element has its own,
- moves focus to the first `input`, `select`, `textarea`, `button`, `a[href]` or `[tabindex]` element inside it that isn't disabled,
- closes it on Escape,
- returns focus to the element that opened it, if that's still visible. After a choice, the banner is hidden, so focus goes back to the page.

It doesn't trap focus inside the modal. If you need that, use a `<dialog>`. Either way, give the modal an accessible name with `aria-labelledby` pointing at its heading, or `aria-label`.

When the modal opens, each checkbox shows the current choice. A Webflow custom checkbox (`.w-checkbox-input` next to the input) gets its `w--redirected-checked` class updated too.

### Blocked scripts

```html
<script type="text/plain" data-cb-consent-category="analytics" src="https://example.com/analytics.js"></script>
```

Once every listed category is granted, ConsentBridge inserts a copy of the script right after it, with the same attributes except `type` and `data-cb-consent-category`. The original stays in the page with `data-cb-activated="true"`. Inline scripts work the same way.

External scripts run in page order. A copy is `async` only if the original has the `async` attribute. Inline code runs as soon as it's inserted, without waiting for external scripts before it to load. Don't make blocked inline code depend on a blocked external script; most vendor snippets load their own script and are fine.

Each script runs at most once per page load. If consent is withdrawn, the page reloads, which stops it, unless [reloading is off](#withdrawing-consent).

### Blocked iframes

```html
<div style="position: relative; aspect-ratio: 16 / 9">
  <iframe data-cb-src="https://player.vimeo.com/video/VIDEO_ID" data-cb-consent-category="marketing"
    style="width: 100%; height: 100%; border: 0" title="Video" allow="fullscreen"></iframe>
  <div data-cb-placeholder="marketing" style="position: absolute; inset: 0">
    <p>This video is hosted by Vimeo.</p>
    <button data-cb-action="accept-category">Allow marketing cookies</button>
  </div>
</div>
```

The iframe gets its `src` once all its categories are granted. Until then it's an empty frame, so the placeholder in the example covers it. If consent is withdrawn and the page doesn't reload, the `src` goes back to `about:blank` and the placeholder shows again.

The placeholder and the iframe are linked only by their categories, not by position. Every placeholder for `marketing` hides when marketing is granted.

## Actions

Put `data-cb-action` on a button or link. ConsentBridge handles the click and prevents the default action, so `href="#"` doesn't jump to the top of the page.

| Value | What it does |
|---|---|
| `accept-all` | Grants every category, saves the choice, and hides the banner and the modal. |
| `reject-all` | Denies every category, saves the choice, and hides the banner and the modal. |
| `open-settings` | Opens the settings modal. Use it on the banner. |
| `reopen-settings` | Opens the settings modal. Use it for the "Cookie settings" link that's on every page. |
| `save-settings` | Grants the checked categories, denies the rest, saves, and closes the modal and the banner. |
| `close-modal` | Closes the modal without saving. |
| `accept-category` | Inside a `data-cb-placeholder`: grants that placeholder's categories, keeps the other categories as they were, saves, and hides the banner and the modal. |

## Categories and Consent Mode signals

| Category | Signals |
|---|---|
| `analytics` | `analytics_storage` |
| `marketing` | `ad_storage`, `ad_user_data`, `ad_personalization` |
| `preferences` | `functionality_storage` |

A category is granted when all of its signals are `granted`. The inline snippet sets every signal to `denied` by default. ConsentBridge sends an update with all of them whenever a stored or new choice applies.

There are three categories, with fixed names. Strictly necessary cookies don't need consent and have no category. If you show them in the modal, use a checkbox without `data-cb-category`, checked and disabled.

## JavaScript API

`window.ConsentBridge` exists once the script has run.

| Method | Returns |
|---|---|
| `getState()` | The current state, see below. |
| `hasConsent(category)` | `true` if the category is granted. `false` for an unknown category. |
| `open()` | Opens the settings modal, like `reopen-settings`. |
| `acceptAll()` | Like `accept-all`. |
| `rejectAll()` | Like `reject-all`. |

`getState()` returns:

```js
{
  decided: true,              // false until the visitor makes a choice
  categories: { analytics: true, marketing: false, preferences: false },
  signals: {
    analytics_storage: 'granted',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    functionality_storage: 'denied'
  }
}
```

Before the visitor decides, every category is `false` and every signal `denied`.

### Waiting for ConsentBridge

The script loads `async`, so your code may run before or after it. This helper calls back once with the current state, whenever ConsentBridge is ready, and again after every choice:

```html
<script>
  function onConsent(callback) {
    if (window.ConsentBridge) callback(window.ConsentBridge.getState());
    document.addEventListener('cb:consent', function (event) { callback(event.detail); });
  }

  onConsent(function (state) {
    if (state.categories.analytics) {
      // Start your analytics.
    }
  });
</script>
```

The first call gets `getState()` or the first event's `detail`, depending on which came first, so don't rely on `source` and `changed` in it.

## The `cb:consent` event

Fires on `document`:

- once when the script runs, with the stored choice or the default state,
- after every choice, from the banner, the modal, a placeholder or the API.

`event.detail` is the same object as `getState()`, plus:

| Field | Value |
|---|---|
| `source` | `'default'` (nothing stored), `'storage'` (a stored choice), `'ui'` (a click) or `'api'` (a method call) |
| `changed` | The categories whose state just changed, e.g. `['analytics']`. Empty when nothing changed. |

```js
document.addEventListener('cb:consent', function (event) {
  if (event.detail.changed.includes('marketing') && event.detail.categories.marketing) {
    // Marketing was granted just now.
  }
});
```

## dataLayer

When a stored or new choice applies, ConsentBridge pushes two things to `window.dataLayer`:

1. A Consent Mode update with every signal:

   ```js
   gtag('consent', 'update', { analytics_storage: 'granted', ad_storage: 'denied', /* … */ });
   ```

2. An event for GTM triggers:

   ```js
   {
     event: 'consent_state_updated',
     consent_source: 'storage',            // or 'ui', 'api'
     updated_consent_state: { analytics_storage: 'granted', ad_storage: 'denied', /* … */ }
   }
   ```

Nothing is pushed on a first visit until the visitor chooses; the snippet's defaults apply. If `window.gtag` doesn't exist, ConsentBridge defines the standard one.

## Storage

The choice is stored in one first-party cookie named `consentbridge`:

- `path=/`, `SameSite=Lax`, and `Secure` on HTTPS.
- Host-only by default. With `data-cb-cookie-domain`, set for that domain.
- It expires when the choice does: `data-cb-consent-max-age-days` after the choice, or, if nothing was granted, the shorter of that and `data-cb-rejection-refresh-days`. Browsers cap cookies at 400 days.
- ConsentBridge rewrites it on every page load, because Safari keeps cookies set by scripts for 7 days. A Safari visitor who doesn't come back within 7 days is asked again.

The value is URL-encoded JSON with a format version, the signals, the time of the choice and the revision. Read the choice through the API rather than the cookie.

A cookie that's malformed, from an unknown format, from another revision, or expired is ignored, and the banner shows. If the browser blocks cookies, the banner shows on every page and each choice applies to the current page only.

List `consentbridge` in your cookie policy as a necessary cookie that stores the visitor's consent choice.

## Sharing the choice across subdomains

By default, `www.example.com` and `shop.example.com` each ask separately. `data-cb-cookie-domain="example.com"` stores the choice for `example.com` and all its subdomains, so a visitor chooses once.

- Use it only if you control every host under that domain. Any of them can read and change the choice.
- The value is a domain you registered, like `example.com`, not a public suffix like `webflow.io` or `co.uk`. Browsers ignore cookies for public suffixes; ConsentBridge warns in the console when that happens.
- On a host outside the domain, like a staging site on `webflow.io`, the cookie stays host-only.
- Use the same `data-cb-cookie-domain`, `data-cb-revision` and day attributes on every host.
- It shares the consent choice, not analytics cookies. GA4 sets its own cookies for the whole domain by default.

If you add `data-cb-cookie-domain` to a site that already has host-only cookies, ConsentBridge moves the choice over and removes the old cookie.

## Withdrawing consent

When a visitor withdraws a category they had granted, through the modal, "Reject all" or the API, ConsentBridge saves the choice and reloads the page. Scripts that already ran, and tags GTM already fired, stop with the reload. Granting more never reloads.

With `data-cb-reload-on-withdrawal="false"`, the page doesn't reload. Consent Mode signals still update and blocked iframes go back to `about:blank`, but scripts that already ran keep running until the next page load.

## Asking again

The banner shows again when:

- the choice is older than `data-cb-consent-max-age-days` (default 365),
- nothing was granted and the choice is older than `data-cb-rejection-refresh-days` (default 182),
- in Safari, the visitor hasn't been on the site for 7 days (see [Storage](#storage)),
- `data-cb-revision` changed since the choice. Change it when the privacy policy changes or you add a tracker that needs consent.

## Webflow Analyze and Optimize

If the site uses Webflow Analyze or Optimize, ConsentBridge passes the `analytics` choice to Webflow's consent API: `wf.allowUserTracking()` when analytics is granted, `wf.denyUserTracking()` otherwise, including before the visitor decides. Nothing to set up.

## Dev mode

With `data-cb-dev-mode="true"`, ConsentBridge logs each step to the console and warns when:

- the banner has no `reject-all` button,
- a category checkbox is checked in the markup,
- nothing on the page has `data-cb-action="reopen-settings"`,
- `data-cb-category`, `data-cb-consent-category` or `data-cb-placeholder` names an unknown category,
- the dataLayer has no Consent Mode default, or GTM or gtag.js ran before the inline snippet,
- the same GTM container is on the page twice.

Some warnings show without dev mode too, because they mean the setup doesn't work: an unreadable stored choice, blocked cookies, or a cookie the browser didn't save.

Remove `data-cb-dev-mode` before going live.
