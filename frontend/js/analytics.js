/**
 * Coyote's Dune Delivery — Google Analytics 4 Integration
 * Tracks page views and custom events across the site.
 *
 * Setup:
 * 1. Create a GA4 property at https://analytics.google.com
 * 2. Copy your Measurement ID (G-XXXXXXXXXX)
 * 3. Set GA4_MEASUREMENT_ID in Netlify environment variables
 * 4. The script auto-loads and tracks page views
 *
 * Usage:
 *   trackEvent('order', 'submitted', 'ride', 25.00);
 *   trackConversion('purchase', { value: 25.00, currency: 'USD' });
 *   trackPageView('/order/success');
 *   logAnalyticsEvent('order_submitted', { service_type: 'ride', price: 25 });
 */

(function () {
    'use strict';

    // ── Configuration ───────────────────────────────────────
    const MEASUREMENT_ID = window.__GA4_ID__ || 'G-XXXXXXXXXX'; // placeholder

    // ── Session ID (persists for 30 min, shared with Firebase) ──
    const SESSION_KEY = 'cdd_analytics_session';
    const SESSION_DURATION_MS = 30 * 60 * 1000; // 30 minutes

    function getOrCreateSessionId() {
        try {
            const raw = sessionStorage.getItem(SESSION_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                if (data.expires && Date.now() < data.expires) {
                    // Extend session
                    data.expires = Date.now() + SESSION_DURATION_MS;
                    sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
                    return data.id;
                }
            }
        } catch (_) { /* ignore */ }
        const id = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
        try {
            sessionStorage.setItem(SESSION_KEY, JSON.stringify({
                id,
                expires: Date.now() + SESSION_DURATION_MS,
            }));
        } catch (_) { /* ignore */ }
        return id;
    }

    const sessionId = getOrCreateSessionId();
    // Expose for Firebase and other scripts
    window.__CDD_SESSION_ID__ = sessionId;

    // ── Load GA4 Script ─────────────────────────────────────
    function loadGA4() {
        if (window.gtag && window.dataLayer) return; // already loaded

        window.dataLayer = window.dataLayer || [];
        function gtag() { window.dataLayer.push(arguments); }
        window.gtag = gtag;

        gtag('js', new Date());
        gtag('config', MEASUREMENT_ID, {
            send_page_view: true,
            cookie_flags: 'SameSite=None;Secure',
        });

        const script = document.createElement('script');
        script.async = true;
        script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(MEASUREMENT_ID);
        document.head.appendChild(script);
    }

    // ── Public API ──────────────────────────────────────────

    /**
     * Track a custom event.
     * @param {string} category   — event category (e.g. 'order', 'driver', 'admin')
     * @param {string} action     — event action (e.g. 'submitted', 'login')
     * @param {string} [label]    — optional label
     * @param {number} [value]    — optional numeric value
     */
    window.trackEvent = function (category, action, label, value) {
        if (!window.gtag) {
            console.warn('[Analytics] gtag not ready');
            return;
        }
        const params = {
            event_category: category,
            event_action: action,
            session_id: sessionId,
        };
        if (label !== undefined) params.event_label = String(label);
        if (value !== undefined && !isNaN(value)) params.value = Number(value);

        window.gtag('event', action, params);
    };

    /**
     * Track a conversion / key business event.
     * @param {string} eventName  — GA4 event name (e.g. 'purchase', 'generate_lead')
     * @param {Object} [params]   — additional parameters
     */
    window.trackConversion = function (eventName, params) {
        if (!window.gtag) {
            console.warn('[Analytics] gtag not ready');
            return;
        }
        const payload = Object.assign({}, params || {}, { session_id: sessionId });
        window.gtag('event', eventName, payload);
    };

    /**
     * Track a page view manually (SPA navigation, etc.)
     * @param {string} [pagePath] — optional path override
     * @param {string} [pageTitle] — optional title override
     */
    window.trackPageView = function (pagePath, pageTitle) {
        if (!window.gtag) {
            console.warn('[Analytics] gtag not ready');
            return;
        }
        const config = { send_page_view: true, session_id: sessionId };
        if (pagePath) config.page_path = pagePath;
        if (pageTitle) config.page_title = pageTitle;
        window.gtag('config', MEASUREMENT_ID, config);
    };

    /**
     * Log an analytics event to the server-side analytics_events table.
     * Non-blocking — fires and forgets.
     * @param {string} eventName
     * @param {Object} [metadata]
     * @param {string} [userId]
     */
    window.logAnalyticsEvent = function (eventName, metadata, userId) {
        const payload = {
            event_name: eventName,
            category: (metadata && metadata.category) || 'general',
            user_id: userId || null,
            session_id: sessionId,
            metadata: metadata || {},
        };

        // Fire to server-side logger if available
        if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
            try {
                navigator.sendBeacon('/api/log-analytics-event', JSON.stringify(payload));
            } catch (_) {
                // Fallback to fetch
                fetchPostLog(payload);
            }
        } else {
            fetchPostLog(payload);
        }
    };

    function fetchPostLog(payload) {
        try {
            fetch('/api/log-analytics-event', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                keepalive: true,
            }).catch(() => {});
        } catch (_) { /* ignore */ }
    }

    // ── Auto-track outbound links ───────────────────────────
    function trackOutboundLinks() {
        document.addEventListener('click', function (e) {
            const link = e.target.closest('a[href^="http"]');
            if (!link) return;
            if (link.hostname === location.hostname) return;

            trackEvent('outbound', 'click', link.href);
        });
    }

    // ── Auto-track CTA clicks ───────────────────────────────
    function trackCTAClicks() {
        document.addEventListener('click', function (e) {
            const btn = e.target.closest('[data-track]');
            if (!btn) return;
            const eventData = btn.dataset.track;
            try {
                const data = JSON.parse(eventData);
                trackEvent(data.category || 'cta', data.action || 'click', data.label, data.value);
            } catch (_) {
                trackEvent('cta', 'click', eventData);
            }
        });
    }

    // ── Initialize ──────────────────────────────────────────
    function init() {
        loadGA4();
        trackOutboundLinks();
        trackCTAClicks();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
