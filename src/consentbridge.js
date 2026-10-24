// ConsentBridge: cookie consent for Webflow with Google Consent Mode v2.
// Configuration is read from data-cb-* attributes on this script tag. The Consent Mode
// defaults come from the inline snippet (src/snippet.html), which sites put first in <head>.
//
// The choice is stored in one first-party cookie, consentbridge, host-only by default.
// Optional data-cb-cookie-domain="example.com" sets it for that domain and all its subdomains,
//   so www.example.com and blog.example.com read the same choice. On hosts outside that
//   domain (staging, preview) the cookie stays host-only.
//
// data-cb-revision (any text) asks everyone again when it changes, e.g. after the privacy
// policy changes or a tracker is added. A stored choice counts only for the same revision.
//
// When a visitor withdraws a category they had granted, the page reloads after saving, so
// scripts that already ran stop. data-cb-reload-on-withdrawal="false" turns that off.
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
        revision: (SCRIPT_TAG.getAttribute('data-cb-revision') || '').trim(),
        reloadOnWithdrawal: SCRIPT_TAG.getAttribute('data-cb-reload-on-withdrawal') !== 'false',
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

        // Runs as soon as the script does, whether or not the DOM is ready. The API exists
        // before the first cb:consent event, which reports the stored choice or the default.
        start() {
            window.dataLayer = window.dataLayer || [];
            window.gtag = window.gtag || function() { window.dataLayer.push(arguments); };
            window.ConsentBridge = {
                getState: () => this._state(),
                hasConsent: (category) => this._hasConsent(category),
                open: () => this._handleOpenSettings(),
                acceptAll: () => this._choose(this._allSignals('granted'), 'api'),
                rejectAll: () => this._choose(this._allSignals('denied'), 'api')
            };
            const storedConsent = this.loadConsentFromStorage();
            if (storedConsent) this._applyConsent(storedConsent, 'storage');
            else this._dispatch('default', []);
        }

        _allSignals(value) {
            const state = {};
            this.config.managedConsentParams.forEach(param => state[param] = value);
            return state;
        }

        // What getState() returns and every cb:consent event carries.
        _state() {
            const categories = {};
            Object.keys(this.config.categoryMapping).forEach(category => categories[category] = this._hasConsent(category));
            const signals = {};
            this.config.managedConsentParams.forEach(param => signals[param] = this.consentState[param] || 'denied');
            return { decided: Object.keys(this.consentState).length > 0, categories, signals };
        }

        _dispatch(source, changed) {
            const detail = { ...this._state(), source, changed };
            this._log('cb:consent', detail);
            document.dispatchEvent(new CustomEvent('cb:consent', { detail }));
        }

        // The one place a choice takes effect. source: 'storage' (stored choice), 'ui' or 'api'
        // (made on this page).
        _applyConsent(consentState, source) {
            const before = this._state().categories;
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
            const after = this._state().categories;
            this._dispatch(source, Object.keys(after).filter(category => after[category] !== before[category]));
        }

        // A choice made on this page: applied, saved, and the banner and settings closed.
        // Withdrawing a granted category reloads the page: scripts that already ran (activated
        // ones, and tags GTM fired) keep running otherwise.
        _choose(consentState, source) {
            const before = this._state().categories;
            this._applyConsent(consentState, source);
            this.saveConsentToStorage(this.consentState);
            this._hideElement(this._banner());
            this._closeSettings();
            const withdrawn = Object.keys(before).filter(category => before[category] && !this._hasConsent(category));
            if (withdrawn.length > 0 && this.config.reloadOnWithdrawal) {
                this._log('Consent withdrawn, reloading:', withdrawn);
                window.location.reload();
            }
        }

        saveConsentToStorage(consentState) {
            const record = { v: 1, state: consentState, timestamp: Date.now() };
            if (this.config.revision) record.revision = this.config.revision;
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
            const revision = typeof record.revision === 'string' ? record.revision : '';
            if (revision !== this.config.revision) {
                this._log(`Stored consent is for revision "${revision}", this page has "${this.config.revision}". Asking again.`);
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
                    case 'accept-all': this._choose(this._allSignals('granted'), 'ui'); break;
                    case 'reject-all': this._choose(this._allSignals('denied'), 'ui'); break;
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

        _updateCheckboxesUI() {
            this._checkboxes().forEach(checkbox => {
                checkbox.checked = this._hasConsent(checkbox.getAttribute('data-cb-category'));
                // A Webflow custom checkbox shows its state on a sibling element, which Webflow
                // only updates on clicks.
                const custom = checkbox.parentNode && checkbox.parentNode.querySelector('.w-checkbox-input');
                if (custom) custom.classList.toggle('w--redirected-checked', checkbox.checked);
            });
        }

        // A category counts as granted when all its Consent Mode signals are.
        _hasConsent(category) {
            const params = this._signalsFor(category);
            return Boolean(params) && params.every(param => this.consentState[param] === 'granted');
        }

        // Own properties only, so a category like "constructor" is just unknown.
        _signalsFor(category) {
            const mapping = this.config.categoryMapping;
            return Object.prototype.hasOwnProperty.call(mapping, category) ? mapping[category] : null;
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

        // A native <dialog> handles focus and Esc itself. For any other element, the modal gets
        // its ARIA role, focus moves into it, Esc closes it and focus returns to the opener.
        _handleOpenSettings() {
            const modal = this._settingsModal();
            if (!modal) return;
            this._updateCheckboxesUI();
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
            const consentState = {};
            this._checkboxes().forEach(checkbox => {
                const params = this._signalsFor(checkbox.getAttribute('data-cb-category'));
                if (checkbox.checked && params) params.forEach(param => consentState[param] = 'granted');
            });
            this._choose(consentState, 'ui');
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

    if (window.ConsentBridge) {
        console.warn('[ConsentBridge] Loaded twice. Only the first copy runs.');
        return;
    }
    const consentManager = new ConsentBridge(CONFIG);
    consentManager.start();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => consentManager.init());
    } else {
        consentManager.init();
    }
})(window, document);
