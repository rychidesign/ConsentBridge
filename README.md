# ConsentBridge

Cookie consent for Webflow, with Google Consent Mode v2 built in. You design the banner in the Webflow Designer, mark its elements with `data-cb-*` attributes, and add one script. ConsentBridge stores the visitor's choice, tells Google tags and GTM about it, and keeps other scripts and embeds blocked until the visitor agrees.

- **Consent Mode v2.** Sets the Consent Mode defaults and updates them on every choice, so GA4, Google Ads and GTM work without extra setup.
- **Your design.** No injected styles or markup. Any element can be the banner, the settings modal or a checkbox, including a native `<dialog>`.
- **Blocks what GTM doesn't run.** Pasted scripts (`type="text/plain"`) and iframes like YouTube, Vimeo or maps (`data-cb-src`) wait for consent. Embeds can show a placeholder until then.
- **Small and dependency-free.** About 12 KB minified, 4 KB gzipped. One cookie of its own, no network requests, no backend.
- **For developers.** A `window.ConsentBridge` API and a `cb:consent` event for anything else you want to connect.

> ConsentBridge hasn't had its first release yet. The `@1` URLs below work from version 1.0.0.

## Quick start

Paste this into **Site settings → Custom code → Head code** in Webflow (or the `<head>` of any site), in this order:

1. **The inline snippet, first.** It sets the Consent Mode signals to `denied` before any Google tag loads.

   ```html
   <script>
     // ConsentBridge: Consent Mode defaults. Keep this first in <head>, before GTM.
     window.dataLayer = window.dataLayer || [];
     function gtag() { dataLayer.push(arguments); }
     gtag('consent', 'default', {
       ad_storage: 'denied',
       ad_user_data: 'denied',
       ad_personalization: 'denied',
       analytics_storage: 'denied',
       functionality_storage: 'denied',
       wait_for_update: 500
     });
   </script>
   ```

2. **Google Tag Manager**, with the standard snippet from GTM (if you use it).

3. **ConsentBridge.**

   ```html
   <script async src="https://cdn.jsdelivr.net/npm/consentbridge@1/dist/consentbridge.min.js"></script>
   ```

Then build the banner in the Designer and give its elements these attributes. In Webflow, add them under **Element settings → Custom attributes**.

| Element | Attribute |
|---|---|
| The banner (set to Display: None) | `data-cb-banner` |
| "Accept all" button | `data-cb-action` = `accept-all` |
| "Reject all" button | `data-cb-action` = `reject-all` |
| "Settings" button | `data-cb-action` = `open-settings` |
| The settings modal (set to Display: None) | `data-cb-modal` = `settings` |
| A checkbox per category | `data-cb-category` = `analytics`, `marketing` or `preferences` |
| "Save" button in the modal | `data-cb-action` = `save-settings` |
| "Close" button in the modal | `data-cb-action` = `close-modal` |
| "Cookie settings" link in the footer | `data-cb-action` = `reopen-settings` |

The banner shows on the first visit and stays hidden once the visitor has chosen. To check the setup, add `data-cb-dev-mode="true"` to the script tag. The console then logs every step and warns about common mistakes. Remove it before going live.

The [Webflow guide](docs/webflow.md) walks through the whole setup step by step.

### Other ways to load it

**An exact version with Subresource Integrity.** The site gets new versions only when you change the URL. The browser refuses the file if it doesn't match the hash.

```html
<script async src="https://cdn.jsdelivr.net/npm/consentbridge@1.0.0/dist/consentbridge.min.js"
  integrity="sha384-…" crossorigin="anonymous"></script>
```

Compute the hash from the published file:

```sh
curl -s https://cdn.jsdelivr.net/npm/consentbridge@1.0.0/dist/consentbridge.min.js | openssl dgst -sha384 -binary | openssl base64 -A
```

**Inline.** Paste the contents of `dist/consentbridge.min.js` into a `<script>` tag, with your `data-cb-*` attributes on that tag. Nothing loads from a CDN. You update it by hand.

`@1` follows every 1.x release: fixes and new features, never breaking changes. Don't use `@latest` or URLs without a version.

## Categories and Consent Mode

| Category | Consent Mode signals | Typical use |
|---|---|---|
| `analytics` | `analytics_storage` | GA4, Hotjar, Clarity |
| `marketing` | `ad_storage`, `ad_user_data`, `ad_personalization` | Google Ads, Meta Pixel, YouTube embeds |
| `preferences` | `functionality_storage` | Chat widgets, saved settings |

Google tags read these signals on their own. In GTM, other tags can require them in their consent settings or fire on the `consent_state_updated` event. See the [GTM guide](docs/google-tag-manager.md).

## Scripts outside GTM

Running tags through GTM is the recommended way. A script you paste into the page directly is blocked until consent if you change its type and name its category:

```html
<script type="text/plain" data-cb-consent-category="analytics" src="https://example.com/analytics.js"></script>
<script type="text/plain" data-cb-consent-category="marketing">
  // Inline code runs once marketing is granted.
</script>
```

A script runs once every category it lists is granted. A list like `data-cb-consent-category="analytics marketing"` needs both. External scripts run in page order; see the [reference](docs/reference.md#blocked-scripts) for inline code.

## Embeds

Use `data-cb-src` instead of `src`, and lay a placeholder over the iframe. The placeholder is visible until consent; a button in it can grant just its category.

```html
<div style="position: relative; aspect-ratio: 16 / 9">
  <iframe data-cb-src="https://www.youtube-nocookie.com/embed/VIDEO_ID" data-cb-consent-category="marketing"
    style="width: 100%; height: 100%; border: 0" title="Video" allowfullscreen></iframe>
  <div data-cb-placeholder="marketing" style="position: absolute; inset: 0">
    <p>This video is hosted by YouTube, which sets marketing cookies.</p>
    <button data-cb-action="accept-category">Allow marketing cookies and load the video</button>
  </div>
</div>
```

## Documentation

- [Webflow guide](docs/webflow.md): building the banner, the settings modal, the footer link and embeds in the Designer.
- [Google Tag Manager and Consent Mode](docs/google-tag-manager.md): advanced and basic Consent Mode, non-Google tags in GTM, checking the setup.
- [Reference](docs/reference.md): every attribute, the JavaScript API, events and storage.

## What ConsentBridge isn't

- **Not an IAB TCF CMP.** Google requires a Google-certified CMP that uses the IAB Transparency and Consent Framework to serve personalized ads through AdSense, Ad Manager or AdMob in the EEA, the UK and Switzerland ([Google's requirements](https://support.google.com/admanager/answer/13554116)). That requirement is for publishers showing ads. GA4, Google Ads and GTM get the visitor's choice through Consent Mode.
- **No consent log, geo-targeting, cookie scanner or automatic tracker blocking.** It blocks what you mark, nothing else.
- **No backend.** The choice lives in one first-party cookie in the visitor's browser.

## Checklist for site owners

ConsentBridge handles the mechanics. Whether the consent is valid depends on how the site uses it:

- A "Reject all" button on the banner itself, as easy to find and use as "Accept all".
- No category checked in advance. Pre-ticked boxes aren't valid consent.
- The banner says what each category is for and who receives the data. The privacy policy lists the cookies, including `consentbridge`.
- A link to the cookie settings on every page, usually in the footer.
- The inline snippet first in `<head>`, before GTM and any other tag.
- Every tag that needs consent runs through GTM with consent checks, or is blocked with `type="text/plain"`.

If the script fails to load (a strict Content Security Policy, an ad blocker), no banner shows and every signal stays `denied`.

## Browser support

ConsentBridge runs in browsers with ES2018 support, which covers all current browsers. It doesn't run in Internet Explorer.

## License

[MIT](LICENSE)
