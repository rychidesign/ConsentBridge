# Google Tag Manager and Consent Mode

ConsentBridge doesn't load any tags. GTM does, and ConsentBridge tells GTM and every Google tag what the visitor chose, through Consent Mode. This guide covers the setup in GTM.

## How it fits together

1. **The inline snippet** runs first and sets the Consent Mode signals to `denied`.
2. **GTM** loads. Google tags see the defaults and respect them.
3. **ConsentBridge** loads. For a returning visitor, it applies the stored choice right away. Otherwise it shows the banner and applies the choice when the visitor makes it.

Each time a choice applies, GTM gets a Consent Mode `update` and a `consent_state_updated` event. See the [reference](reference.md#datalayer) for the exact data.

The snippet's `wait_for_update: 500` makes Google tags wait up to 500 ms for ConsentBridge to load and apply a stored choice before they send anything.

Don't set Consent Mode defaults in GTM as well, for example with a consent template on the Consent Initialization trigger. The snippet already sets them, and two sets of defaults conflict.

## Advanced or basic Consent Mode

Google describes two ways to use Consent Mode:

- **Advanced:** Google tags load on every page. Before consent they set no cookies and send cookieless pings, which Google uses for modeling. This is what you get by default: fire your Google tag on **Initialization – All Pages** as usual.
- **Basic:** Google tags don't load at all until consent. You get no data from visitors who don't consent, and no modeling.

Which one you need is a legal decision for the site, not a technical one. To run basic Consent Mode, change each Google tag:

1. In **Advanced Settings → Consent Settings**, choose **Require additional consent for tag to fire** and add `analytics_storage` (for GA4) or `ad_storage` (for Google Ads).
2. Under **Triggering**, use a Custom Event trigger with the event name `consent_state_updated`.
3. In **Advanced Settings → Tag firing options**, choose **Once per page**.

The event fires when a stored choice applies and when the visitor makes a choice. The consent check lets the tag through only if the signal is `granted`.

## What GA4 and Google Ads measure

With advanced Consent Mode, this is what Google gets for each kind of visitor.

**Visitors who accept** are measured in full. If they accept on the page they landed on, Google tags keep measuring on that page without a reload: the client ID of the first hit becomes the `_ga` cookie and the session continues, so they count as one new user. If they view other pages first, those pages aren't linked to them, unless [`url_passthrough`](recipes.md#google-ads-ad-click-data-without-cookies) carries the IDs between pages.

**Returning visitors** are recognized by their `_ga` cookie. ConsentBridge applies the stored choice as soon as it runs, and the snippet's `wait_for_update: 500` makes Google tags wait up to 500 ms for it, so the first hit already has consent. If ConsentBridge loads later, for example on a slow mobile connection, the first hit goes out with the defaults and a temporary ID, and GA4 may count an extra new user or session. You can raise `wait_for_update` in the snippet, for example to `1000`. The cost: for visitors who haven't chosen yet, Google tags wait the full time before their first hit.

**Visitors who reject or don't choose** get no Google cookies. Google tags send cookieless pings with a new random ID on every page load, so GA4 can't count them as users or tell new from returning. They appear in reports only through [behavioral modeling](https://support.google.com/analytics/answer/11161109), which needs the **Blended** reporting identity (**Admin → Data display → Reporting identity**) and enough traffic: at least 1,000 events a day with `analytics_storage` denied for 7 days, and at least 1,000 daily users with it granted on 7 of the last 28 days. Below that, reports show only the visitors who accepted. Google Ads [models conversions](https://support.google.com/google-ads/answer/10548233) separately, with its own thresholds.

**Safari** keeps cookies set by scripts for 7 days. A Safari visitor who comes back after more than a week counts as a new user and sees the banner again. No consent tool can change that.

**Events and conversions** are sent in every state, each with the consent state at the time. Without consent, they arrive as cookieless pings, which GA4 reports only once behavioral modeling is active.

**Enhanced conversions and user-provided data** (a hashed email address or phone number) are sent only when `ad_user_data` is granted, so only for visitors who accept `marketing`. They need their own setup: turn on enhanced conversions for the conversion action in Google Ads, and user-provided data collection in GA4 under **Admin → Data collection and modification → Data collection**. Then provide the data on the page, with `gtag('set', 'user_data', …)` or GTM's user-provided data variable.

**Remarketing:** visitors join audiences used for ads only if they granted `ad_personalization`, which is part of `marketing`.

To see whether the ads signals arrive, open **Admin → Data collection and modification → Consent settings** in GA4. For each data stream with visitors from the EEA, it shows whether GA4 receives `ad_user_data` and `ad_personalization`.

## Non-Google tags

Meta Pixel, LinkedIn, TikTok, Hotjar and most other tags don't read Consent Mode, so GTM has to hold them back until consent. Set this up once:

1. **Variables → New → Data Layer Variable**, with the name `updated_consent_state.ad_storage`. Save it as `CB ad_storage`. Create `CB analytics_storage` and `CB functionality_storage` the same way if you need them.
2. **Triggers → New → Custom Event**:
   - Event name: `consent_state_updated`
   - This trigger fires on: **Some Custom Events**, `CB ad_storage` equals `granted`
   - Save it as `CB marketing granted`.

Then, on each marketing tag:

- Fire it on `CB marketing granted`.
- In **Consent Settings**, require `ad_storage`.
- In **Tag firing options**, choose **Once per page**.

Do the same for analytics tags with `analytics_storage`, and for preference tags with `functionality_storage`.

| Category | Signal to check |
|---|---|
| `analytics` | `analytics_storage` |
| `marketing` | `ad_storage` |
| `preferences` | `functionality_storage` |

When a visitor withdraws consent, ConsentBridge reloads the page, so tags that already fired stop. On the new page, the trigger doesn't fire. If you turn reloading off with `data-cb-reload-on-withdrawal="false"`, tags that already fired keep running until the next page load.

### Other GTM triggers

Tags that need consent but fire on other triggers (a click, a form submission, a scroll depth) only need the consent check: in **Consent Settings**, require the signal. GTM skips the tag if the signal is `denied` when the trigger fires.

## Check the setup

1. Turn on **Enable consent overview** in **Admin → Container Settings**. The tags list then shows the consent settings of every tag.
2. Open **Preview** and load the site in the window it opens.
3. Select the first event in the summary and open the **Consent** tab. **On-page Default** should show `security_storage` as `granted` and every other signal as `denied`.
4. Accept or reject on the banner. On the `consent_state_updated` event, **On-page Update** shows the choice.
5. Check that tags that need consent didn't fire before the choice, and fired after it if it was granted.

If the defaults are missing or come after the first tag, the snippet isn't first in `<head>`. ConsentBridge's [dev mode](reference.md#dev-mode) warns about that, and about a GTM container that's on the page twice.

## GA4 without GTM

If you load GA4 with gtag.js directly, put its snippet after the inline snippet and before ConsentBridge. It respects Consent Mode the same way. The [README](../README.md#quick-start) shows the order.
