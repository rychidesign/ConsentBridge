// ConsentBridge: cookie consent for Webflow with Google Consent Mode v2.
// Configuration is read from data-cb-* attributes on this script tag. The Consent Mode
// defaults come from the inline snippet (src/snippet.html), which sites put first in <head>.
//
// The choice is stored in one first-party cookie, consentbridge, host-only by default.
// Optional data-cb-cookie-domain="example.com" sets it for that domain and all its subdomains,
//   so www.example.com and blog.example.com read the same choice. On hosts outside that
//   domain (staging, preview) the cookie stays host-only.
//
// Day attributes (data-cb-*-days) take a positive number of days; decimals work. Missing or
// empty means the default, anything else logs a warning and uses the default too.
(function(window, document) {
    'use strict';

    const SCRIPT_TAG = document.currentScript;
    if (!SCRIPT_TAG) {
        console.error('[ConsentBridge] Script tag not found, so its data-cb-* configuration can\'t be read. Load ConsentBridge with a plain <script src> tag.');
        return;
    }
    const MS_IN_DAY = 1000 * 60 * 60 * 24;

    function daysAttribute(name, defaultDays) {
        const value = (SCRIPT_TAG.getAttribute(name) || '').trim();
        const days = Number(value);
        if (value === '') return defaultDays * MS_IN_DAY;
        if (days > 0 && isFinite(days)) return days * MS_IN_DAY;
        console.warn(`[ConsentBridge] ${name}="${value}" is not a positive number of days. Using ${defaultDays}.`);
        return defaultDays * MS_IN_DAY;
    }

    // --- data-cb-cookie-domain (consent shared across subdomains) ---
    // "example.com" and ".example.com" mean the same: the domain and all its subdomains.
    // Used only when the page actually runs on that domain; anywhere else the browser
    // would reject the cookie anyway.
    const COOKIE_DOMAIN_ATTRIBUTE = SCRIPT_TAG.getAttribute('data-cb-cookie-domain') || '';
    const COOKIE_DOMAIN_WANTED = COOKIE_DOMAIN_ATTRIBUTE.trim().toLowerCase().replace(/^\./, '');
    const HOSTNAME = window.location.hostname.toLowerCase();
    const COOKIE_DOMAIN = COOKIE_DOMAIN_WANTED &&
        (HOSTNAME === COOKIE_DOMAIN_WANTED || HOSTNAME.endsWith('.' + COOKIE_DOMAIN_WANTED))
        ? COOKIE_DOMAIN_WANTED : null;
    // ----------------------------------------------------------------------

    const CONFIG = {
        devMode: SCRIPT_TAG.getAttribute('data-cb-dev-mode') === 'true',
        cookieDomain: COOKIE_DOMAIN,
        cookieDomainWanted: COOKIE_DOMAIN_WANTED || null,
        cookieName: 'consentbridge',
        consentMaxAgeMs: daysAttribute('data-cb-consent-max-age-days', 365),
        rejectionRefreshMs: daysAttribute('data-cb-rejection-refresh-days', 182),
        categoryMapping: {
            'analytics': ['analytics_storage'],
            'marketing': ['ad_storage', 'ad_user_data', 'ad_personalization'],
            'preferences': ['functionality_storage']
        },
        managedConsentParams: [
            'analytics_storage',
            'ad_storage',
            'ad_user_data',
            'ad_personalization',
            'functionality_storage'
        ]
    };

    class ConsentBridge {
        constructor(config) {
            this.config = config;
            this.consentState = {};
            this._log('ConsentBridge initialized with config:', this.config);
            if (this.config.cookieDomainWanted && !this.config.cookieDomain) {
                this._log(`Shared consent cookie off: ${window.location.hostname} is not on ${this.config.cookieDomainWanted}. Using a host-only cookie.`);
            }
        }

        // Runs as soon as the script does, whether or not the DOM is ready.
        start() {
            window.dataLayer = window.dataLayer || [];
            window.gtag = window.gtag || function() { window.dataLayer.push(arguments); };
            const storedConsent = this.loadConsentFromStorage();
            if (storedConsent) this._applyConsent(storedConsent, 'storage');
        }

        // The one place a choice takes effect. source: 'storage' (stored choice) or 'ui' (made on this page).
        _applyConsent(consentState, source) {
            const fullConsentState = {};
            this.config.managedConsentParams.forEach(param => {
                fullConsentState[param] = consentState[param] === 'granted' ? 'granted' : 'denied';
            });
            this._log(`Applying consent from ${source}:`, fullConsentState);
            gtag('consent', 'update', fullConsentState);
            this.consentState = fullConsentState;
            window.dataLayer.push({
                'event': 'consent_state_updated',
                'consent_source': source,
                'updated_consent_state': { ...fullConsentState }
            });
            this._activateGrantedScripts();
        }

        updateConsentAfterUInteraction(newGoogleConsentStateFromUI) {
            this._applyConsent(newGoogleConsentStateFromUI, 'ui');
            this.saveConsentToStorage(this.consentState);
        }

        saveConsentToStorage(consentState) {
            const record = { v: 1, state: consentState, timestamp: Date.now() };
            this._writeCookie(record);
            this._log('Consent saved.', record);
        }

        // Of all consent cookies visible here, the newest valid record wins.
        loadConsentFromStorage() {
            let newest = null;
            this._readCookies().forEach(value => {
                const record = this._parseRecord(value);
                if (record && (!newest || record.timestamp > newest.timestamp)) newest = record;
            });
            if (!newest) return null;
            this._log('Stored consent loaded and valid.', newest);
            // Write again: Safari keeps cookies set from JavaScript for 7 days at most.
            this._writeCookie(newest);
            return newest.state;
        }

        // Visitors and other hosts under the domain can write this cookie, so it's read strictly.
        // Unknown fields are kept: a newer 1.x on another host may have added them.
        _parseRecord(value) {
            let record = null;
            try { record = JSON.parse(value); } catch (e) { /* invalid, handled below */ }
            if (!record || record.v !== 1 || !record.state || typeof record.state !== 'object'
                || typeof record.timestamp !== 'number' || !(record.timestamp <= Date.now())) {
                this._warn('Stored consent has an unknown format. Ignoring it.');
                return null;
            }
            if (this._remainingMs(record) <= 0) {
                this._log('Stored consent expired. Ignoring it.');
                return null;
            }
            return record;
        }

        // A choice is valid for data-cb-consent-max-age-days, or for the shorter
        // data-cb-rejection-refresh-days when nothing was granted.
        _remainingMs(record) {
            const nothingGranted = !this.config.managedConsentParams.some(param => record.state[param] === 'granted');
            const validMs = nothingGranted
                ? Math.min(this.config.consentMaxAgeMs, this.config.rejectionRefreshMs)
                : this.config.consentMaxAgeMs;
            return validMs - (Date.now() - record.timestamp);
        }

        // With a shared cookie, a host-only one left from before is removed. The newest record
        // of all is then written back as the shared cookie.
        _readCookies() {
            const values = this._cookieValues();
            if (this.config.cookieDomain && values.length > 0) this._deleteHostOnlyCookie();
            return values;
        }

        _cookieValues() {
            const prefix = this.config.cookieName + '=';
            let parts = [];
            try { parts = document.cookie.split('; '); }
            catch (e) { this._warn('Could not read the consent cookie: ' + e.message); }
            const values = [];
            parts.forEach(part => {
                if (part.indexOf(prefix) !== 0) return;
                try { values.push(decodeURIComponent(part.substring(prefix.length))); }
                catch (e) { /* malformed, skipped */ }
            });
            return values;
        }

        _writeCookie(record) {
            // The cookie expires with the choice. Browsers cap cookie lifetime at 400 days.
            const maxAgeMs = Math.min(this._remainingMs(record), 400 * MS_IN_DAY);
            try {
                document.cookie = this.config.cookieName + '=' + encodeURIComponent(JSON.stringify(record))
                    + (this.config.cookieDomain ? '; domain=' + this.config.cookieDomain : '')
                    + '; path=/'
                    + '; max-age=' + Math.floor(maxAgeMs / 1000)
                    + '; SameSite=Lax'
                    + (window.location.protocol === 'https:' ? '; Secure' : '');
            } catch (e) { this._warn('Could not save the consent cookie: ' + e.message); }
        }

        _deleteHostOnlyCookie() {
            try { document.cookie = this.config.cookieName + '=; path=/; max-age=0'; }
            catch (e) { this._warn('Could not remove the host-only consent cookie: ' + e.message); }
        }

        // Looked up when needed, so elements added after startup work too.
        _banner() { return document.querySelector('[data-cb-banner]'); }
        _settingsModal() { return document.querySelector('[data-cb-modal="settings"]'); }
        _checkboxes() { return document.querySelectorAll('[data-cb-category]'); }

        // One listener for every [data-cb-action] on the page, present or added later.
        _bindEventListeners() {
            document.addEventListener('click', (event) => {
                const button = event.target && event.target.closest ? event.target.closest('[data-cb-action]') : null;
                if (!button) return;
                event.preventDefault();
                switch (button.getAttribute('data-cb-action')) {
                    case 'accept-all': this._handleAcceptAll(); break;
                    case 'reject-all': this._handleRejectAll(); break;
                    case 'open-settings': this._handleOpenSettings(); break;
                    case 'reopen-settings': this._handleOpenSettings(); break;
                    case 'save-settings': this._handleSaveSettings(); break;
                    case 'close-modal': this._closeSettings(); break;
                }
            });
            document.addEventListener('keydown', (event) => {
                if (event.key === 'Escape' && this._settingsOpen) this._closeSettings();
            });
        }

        // A native <dialog> opens through its own API. Anything else gets the display from
        // data-cb-display, by default flex for the modal and block for the banner.
        _showElement(element) {
            if (!element) return;
            if (element.tagName === 'DIALOG') {
                if (element.open) return;
                if (element.hasAttribute('data-cb-modal')) element.showModal();
                else element.show();
                return;
            }
            element.style.display = element.getAttribute('data-cb-display')
                || (element.hasAttribute('data-cb-modal') ? 'flex' : 'block');
        }

        _hideElement(element) {
            if (!element) return;
            if (element.tagName === 'DIALOG') {
                if (element.open) element.close();
            } else {
                element.style.display = 'none';
            }
        }

        _updateCheckboxesUI(googleConsentState) {
            this._checkboxes().forEach(checkbox => {
                const userCategoryAlias = checkbox.getAttribute('data-cb-category');
                if (userCategoryAlias && this.config.categoryMapping.hasOwnProperty(userCategoryAlias)) {
                    const googleParamsForAlias = this.config.categoryMapping[userCategoryAlias];
                    let allUnderlyingGranted = googleParamsForAlias.length > 0;
                    googleParamsForAlias.forEach(googleParam => {
                        if (googleConsentState[googleParam] !== 'granted') allUnderlyingGranted = false;
                    });
                    checkbox.checked = allUnderlyingGranted;
                }
            });
        }

        // A category counts as granted when all its Consent Mode signals are.
        _hasConsent(category) {
            const params = this.config.categoryMapping[category];
            return Boolean(params) && params.every(param => this.consentState[param] === 'granted');
        }

        // Activates each blocked script once all categories it lists are granted.
        // data-cb-consent-category takes a space-separated list.
        _activateGrantedScripts() {
            document.querySelectorAll('script[type="text/plain"][data-cb-consent-category]').forEach(originalScript => {
                if (originalScript.dataset.cbActivated === 'true') return;
                const categories = originalScript.getAttribute('data-cb-consent-category').trim().split(/\s+/);
                if (!categories.every(category => this._hasConsent(category))) return;
                const newScript = document.createElement('script');
                Array.from(originalScript.attributes).forEach(attr => {
                    if (attr.name !== 'type' && attr.name !== 'data-cb-consent-category' && attr.name !== 'data-cb-activated') {
                        newScript.setAttribute(attr.name, attr.value);
                    }
                });
                newScript.type = 'text/javascript';
                // Scripts added from JavaScript run as async by default. Keep document order
                // unless the original asked for async.
                newScript.async = originalScript.hasAttribute('async');
                if (!originalScript.src) newScript.textContent = originalScript.textContent;
                originalScript.parentNode.insertBefore(newScript, originalScript.nextSibling);
                originalScript.dataset.cbActivated = 'true';
                this._log(`Activated script (${categories.join(', ')}):`, newScript.src || 'inline');
            });
        }

        _handleAcceptAll() {
            const consentState = {};
            this.config.managedConsentParams.forEach(param => consentState[param] = 'granted');
            this.updateConsentAfterUInteraction(consentState);
            this._hideElement(this._banner());
            this._closeSettings();
        }

        _handleRejectAll() {
            const consentState = {};
            this.config.managedConsentParams.forEach(param => consentState[param] = 'denied');
            this.updateConsentAfterUInteraction(consentState);
            this._hideElement(this._banner());
            this._closeSettings();
        }

        // A native <dialog> handles focus and Esc itself. For any other element, the modal gets
        // its ARIA role, focus moves into it, Esc closes it and focus returns to the opener.
        _handleOpenSettings() {
            const modal = this._settingsModal();
            if (!modal) return;
            this._updateCheckboxesUI(this.consentState);
            const native = modal.tagName === 'DIALOG';
            if (!native) {
                if (!modal.hasAttribute('role')) modal.setAttribute('role', 'dialog');
                if (!modal.hasAttribute('aria-modal')) modal.setAttribute('aria-modal', 'true');
                this._settingsOpener = document.activeElement;
            }
            this._showElement(modal);
            if (!native) {
                const first = modal.querySelector('input, select, textarea, button, a[href], [tabindex]');
                if (first) first.focus();
                this._settingsOpen = true;
            }
        }

        _closeSettings() {
            this._hideElement(this._settingsModal());
            if (!this._settingsOpen) return;
            this._settingsOpen = false;
            if (this._settingsOpener && this._settingsOpener.focus) this._settingsOpener.focus();
        }

        _handleSaveSettings() {
            const userChoices = {};
            this._checkboxes().forEach(checkbox => {
                const userCategoryAlias = checkbox.getAttribute('data-cb-category');
                if (userCategoryAlias) userChoices[userCategoryAlias] = checkbox.checked;
            });
            const newGoogleConsentState = {};
            this.config.managedConsentParams.forEach(param => newGoogleConsentState[param] = 'denied');
            for (const alias in userChoices) {
                if (userChoices.hasOwnProperty(alias) && this.config.categoryMapping.hasOwnProperty(alias)) {
                    if (userChoices[alias]) {
                        this.config.categoryMapping[alias].forEach(googleParam => {
                            newGoogleConsentState[googleParam] = 'granted';
                        });
                    }
                }
            }
            this.updateConsentAfterUInteraction(newGoogleConsentState);
            this._closeSettings();
            this._hideElement(this._banner());
        }

        // Runs once the DOM is ready: wires up the UI and activates scripts parsed since start().
        init() {
            this._bindEventListeners();
            this._activateGrantedScripts();
            if (Object.keys(this.consentState).length > 0) this._hideElement(this._banner());
            else this._showElement(this._banner());
            this._log('ConsentBridge setup complete.');
        }

        // Debug output, shown only with data-cb-dev-mode="true".
        _log(message, data) {
            if (!this.config.devMode) return;
            if (data === undefined) return console.log('[ConsentBridge] ' + message);
            // A snapshot, so the console doesn't show later changes to the object.
            try { data = JSON.parse(JSON.stringify(data)); } catch (e) { /* log as is */ }
            console.log('[ConsentBridge] ' + message, data);
        }

        // Always shown.
        _warn(message) {
            console.warn('[ConsentBridge] ' + message);
        }
    }

    const consentManager = new ConsentBridge(CONFIG);
    consentManager.start();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => consentManager.init());
    } else {
        consentManager.init();
    }
})(window, document);
