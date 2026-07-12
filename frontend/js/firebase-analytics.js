/**
 * Coyote's Dune Delivery — Firebase Analytics Integration
 * Prepares Firebase Analytics for future native app expansion.
 * Logs the same events as GA4 through Firebase for cross-platform tracking.
 *
 * Setup:
 * 1. Create a Firebase project at https://console.firebase.google.com
 * 2. Add a web app and copy the config values
 * 3. Set FIREBASE_API_KEY, FIREBASE_PROJECT_ID in Netlify env vars
 * 4. The script initializes Firebase Analytics automatically
 *
 * Usage:
 *   firebaseTrackEvent('order_submitted', { service_type: 'ride', price: 25.00 });
 *   firebaseTrackScreen('Order Confirmation');
 */

(function () {
    'use strict';

    // ── Firebase Config (placeholder — override via env) ────
    const FIREBASE_CONFIG = {
        apiKey: window.__FIREBASE_API_KEY__ || 'YOUR_FIREBASE_API_KEY',
        authDomain: window.__FIREBASE_PROJECT_ID__ + '.firebaseapp.com',
        projectId: window.__FIREBASE_PROJECT_ID__ || 'your-project-id',
        storageBucket: window.__FIREBASE_PROJECT_ID__ + '.appspot.com',
        messagingSenderId: window.__FIREBASE_MESSAGING_SENDER_ID__ || '000000000000',
        appId: window.__FIREBASE_APP_ID__ || '1:000000000000:web:xxxxxxxxxxxxxxxx',
        measurementId: window.__FIREBASE_MEASUREMENT_ID__ || 'G-XXXXXXXXXX',
    };

    let analytics = null;
    let isReady = false;

    // ── Load Firebase SDKs dynamically ──────────────────────
    async function loadFirebase() {
        // Skip if Firebase is already loaded
        if (window.firebase && window.firebase.analytics) {
            initFirebase();
            return;
        }

        // Load Firebase App SDK
        const appScript = document.createElement('script');
        appScript.src = 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js';
        appScript.onload = function () {
            // Load Firebase Analytics SDK
            const analyticsScript = document.createElement('script');
            analyticsScript.src = 'https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics-compat.js';
            analyticsScript.onload = initFirebase;
            document.head.appendChild(analyticsScript);
        };
        document.head.appendChild(appScript);
    }

    function initFirebase() {
        try {
            if (!window.firebase) {
                console.warn('[Firebase Analytics] Firebase SDK not loaded');
                return;
            }
            // Initialize only once
            if (!window.firebase.apps.length) {
                window.firebase.initializeApp(FIREBASE_CONFIG);
            }
            analytics = window.firebase.analytics();
            isReady = true;
            console.log('[Firebase Analytics] Initialized');
        } catch (err) {
            console.warn('[Firebase Analytics] Init failed:', err.message);
        }
    }

    // ── Public API ──────────────────────────────────────────

    /**
     * Log a Firebase Analytics event.
     * @param {string} eventName — event name (snake_case)
     * @param {Object} [params]  — event parameters
     */
    window.firebaseTrackEvent = function (eventName, params) {
        if (!isReady || !analytics) {
            console.warn('[Firebase Analytics] Not ready, event queued:', eventName);
            return;
        }
        try {
            analytics.logEvent(eventName, params || {});
        } catch (err) {
            console.warn('[Firebase Analytics] logEvent failed:', err.message);
        }
    };

    /**
     * Log a screen view (for SPA navigation).
     * @param {string} screenName — screen/page name
     * @param {string} [screenClass] — optional screen class
     */
    window.firebaseTrackScreen = function (screenName, screenClass) {
        if (!isReady || !analytics) {
            console.warn('[Firebase Analytics] Not ready, screen queued:', screenName);
            return;
        }
        try {
            const params = { firebase_screen: screenName };
            if (screenClass) params.firebase_screen_class = screenClass;
            analytics.logEvent('screen_view', params);
        } catch (err) {
            console.warn('[Firebase Analytics] screen_view failed:', err.message);
        }
    };

    /**
     * Set user properties for segmentation.
     * @param {Object} properties — key/value pairs
     */
    window.firebaseSetUserProperties = function (properties) {
        if (!isReady || !analytics) {
            console.warn('[Firebase Analytics] Not ready, properties queued');
            return;
        }
        try {
            analytics.setUserProperties(properties);
        } catch (err) {
            console.warn('[Firebase Analytics] setUserProperties failed:', err.message);
        }
    };

    // ── Initialize ──────────────────────────────────────────
    function init() {
        loadFirebase();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
