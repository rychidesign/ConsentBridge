# Webflow guide

This guide sets up ConsentBridge on a Webflow site, from the custom code to a working banner, settings modal and blocked embeds. You build every element in the Designer, styled however you like, and connect it with custom attributes.

To add a custom attribute, select the element, open **Element settings** (the gear icon), and click **+** under **Custom attributes**. For attributes like `data-cb-banner` the value doesn't matter; if Webflow asks for one, enter `true`.

## 1. Add the code

In **Site settings → Custom code → Head code**, paste the following, in this order:

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

<!-- Your Google Tag Manager snippet goes here, if you use GTM. -->

<script async src="https://cdn.jsdelivr.net/npm/consentbridge@1/dist/consentbridge.min.js"
  data-cb-dev-mode="true"></script>
```

Leave out the `<noscript>` part of the GTM snippet. It only runs without JavaScript, when nothing can ask for consent.

`data-cb-dev-mode="true"` is for setting up; remove it before you go live.

Keep other trackers out of Webflow's custom code fields. Run them through GTM, or block them as shown in [step 6](#6-scripts-that-arent-in-gtm). Don't use Webflow's built-in Google Analytics integration in the site settings: you can't control where it loads, and it has to come after the snippet. Add GA4 through GTM instead.

Custom code runs on the published site, not in the Designer. Publish to the staging domain (`your-site.webflow.io`) to test.

## 2. Build the banner

1. Add a **Div Block** for the banner, usually fixed to the bottom of the page. Put it in a component (Symbol) so it's on every page.
2. Add the text: what each category is for and who receives the data, with a link to the privacy policy.
3. Add three **Buttons**: "Accept all", "Reject all" and "Settings". Make "Reject all" as easy to see and use as "Accept all".
4. Add the custom attributes:

   | Element | Name | Value |
   |---|---|---|
   | The banner | `data-cb-banner` | `true` |
   | "Accept all" | `data-cb-action` | `accept-all` |
   | "Reject all" | `data-cb-action` | `reject-all` |
   | "Settings" | `data-cb-action` | `open-settings` |

5. Set the banner to **Display: None**. ConsentBridge shows it when needed, with `display: block`. If the banner is a flex or grid layout, add `data-cb-display` with the value `flex` or `grid`.

## 3. Build the settings modal

1. Add a **Div Block** for the overlay (fixed, full screen) with the modal box inside. Put it in the same component as the banner.
2. Add a **Form Block** inside the box. Webflow only allows checkboxes inside a form. Delete the form's **Submit button**; you don't need it.
3. Add a **Checkbox** for each category you use, with a label and a short description:

   | Checkbox | Name | Value |
   |---|---|---|
   | Analytics | `data-cb-category` | `analytics` |
   | Marketing | `data-cb-category` | `marketing` |
   | Preferences | `data-cb-category` | `preferences` |

   Leave them unchecked in the Designer. ConsentBridge checks them to match the visitor's choice when the modal opens. Webflow's custom-styled checkboxes work too.

   To show strictly necessary cookies, add a checkbox without `data-cb-category`, checked and disabled.
4. Add two **Buttons**:

   | Button | Name | Value |
   |---|---|---|
   | "Save" | `data-cb-action` | `save-settings` |
   | "Close" | `data-cb-action` | `close-modal` |

   Use Buttons, not the form's Submit button, so nothing is sent to Webflow's form submissions.
5. On the overlay, add:

   | Name | Value |
   |---|---|
   | `data-cb-modal` | `settings` |
   | `data-cb-display` | `flex` (or how the overlay should display) |
   | `aria-labelledby` | the ID of the modal's heading |

   Give the heading that ID in its element settings.
6. Set the overlay to **Display: None**.

When the modal opens, focus moves into it, Escape closes it, and focus returns to the button that opened it.

## 4. Add the "Cookie settings" link

Visitors must be able to change their choice later. In the footer component, add a **Link** with the text "Cookie settings" and:

| Name | Value |
|---|---|
| `data-cb-action` | `reopen-settings` |

Set its link to `#`. ConsentBridge prevents the jump.

## 5. Block embeds

Webflow's **YouTube**, **Video** and **Map** elements load the provider's content right away, before consent. Use an **Embed** element instead, with `data-cb-src` in place of `src`:

```html
<iframe data-cb-src="https://www.youtube-nocookie.com/embed/VIDEO_ID" data-cb-consent-category="marketing"
  width="100%" height="100%" title="Video title" frameborder="0" allowfullscreen></iframe>
```

Next to the Embed, build a placeholder in the Designer, for example a box with a thumbnail, a short text and a button:

| Element | Name | Value |
|---|---|---|
| The placeholder | `data-cb-placeholder` | `marketing` |
| The button inside it | `data-cb-action` | `accept-category` |

Leave the placeholder visible. It hides once marketing is granted, and the iframe loads. The button grants only marketing and keeps the visitor's other choices.

To show the placeholder in the iframe's place, put both in a wrapper with `position: relative` and give the placeholder `position: absolute` and full size.

The same works for maps (`https://www.google.com/maps/embed?pb=…`), Vimeo, Spotify, Calendly and other iframes. Choose the category by what the provider does with the data. Video and social embeds are usually `marketing`.

## 6. Scripts that aren't in GTM

A script that has to be in the page, for example in an Embed or the page's custom code, is blocked by changing its `type` and naming its category:

```html
<script type="text/plain" data-cb-consent-category="analytics">
  // Runs once analytics is granted.
</script>
```

Webflow's custom code fields accept this as is. See the [reference](reference.md#blocked-scripts) for the details.

## 7. Test

1. Publish to the staging domain and open it in a private window.
2. Open the browser console. With dev mode on, ConsentBridge logs each step and warns about missing or misconfigured elements. Fix every warning.
3. Check the flow:
   - The banner shows. Nothing marked for consent has loaded.
   - "Reject all" hides the banner. Reload: it stays hidden.
   - "Cookie settings" in the footer opens the modal with nothing checked.
   - Check analytics, save, reload: analytics scripts run and the checkbox stays checked.
   - Uncheck it and save: the page reloads.
4. With GTM, check the signals in GTM's preview mode. See the [GTM guide](google-tag-manager.md#check-the-setup).
5. Remove `data-cb-dev-mode` and publish.

To start over as a new visitor, delete the `consentbridge` cookie in the browser's developer tools, or use a new private window.

## Notes

- **Staging and custom domains** keep separate choices. If the site has several subdomains, see [sharing the choice across subdomains](reference.md#sharing-the-choice-across-subdomains). Never set `data-cb-cookie-domain` to `webflow.io`.
- **Localization:** translate the banner and modal text with Webflow Localization like any other content. The choice applies to every locale.
- **Webflow Analyze and Optimize** follow the analytics choice automatically.
- **Changes to what you track:** when you add a tracker or change the privacy policy, set `data-cb-revision` on the script tag to a new value, for example the date. Everyone is asked again.
