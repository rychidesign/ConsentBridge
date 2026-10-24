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
