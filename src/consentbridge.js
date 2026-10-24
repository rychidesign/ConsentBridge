// ConsentBridge: cookie consent for Webflow with Google Consent Mode v2.
// Configuration is read from data-cb-* attributes on this script tag.
//
// Optional data-cb-cookie-domain="example.com" shares the consent choice across subdomains.
//   The choice is stored in localStorage and in a cookie set for that domain and all its
//   subdomains, so www.example.com and blog.example.com read the same choice.
//   The cookie takes precedence over localStorage. On hosts outside that domain (staging,
//   preview) no cookie is written. Without the attribute only localStorage is used.
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
        waitForUpdate: parseInt(SCRIPT_TAG ? SCRIPT_TAG.getAttribute('data-cb-wait-for-update') : '500', 10),
        devMode: (SCRIPT_TAG ? SCRIPT_TAG.getAttribute('data-cb-dev-mode') : 'false') === 'true',
        localStorageKey: 'consentbridge',
        cookieDomain: COOKIE_DOMAIN,
        cookieDomainWanted: COOKIE_DOMAIN_WANTED || null,
        cookieName: 'cb_consent',
        updateDefaultStateFromStorage: (SCRIPT_TAG ? SCRIPT_TAG.getAttribute('data-cb-default-state-updated') : 'false') === 'true',
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
            this.defaultStateWasUpdatedFromStorage = false;
            this._log('ConsentBridge initialized with config:', this.config);
            if (this.config.updateDefaultStateFromStorage) {
                this._log('Strategy: Attempting to update default consent state from localStorage.', 'warn');
            }
            if (this.config.cookieDomainWanted && !this.config.cookieDomain) {
                this._log(`Shared consent cookie off: ${window.location.hostname} is not on ${this.config.cookieDomainWanted}. Using localStorage only.`);
            }
        }

        _getInitialConsentStateForDefault() {
            const initialConsent = {};
            if (this.config.updateDefaultStateFromStorage) {
                const storedConsent = this.loadConsentFromStorage();
                if (storedConsent) {
                    this.config.managedConsentParams.forEach(param => {
                        initialConsent[param] = storedConsent[param] || 'denied';
                    });
                    this.consentState = { ...initialConsent };
                    this.defaultStateWasUpdatedFromStorage = true;
                    return initialConsent;
                }
            }
            this.config.managedConsentParams.forEach(param => {
                initialConsent[param] = 'denied';
            });
            return initialConsent;
        }

        initDefaultConsent() {
            window.dataLayer = window.dataLayer || [];
            window.gtag = window.gtag || function() { dataLayer.push(arguments); };
            const defaultValues = this._getInitialConsentStateForDefault();
            const consentDefaultCommand = { ...defaultValues };
            consentDefaultCommand.wait_for_update = this.defaultStateWasUpdatedFromStorage ? 0 : this.config.waitForUpdate;
            this._log('Setting default consent:', consentDefaultCommand);
            gtag('consent', 'default', consentDefaultCommand);
        }

        updateConsentAfterUInteraction(newGoogleConsentStateFromUI) {
            const fullConsentState = {};
            this.config.managedConsentParams.forEach(param => {
                fullConsentState[param] = newGoogleConsentStateFromUI[param] || 'denied';
            });
            this._log('Updating consent via gtag("consent", "update") AFTER UI interaction:', fullConsentState);
            gtag('consent', 'update', fullConsentState);
            this.consentState = fullConsentState;
            this.saveConsentToStorage(fullConsentState);
            this._log('Pushing consent_state_updated event to dataLayer (due to UI interaction).');
            window.dataLayer.push({
                'event': 'consent_state_updated',
                'updated_consent_state': { ...fullConsentState }
            });
            this._activateGrantedScripts();
        }

        saveConsentToStorage(consentState) {
            try {
                const now = Date.now();
                // Check whether the user denied all optional categories
                const allDenied = Object.values(consentState).every(status => status === 'denied');

                const storageData = {
                    state: consentState,
                    timestamp: now,
                    allDenied: allDenied
                };

                this._writeCookie(storageData);
                localStorage.setItem(this.config.localStorageKey, JSON.stringify(storageData));
                this._log('Consent saved with timestamp and allDenied status.', storageData);
            } catch (e) { this._log('Error saving consent: ' + e.message, 'error'); }
        }

        loadConsentFromStorage() {
            try {
                // The shared cookie wins: another subdomain may have updated it since.
                const fromCookie = this._readCookie();
                const stored = fromCookie || localStorage.getItem(this.config.localStorageKey);
                if (stored) {
                    const storageData = JSON.parse(stored);

                    if (!storageData || !storageData.state || !storageData.timestamp) {
                        this._log('Invalid or old stored consent format. Treating as no consent.', 'warn');
                        return null;
                    }

                    const now = Date.now();
                    const timeElapsed = now - storageData.timestamp;

                    // Rule 1: expiry (max age)
                    if (timeElapsed > this.config.consentMaxAgeMs) {
                        const maxAgeDays = this.config.consentMaxAgeMs === Infinity ? 'forever' : `${this.config.consentMaxAgeMs / MS_IN_DAY} days`;
                        this._log(`Stored consent expired (older than ${maxAgeDays}). Treating as no consent.`, 'warn');
                        localStorage.removeItem(this.config.localStorageKey);
                        this._deleteCookie();
                        return null;
                    }

                    // Rule 2: show the banner again (refresh days, only when everything was denied)
                    if (storageData.allDenied === true && timeElapsed > this.config.rejectionRefreshMs) {
                        this._log(`All denied consent expired after ${this.config.rejectionRefreshMs / MS_IN_DAY} days. Treating as no consent to re-show banner.`, 'warn');
                        return null;
                    }

                    // Consent is valid
                    this._log('Stored consent loaded and valid.', { timeElapsed: timeElapsed, allDenied: storageData.allDenied });
                    // Write again: refreshes the cookie (Safari caps script-set cookies at 7 days), copies
                    // a choice stored only in localStorage into the cookie and syncs localStorage with it.
                    this._writeCookie(storageData);
                    if (fromCookie) {
                        try { localStorage.setItem(this.config.localStorageKey, fromCookie); } catch (e) { /* backup only */ }
                    }
                    return storageData.state;

                }
            } catch (e) {
                this._log('Error loading consent: ' + e.message + '. Removing stored data.', 'error');
                try { localStorage.removeItem(this.config.localStorageKey); } catch (e2) { /* unavailable */ }
                this._deleteCookie();
            }
            return null;
        }

        // --- Consent shared across subdomains via cookie ---
        _readCookie() {
            if (!this.config.cookieDomain) return null;
            const prefix = this.config.cookieName + '=';
            const found = document.cookie.split('; ').find(part => part.indexOf(prefix) === 0);
            if (!found) return null;
            try { return decodeURIComponent(found.substring(prefix.length)); }
            catch (e) { return null; }
        }

        _writeCookie(storageData) {
            if (!this.config.cookieDomain) return;
            // Browsers cap cookie lifetime at 400 days; consent validity is decided by the
            // timestamp inside the record, not by the cookie expiry.
            const maxAgeDays = Math.min(this.config.consentMaxAgeMs / MS_IN_DAY, 400);
            document.cookie = this.config.cookieName + '=' + encodeURIComponent(JSON.stringify(storageData))
                + '; domain=' + this.config.cookieDomain
                + '; path=/'
                + '; max-age=' + Math.floor(maxAgeDays * 86400)
                + '; SameSite=Lax'
                + (window.location.protocol === 'https:' ? '; Secure' : '');
        }

        _deleteCookie() {
            if (!this.config.cookieDomain) return;
            document.cookie = this.config.cookieName + '=; domain=' + this.config.cookieDomain + '; path=/; max-age=0';
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
            let consentForUI = this.consentState && Object.keys(this.consentState).length > 0
                ? this.consentState : this.loadConsentFromStorage();
            if (!consentForUI || Object.keys(consentForUI).length === 0) {
                consentForUI = {};
                this.config.managedConsentParams.forEach(param => consentForUI[param] = 'denied');
            }
            const displayConsent = {};
            this.config.managedConsentParams.forEach(param => displayConsent[param] = consentForUI[param] || 'denied');
            this._updateCheckboxesUI(displayConsent);
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

        init() {
            this.initDefaultConsent();
            this._queryElements();
            if (this.elements.banner) this._bindEventListeners();
            else this._log('Banner element [data-cb-banner] not found. Consent UI will not be displayed.', 'warn');

            if (this.defaultStateWasUpdatedFromStorage) {
                this._log('Default consent was updated from storage. Hiding banner and activating scripts.');
                if (this.elements.banner) this._hideElement(this.elements.banner);
                // Push consent_state_updated here so GTM can react to the state already granted in the default
                window.dataLayer.push({
                    'event': 'consent_state_updated',
                    'updated_consent_state': { ...this.consentState }
                });
                this._activateGrantedScripts();
            } else {
                const storedConsent = this.loadConsentFromStorage();
                if (storedConsent) {
                    this._log('Stored consent found (standard path). Applying consent state.');
                    gtag('consent', 'update', storedConsent);
                    this.consentState = storedConsent;
                    // No 'consent_state_updated' here; this path relies on the standard GTM triggers
                    if (this.elements.banner) this._hideElement(this.elements.banner);
                    this._activateGrantedScripts();
                } else {
                    this._log('No stored consent found OR consent expired. Banner will be shown.');
                    if (this.elements.banner) this._showElement(this.elements.banner);
                }
            }
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
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => consentManager.init());
    } else {
        consentManager.init();
    }
})(window, document);
