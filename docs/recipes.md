# Recipes

Short, copy-ready setups for common tools and requirements. None of them need changes to ConsentBridge: they use Consent Mode, blocked scripts, or the [`cb:consent` event](reference.md#the-cbconsent-event).

Vendor APIs change. Each recipe links the vendor documentation it's based on; check it before you rely on the recipe.

- [Waiting for ConsentBridge](#waiting-for-consentbridge)
- [Load a tool only after consent](#load-a-tool-only-after-consent)
- [Meta Pixel](#meta-pixel)
- [Microsoft Clarity](#microsoft-clarity)
- [Microsoft Advertising (UET)](#microsoft-advertising-uet)
- [LinkedIn, TikTok and other tags](#linkedin-tiktok-and-other-tags)
- [Embeds: YouTube, Vimeo, Google Maps](#embeds-youtube-vimeo-google-maps)
- [Google Ads: ad click data without cookies](#google-ads-ad-click-data-without-cookies)
- [Different defaults by region](#different-defaults-by-region)
- [Global Privacy Control](#global-privacy-control)
- [Keeping a consent log](#keeping-a-consent-log)
- [A custom "Cookie settings" button](#a-custom-cookie-settings-button)
- [Resetting the choice while testing](#resetting-the-choice-while-testing)

## Waiting for ConsentBridge

Several recipes call your code with the visitor's choice. ConsentBridge loads `async`, so your code can't assume it's there yet. This helper calls back with the current state as soon as ConsentBridge is ready, and again after every change. Put it once in the head code, after the inline snippet:

```html
<script>
  function onConsent(callback) {
    if (window.ConsentBridge) callback(window.ConsentBridge.getState());
    document.addEventListener('cb:consent', function (event) { callback(event.detail); });
  }
</script>
```

## Load a tool only after consent

The simplest way to make any tool wait for consent: put its snippet, unchanged, in a blocked script. It runs once the category is granted, and the page reloads if consent is withdrawn.

```html
<script type="text/plain" data-cb-consent-category="analytics">
  // The tool's snippet, exactly as the vendor gives it.
</script>
```

With GTM, use a trigger on `consent_state_updated` instead. See [non-Google tags](google-tag-manager.md#non-google-tags).

From your own code, use the helper:

```html
<script>
  var chatLoaded = false;
  onConsent(function (state) {
    if (!state.categories.preferences || chatLoaded) return;
    chatLoaded = true;
    var script = document.createElement('script');
    script.src = 'https://chat.example.com/widget.js';
    script.async = true;
    document.head.appendChild(script);
  });
</script>
```

## Meta Pixel

**Recommended: don't load the pixel until marketing is granted.** Block the pixel's base code as shown [above](#load-a-tool-only-after-consent), or fire it in GTM on the marketing trigger. Nothing is sent to Meta before consent.

**Alternative: Meta's consent API.** The pixel loads on every page but sends nothing until consent is granted. Revoke consent before `init` in the pixel's base code:

```js
fbq('consent', 'revoke');
fbq('init', 'YOUR_PIXEL_ID');
fbq('track', 'PageView');
```

Then, after the base code:

```html
<script>
  onConsent(function (state) {
    fbq('consent', state.categories.marketing ? 'grant' : 'revoke');
  });
</script>
```

The pixel script itself still loads from Meta's servers before consent with this option.

Docs: [Meta Pixel: General Data Protection Regulation](https://developers.facebook.com/docs/meta-pixel/implementation/gdpr)

## Microsoft Clarity

Since 31 October 2025, Clarity requires a consent signal for visitors from the EEA, the UK and Switzerland. Clarity says it honors Google Consent Mode signals ([Clarity and Google Consent Mode](https://learn.microsoft.com/en-us/clarity/setup-and-installation/cookie-gcm)), but to be sure it gets the choice, pass it through Clarity's Consent API v2 as well. Add this after the inline snippet. It defines the same queue as Clarity's own snippet, so it works before Clarity loads:

```html
<script>
  window.clarity = window.clarity || function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
  onConsent(function (state) {
    window.clarity('consentv2', {
      ad_Storage: state.signals.ad_storage,
      analytics_Storage: state.signals.analytics_storage
    });
  });
</script>
```

Note the capital `S` in `ad_Storage` and `analytics_Storage`.

Docs: [Clarity Consent API v2](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2)

## Microsoft Advertising (UET)

UET has its own consent mode with one signal, `ad_storage`. Set the default in the inline snippet, after the `gtag('consent', 'default', …)` call:

```js
window.uetq = window.uetq || [];
window.uetq.push('consent', 'default', { ad_storage: 'denied' });
```

And update it with the visitor's choice:

```html
<script>
  onConsent(function (state) {
    window.uetq = window.uetq || [];
    window.uetq.push('consent', 'update', { ad_storage: state.signals.ad_storage });
  });
</script>
```

The UET tag picks up both from the queue when it loads.

Docs: [UET consent mode](https://learn.microsoft.com/en-us/advertising/msa-help/hlp_ba_conc_uet_consent)

## LinkedIn, TikTok and other tags

Tags without a consent API ConsentBridge can talk to shouldn't load before consent. Block them as shown in [load a tool only after consent](#load-a-tool-only-after-consent), usually with the `marketing` category, or fire them in GTM on the marketing trigger.

## Embeds: YouTube, Vimeo, Google Maps

Use `data-cb-src` instead of `src`, and lay a placeholder with a button over the iframe. Until consent, the iframe is an empty frame:

```html
<div style="position: relative; aspect-ratio: 16 / 9">
  <iframe data-cb-src="https://www.youtube-nocookie.com/embed/VIDEO_ID" data-cb-consent-category="marketing"
    style="width: 100%; height: 100%; border: 0" title="Video" allowfullscreen></iframe>
  <div data-cb-placeholder="marketing" style="position: absolute; inset: 0">
    <p>This video is provided by YouTube, which sets marketing cookies.</p>
    <button data-cb-action="accept-category">Allow and show</button>
  </div>
</div>
```

Other providers only need a different `data-cb-src`:

| Provider | `data-cb-src` |
|---|---|
| YouTube | `https://www.youtube-nocookie.com/embed/VIDEO_ID`. The nocookie domain stores less before playback, but still loads from Google. |
| Vimeo | `https://player.vimeo.com/video/VIDEO_ID` |
| Google Maps | The `src` from **Share → Embed a map**: `https://www.google.com/maps/embed?pb=…` |

Every placeholder for a category hides once it's granted, so one button grants marketing for all embeds on the page. See [blocked iframes](reference.md#blocked-iframes).

## Google Ads: ad click data without cookies

When `ad_storage` is denied, Google tags can still carry ad click information in page URLs, and you can remove ad click identifiers from what they send. Add these lines to the inline snippet, after the `gtag('consent', 'default', …)` call:

```js
gtag('set', 'url_passthrough', true);    // pass ad click information in URLs between pages
gtag('set', 'ads_data_redaction', true); // remove ad click identifiers while ad_storage is denied
```

Docs: [Set up consent mode on websites](https://developers.google.com/tag-platform/security/guides/consent)

## Different defaults by region

Consent Mode defaults can depend on the visitor's region. This sets everything to `denied` in the EEA, the UK and Switzerland, and to `granted` elsewhere. Replace the `gtag('consent', 'default', …)` call in the inline snippet with:

```js
gtag('consent', 'default', {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  functionality_storage: 'denied',
  personalization_storage: 'denied',
  security_storage: 'granted',
  wait_for_update: 500,
  region: ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT',
    'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB', 'CH']
});
gtag('consent', 'default', {
  ad_storage: 'granted',
  ad_user_data: 'granted',
  ad_personalization: 'granted',
  analytics_storage: 'granted',
  functionality_storage: 'granted',
  personalization_storage: 'granted',
  security_storage: 'granted'
});
```

The default with `region` applies there, the one without applies everywhere else. Google works out the region itself.

Only Google tags use the regional default, and only until the visitor chooses. ConsentBridge doesn't know the region: the banner shows everywhere, and blocked scripts and embeds wait for consent everywhere. Whether a region needs consent is a legal question for the site.

Docs: [Set up consent mode on websites](https://developers.google.com/tag-platform/security/guides/consent)

## Global Privacy Control

Some browsers and extensions send a [Global Privacy Control](https://globalprivacycontrol.org/) signal (Firefox, Brave and DuckDuckGo, among others). California treats it as a valid request to opt out of the sale or sharing of personal data. To treat it as "Reject all" when the visitor hasn't chosen yet:

```html
<script>
  onConsent(function (state) {
    if (!state.decided && navigator.globalPrivacyControl) window.ConsentBridge.rejectAll();
  });
</script>
```

The choice is saved like any other, the banner doesn't show, and the visitor can still opt in through the "Cookie settings" link.

## Keeping a consent log

If you need to prove consent, keep a record of each choice on your own server. ConsentBridge only stores the choice in the visitor's browser. Send each new choice with `navigator.sendBeacon()`, which still delivers when the page reloads right after a withdrawal:

```html
<script>
  document.addEventListener('cb:consent', function (event) {
    var choice = event.detail;
    if (choice.source !== 'ui' && choice.source !== 'api') return; // only choices made on this page
    navigator.sendBeacon('https://example.com/consent-log', JSON.stringify({
      categories: choice.categories,
      signals: choice.signals,
      page: location.pathname,
      time: new Date().toISOString()
    }));
  });
</script>
```

The body is sent as text, so the endpoint can be on another domain without CORS setup; parse it as JSON on the server. What to store, and for how long, depends on your legal obligations. The endpoint is yours to build; Webflow doesn't host one.

## A custom "Cookie settings" button

Any element with `data-cb-action="reopen-settings"` opens the settings modal. From your own code:

```js
window.ConsentBridge.open();
```

## Resetting the choice while testing

Run this in the browser console, then reload:

```js
document.cookie = 'consentbridge=; path=/; max-age=0';
```

With `data-cb-cookie-domain`, add the domain: `document.cookie = 'consentbridge=; path=/; max-age=0; domain=example.com';`
