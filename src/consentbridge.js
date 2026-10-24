// ConsentBridge: cookie consent for Webflow with Google Consent Mode v2.
// Configuration is read from data-cb-* attributes on this script tag. The Consent Mode
// defaults come from the inline snippet (src/snippet.html), which sites put first in <head>.
//
// The choice is stored in one first-party cookie, consentbridge, host-only by default.
// Optional data-cb-cookie-domain="example.com" sets it for that domain and all its subdomains,
//   so www.example.com and blog.example.com read the same choice. On hosts outside that
//   domain (staging, preview) the cookie stays host-only.
//
// Day values in data-cb-*-days attributes are parsed with parseFloat, so decimals work.
(function(window, document) {
    'use strict';

    const SCRIPT_TAG = document.currentScript;
    const MS_IN_DAY = 1000 * 60 * 60 * 24;
    const DEFAULT_REJECTION_DAYS = 182;
    const DEFAULT_MAX_AGE_DAYS = 365;

    // --- data-cb-consent-max-age-days ---
    const MAX_AGE_ATTRIBUTE = SCRIPT_TAG ? SCRIPT_TAG.getAttribute('data-cb-consent-max-age-days') : '10';
    let MAX_AGE_MS;

    if (MAX_AGE_ATTRIBUTE === "") {
        MAX_AGE_MS = Infinity;
    } else {
        // parseFloat accepts decimal values
        const days = parseFloat(MAX_AGE_ATTRIBUTE || DEFAULT_MAX_AGE_DAYS);
        MAX_AGE_MS = isNaN(days) ? (DEFAULT_MAX_AGE_DAYS * MS_IN_DAY) : (days * MS_IN_DAY);
    }

    // --- data-cb-rejection-refresh-days ---
    const REFRESH_REJECT_ATTRIBUTE = SCRIPT_TAG ? SCRIPT_TAG.getAttribute('data-cb-rejection-refresh-days') : '100';
    let REFRESH_REJECT_DAYS;

    if (REFRESH_REJECT_ATTRIBUTE === "") {
        REFRESH_REJECT_DAYS = DEFAULT_REJECTION_DAYS;
    } else {
        // parseFloat accepts decimal values
        const days = parseFloat(REFRESH_REJECT_ATTRIBUTE || DEFAULT_REJECTION_DAYS);
        REFRESH_REJECT_DAYS = isNaN(days) ? DEFAULT_REJECTION_DAYS : days;
    }
    // ----------------------------------------------------------------------

    // --- data-cb-cookie-domain (consent shared across subdomains) ---
    // "example.com" and ".example.com" mean the same: the domain and all its subdomains.
    // Used only when the page actually runs on that domain; anywhere else the browser
    // would reject the cookie anyway.
    const COOKIE_DOMAIN_ATTRIBUTE = SCRIPT_TAG ? (SCRIPT_TAG.getAttribute('data-cb-cookie-domain') || '') : '';
    const COOKIE_DOMAIN_WANTED = COOKIE_DOMAIN_ATTRIBUTE.trim().toLowerCase().replace(/^\./, '');
    const HOSTNAME = window.location.hostname.toLowerCase();
    const COOKIE_DOMAIN = COOKIE_DOMAIN_WANTED &&
        (HOSTNAME === COOKIE_DOMAIN_WANTED || HOSTNAME.endsWith('.' + COOKIE_DOMAIN_WANTED))
        ? COOKIE_DOMAIN_WANTED : null;
    // ----------------------------------------------------------------------

    const CONFIG = {
        devMode: (SCRIPT_TAG ? SCRIPT_TAG.getAttribute('data-cb-dev-mode') : 'false') === 'true',
        cookieDomain: COOKIE_DOMAIN,
        cookieDomainWanted: COOKIE_DOMAIN_WANTED || null,
        cookieName: 'consentbridge',
        // Time limits
        consentMaxAgeMs: MAX_AGE_MS,
        rejectionRefreshMs: REFRESH_REJECT_DAYS * MS_IN_DAY,
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
            this.elements = {};
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
                this._log('Stored consent has an unknown format. Ignoring it.', 'warn');
                return null;
            }
            if (this._remainingMs(record) <= 0) {
                this._log('Stored consent expired. Ignoring it.', 'warn');
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
            catch (e) { this._log('Error reading the consent cookie: ' + e.message, 'error'); }
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
            } catch (e) { this._log('Error saving the consent cookie: ' + e.message, 'error'); }
        }

        _deleteHostOnlyCookie() {
            try { document.cookie = this.config.cookieName + '=; path=/; max-age=0'; }
            catch (e) { this._log('Error removing the host-only consent cookie: ' + e.message, 'error'); }
        }

        _queryElements() {
            this.elements.banner = document.querySelector('[data-cb-banner]');
            this.elements.settingsModal = document.querySelector('[data-cb-modal="settings"]');
            this.elements.actionButtons = document.querySelectorAll('[data-cb-action]');
            this.elements.categoryCheckboxes = document.querySelectorAll('[data-cb-category]');
            this.elements.privacyLink = document.querySelector('[data-cb-link="privacy-policy"]');
        }

        _bindEventListeners() {
            if (!this.elements.actionButtons) return;
            this.elements.actionButtons.forEach(button => {
                const action = button.getAttribute('data-cb-action');
                button.addEventListener('click', (event) => {
                    event.preventDefault();
                    switch (action) {
                        case 'accept-all': this._handleAcceptAll(); break;
                        case 'reject-all': this._handleRejectAll(); break;
                        case 'open-settings': this._handleOpenSettings(); break;
                        case 'reopen-settings': this._handleOpenSettings(); break;
                        case 'save-settings': this._handleSaveSettings(); break;
                        case 'close-modal':
                            const targetModal = button.getAttribute('data-cb-target-modal');
                            if (targetModal) this._handleCloseModal(targetModal);
                            break;
                    }
                });
            });
        }

        _showElement(element) {
            if (element) {
                 if (element.hasAttribute('data-cb-modal')) element.style.display = 'flex';
                 else element.style.display = 'block';
            }
        }

        _hideElement(element) {
            if (element) element.style.display = 'none';
        }

        _updateCheckboxesUI(googleConsentState) {
            if (!this.elements.categoryCheckboxes) return;
            this.elements.categoryCheckboxes.forEach(checkbox => {
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

        _activateGrantedScripts() {
            this.config.managedConsentParams.forEach(googleParam => {
                if (this.consentState[googleParam] === 'granted') this._activateScriptsForGoogleParam(googleParam);
            });
        }

        _activateScriptsForGoogleParam(googleParamKey) {
            const relevantUserAliases = [];
            for (const alias in this.config.categoryMapping) {
                if (this.config.categoryMapping[alias].includes(googleParamKey)) relevantUserAliases.push(alias);
            }
            relevantUserAliases.forEach(alias => {
                const scriptsToActivate = document.querySelectorAll(
                    `script[type="text/plain"][data-cb-consent-category="${alias}"]`
                );
                scriptsToActivate.forEach(originalScript => {
                    if (originalScript.dataset.cbActivated === 'true') return;
                    const newScript = document.createElement('script');
                    Array.from(originalScript.attributes).forEach(attr => {
                        if (attr.name !== 'type' && attr.name !== 'data-cb-consent-category' && attr.name !== 'data-cb-activated') {
                            newScript.setAttribute(attr.name, attr.value);
                        }
                    });
                    newScript.type = 'text/javascript';
                    if (originalScript.src) {} else { newScript.textContent = originalScript.textContent; }
                    originalScript.parentNode.insertBefore(newScript, originalScript.nextSibling);
                    originalScript.dataset.cbActivated = 'true';
                    this._log(`Activated script (user category: ${alias}):`, newScript.src || 'inline');
                });
            });
        }

        _handleAcceptAll() {
            const consentState = {};
            this.config.managedConsentParams.forEach(param => consentState[param] = 'granted');
            this.updateConsentAfterUInteraction(consentState);
            this._hideElement(this.elements.banner);
            this._hideElement(this.elements.settingsModal);
        }

        _handleRejectAll() {
            const consentState = {};
            this.config.managedConsentParams.forEach(param => consentState[param] = 'denied');
            this.updateConsentAfterUInteraction(consentState);
            this._hideElement(this.elements.banner);
            this._hideElement(this.elements.settingsModal);
        }

        _handleOpenSettings() {
            this._updateCheckboxesUI(this.consentState);
            this._showElement(this.elements.settingsModal);
        }

        _handleSaveSettings() {
            const userChoices = {};
            if(this.elements.categoryCheckboxes){
                this.elements.categoryCheckboxes.forEach(checkbox => {
                    const userCategoryAlias = checkbox.getAttribute('data-cb-category');
                    if (userCategoryAlias) userChoices[userCategoryAlias] = checkbox.checked;
                });
            }
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
            this._hideElement(this.elements.settingsModal);
            this._hideElement(this.elements.banner);
        }

        _handleCloseModal(modalName) {
            const modalToClose = document.querySelector(`[data-cb-modal="${modalName}"]`);
            this._hideElement(modalToClose);
        }

        // Runs once the DOM is ready: wires up the UI and activates scripts parsed since start().
        init() {
            this._queryElements();
            if (this.elements.banner) this._bindEventListeners();
            else this._log('Banner element [data-cb-banner] not found. Consent UI will not be displayed.', 'warn');
            this._activateGrantedScripts();
            if (Object.keys(this.consentState).length > 0) this._hideElement(this.elements.banner);
            else this._showElement(this.elements.banner);
            this._log('ConsentBridge setup complete.');
        }

        _log(message, data = '', type = 'info') {
            if (this.config.devMode || type === 'error' || type === 'warn') {
                const logFn = console[type] || console.log;
                let dataToLog = data;
                if (data && typeof data === 'object') {
                    try { dataToLog = JSON.parse(JSON.stringify(data)); } catch (e) { /* fallback */ }
                }
                if (data !== '') { logFn(`[ConsentBridge] ${message}`, dataToLog); }
                else { logFn(`[ConsentBridge] ${message}`); }
            }
        }
    }

    if (!SCRIPT_TAG) {
        console.error('[ConsentBridge] CRITICAL: Script tag not identified. Configuration may be missing.');
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
