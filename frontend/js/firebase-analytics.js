/**
 * Coyote's Dune Delivery — Firebase Analytics Integration
 */
(function () {
    'use strict';

    const FIREBASE_CONFIG = {
        apiKey: window.__FIREBASE_API_KEY__ || 'YOUR_FIREBASE_API_KEY',
        authDomain: (window.__FIREBASE_PROJECT_ID__ || 'your-project-id') + '.firebaseapp.com',
        projectId: window.__FIREBASE_PROJECT_ID__ || 'your-project-id',
        storageBucket: (window.__FIREBASE_PROJECT_ID__ || 'your-project-id') + '.appspot.com',
        messagingSenderId: window.__FIREBASE_MESSAGING_SENDER_ID__ || '000000000000',
        appId: window.__FIREBASE_APP_ID__ || '1:000000000000:web:xxxxxxxxxxxxxxxx',
        measurementId: window.__FIREBASE_MEASUREMENT_ID__ || 'G-XXXXXXXXXX',
    };

    let analytics = null;
    let isReady = false;
    const sessionId = window.__CDD_SESSION_ID__ || ('fb_sess_' + Date.now());

    async function loadFirebase() {
        if (window.firebase && window.firebase.analytics) {
            initFirebase();
            return;
        }
        const appScript = document.createElement('script');
        appScript.src = 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js';
        appScript.onload = function () {
            const analyticsScript = document.createElement('script');
            analyticsScript.src = 'https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics-compat.js';
            analyticsScript.onload = initFirebase;
            document.head.appendChild(analyticsScript);
        };
        document.head.appendChild(appScript);
    }

    function initFirebase() {
        try {
            if (!window.firebase) return;
            if (!window.firebase.apps.length) window.firebase.initializeApp(FIREBASE_CONFIG);
            analytics = window.firebase.analytics();
            isReady = true;
            try { analytics.setUserProperties({ cdd_session_id: sessionId }); } catch (_) {}
        } catch (err) {
            console.warn('[Firebase Analytics] Init failed:', err.message);
        }
    }

    window.firebaseTrackEvent = function (eventName, params) {
        if (!isReady || !analytics) return;
        try {
            analytics.logEvent(eventName, Object.assign({}, params || {}, { cdd_session_id: sessionId }));
        } catch (err) {}
    };

    window.firebaseTrackScreen = function (screenName, screenClass) {
        if (!isReady || !analytics) return;
        try {
            const params = { firebase_screen: screenName, cdd_session_id: sessionId };
            if (screenClass) params.firebase_screen_class = screenClass;
            analytics.logEvent('screen_view', params);
        } catch (err) {}
    };

    window.firebaseSetUserProperties = function (properties) {
        if (!isReady || !analytics) return;
        try { analytics.setUserProperties(properties); } catch (err) {}
    };

    function loadOrderBoot() {
        if (!document.getElementById('orderForm')) return;
        if (document.querySelector('script[src$="order-boot.js"]')) return;
        const boot = document.createElement('script');
        boot.src = '../js/order-boot.js';
        document.head.appendChild(boot);
    }

    function init() {
        loadFirebase();
        loadOrderBoot();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
