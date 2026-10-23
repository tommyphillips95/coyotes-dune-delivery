/**
 * Coyote's Dune Delivery — Main Site JavaScript
 * Navigation, smooth scroll, chat widget, API helpers, order form
 */

(function() {
    'use strict';

    // ── Footer year (static fallback in the HTML) ───────────
    document.querySelectorAll('[data-current-year]').forEach(el => {
        el.textContent = String(new Date().getFullYear());
    });

    // ── Mobile Navigation ───────────────────────────────────
    const navToggle = document.getElementById('navToggle');
    const navMenu = document.getElementById('navMenu');

    function toggleNav() {
        if (!navMenu || !navToggle) return;
        navMenu.classList.toggle('active');
        navToggle.classList.toggle('active');
        const isOpen = navMenu.classList.contains('active');
        navToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    if (navToggle) {
        navToggle.addEventListener('click', toggleNav);
    }

    // Close nav when clicking a link
    document.querySelectorAll('.nav-menu a').forEach(link => {
        link.addEventListener('click', () => {
            if (navMenu && navMenu.classList.contains('active')) {
                toggleNav();
            }
        });
    });

    // Close nav on outside click
    document.addEventListener('click', (e) => {
        if (!navMenu || !navToggle) return;
        if (!navMenu.contains(e.target) && !navToggle.contains(e.target) && navMenu.classList.contains('active')) {
            toggleNav();
        }
    });

    // ── Navbar scroll effect ────────────────────────────────
    const navbar = document.getElementById('navbar');
    if (navbar) {
        window.addEventListener('scroll', () => {
            if (window.scrollY > 20) {
                navbar.style.boxShadow = '0 2px 16px rgba(44, 62, 80, 0.08)';
            } else {
                navbar.style.boxShadow = 'none';
            }
        });
    }

    // ── Smooth scroll for anchor links ──────────────────────
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            const targetId = this.getAttribute('href');
            if (targetId === '#') return;
            const target = document.querySelector(targetId);
            if (target) {
                e.preventDefault();
                const offset = 80; // navbar height
                const top = target.getBoundingClientRect().top + window.pageYOffset - offset;
                window.scrollTo({ top: top, behavior: 'smooth' });
            }
        });
    });

    // ── Chat Widget ─────────────────────────────────────────
    const chatWidget = document.getElementById('chatWidget');
    const chatToggle = document.getElementById('chatToggle');
    const chatPanel = document.getElementById('chatPanel');
    const chatInput = document.getElementById('chatInput');
    const chatSend = document.getElementById('chatSend');
    const chatBody = document.getElementById('chatBody');

    function toggleChat() {
        if (!chatWidget) return;
        chatWidget.classList.toggle('open');
        const isOpen = chatWidget.classList.contains('open');
        chatToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        if (isOpen && chatInput) {
            setTimeout(() => chatInput.focus(), 100);
        }
    }

    if (chatToggle) {
        chatToggle.addEventListener('click', toggleChat);
    }

    function addMessage(text, isUser) {
        if (!chatBody) return;
        const msg = document.createElement('div');
        msg.className = 'chat-message ' + (isUser ? 'chat-message-user' : 'chat-message-bot');
        msg.innerHTML = '<p>' + escapeHtml(text) + '</p>';
        chatBody.appendChild(msg);
        chatBody.scrollTop = chatBody.scrollHeight;
    }

    function sendChatMessage() {
        if (!chatInput) return;
        const text = chatInput.value.trim();
        if (!text) return;
        addMessage(text, true);
        chatInput.value = '';

        // Simple bot response
        setTimeout(() => {
            const response = getBotResponse(text);
            addMessage(response, false);
        }, 600 + Math.random() * 400);
    }

    function getBotResponse(input) {
        const lower = input.toLowerCase();
        if (lower.includes('apply') || lower.includes('driver') || lower.includes('job') || lower.includes('work')) {
            return 'You can apply to become a driver <a href="/apply/">here</a>. It takes about 10 minutes!';
        }
        if (lower.includes('pay') || lower.includes('money') || lower.includes('earn')) {
            return 'Drivers earn per delivery plus tips. Payouts go directly to your bank account every week.';
        }
        if (lower.includes('zone') || lower.includes('area') || lower.includes('deliver')) {
            return 'We currently serve Port Aransas and Padre Island, with Mustang Island coming soon!';
        }
        if (lower.includes('hour') || lower.includes('schedule') || lower.includes('time')) {
            return 'You set your own hours. No minimums, no penalties. Drive when it works for you.';
        }
        if (lower.includes('insurance') || lower.includes('cover')) {
            return 'You need valid auto insurance. We can help you verify your coverage during the application.';
        }
        if (lower.includes('order') || lower.includes('ride') || lower.includes('book') || lower.includes('delivery')) {
            return 'You can book a ride or delivery right on this page. Scroll up to the order form and fill in your details.';
        }
        if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) {
            return 'Hey there! How can we help you today?';
        }
        return 'Thanks for reaching out! For more specific questions, email us at <a href="mailto:support@coyotesdune.com">support@coyotesdune.com</a> or call (361) 555-1234.';
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    if (chatSend) chatSend.addEventListener('click', sendChatMessage);
    if (chatInput) {
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') sendChatMessage();
        });
    }

    // ── Intersection Observer for fade-in animations ───────
    const observerOptions = { threshold: 0.1, rootMargin: '0px 0px -40px 0px' };
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('fade-in-up');
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    document.querySelectorAll('.step-card, .benefit-card, .testimonial, .zone-card').forEach(el => {
        el.style.opacity = '0';
        observer.observe(el);
    });

    // ── Phone formatting (any page with #customerPhone) ─────
    // The legacy home-page order form (POST /api/submit-order with a
    // client-entered price) was removed: it also bound a second submit
    // handler to /order/'s #orderForm and could create duplicate orders.
    // All booking now goes through /order/ (order.js → /api/create-order).
    const customerPhone = document.getElementById('customerPhone');
    if (customerPhone) {
        customerPhone.addEventListener('input', function() {
            const digits = this.value.replace(/\D/g, '').slice(0, 10);
            if (digits.length === 10) {
                this.value = '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
            } else {
                this.value = digits;
            }
        });
    }

    // ── Analytics: Track "Order Now" CTA clicks ─────────────
    document.querySelectorAll('a[href="#order"], a[href="/order/"]').forEach(link => {
        link.addEventListener('click', () => {
            if (typeof trackEvent === 'function') {
                trackEvent('cta', 'click', 'order_now');
            }
            if (typeof firebaseTrackEvent === 'function') {
                firebaseTrackEvent('order_now_clicked');
            }
        });
    });

    // ── Analytics: Track driver application CTA clicks ──────
    document.querySelectorAll('a[href="/apply/"]').forEach(link => {
        link.addEventListener('click', () => {
            if (typeof trackEvent === 'function') {
                trackEvent('cta', 'click', 'driver_apply');
            }
            if (typeof firebaseTrackEvent === 'function') {
                firebaseTrackEvent('driver_apply_clicked');
            }
        });
    });

    // ── API Helper ──────────────────────────────────────────
    window.CoyoteAPI = {
        /**
         * Make an authenticated API request
         */
        async request(url, options = {}) {
            const defaults = {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
            };

            const token = localStorage.getItem('coyote_auth_token');
            if (token) {
                defaults.headers['Authorization'] = 'Bearer ' + token;
            }

            const config = Object.assign({}, defaults, options);
            config.headers = Object.assign({}, defaults.headers, options.headers || {});

            if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
                config.body = JSON.stringify(config.body);
            }

            // Optional timeout (order + payment calls): abort after timeoutMs and
            // report { status: 0, timedOut / offline } so callers can offer Retry.
            const timeoutMs = config.timeoutMs;
            delete config.timeoutMs;
            const C = window.CoyoteCoastal;
            try {
                if (timeoutMs && C && typeof C.isOffline === 'function' && C.isOffline()) {
                    const off = new Error('offline'); off.offline = true; off.network = true; throw off;
                }
                const response = (timeoutMs && C && typeof C.timedFetch === 'function')
                    ? await C.timedFetch(fetch, url, config, timeoutMs)
                    : await fetch(url, config);
                const contentType = response.headers.get('content-type') || '';
                let data = null;
                if (contentType.includes('application/json')) {
                    data = await response.json();
                } else {
                    data = await response.text();
                    // Functions that omit Content-Type still send JSON; parse it so
                    // callers get objects (e.g. create-order's orderId), not a string.
                    const t = typeof data === 'string' ? data.trim() : '';
                    if (t && (t[0] === '{' || t[0] === '[')) {
                        try { data = JSON.parse(t); } catch (_) { /* keep text */ }
                    }
                }

                if (!response.ok) {
                    // Our functions put the human message in `message` (e.g. weather hold) or
                    // `error` (400 validation); surface whichever is there.
                    const error = new Error((data && (data.message || data.error)) || 'Request failed');
                    error.status = response.status;
                    error.data = data;
                    throw error;
                }

                return { ok: true, data, status: response.status };
            } catch (err) {
                console.error('API request failed:', err);
                // Keep the JSON body (e.g. { code: "already_paid" }) so callers
                // can branch on machine-readable codes, not message text.
                return { ok: false, error: err.message, status: err.status || 0, data: err.data,
                    timedOut: !!err.timedOut, offline: !!err.offline, network: !!err.network || !err.status };
            }
        },

        /**
         * GET helper
         */
        async get(url, params) {
            let fullUrl = url;
            if (params) {
                const qs = new URLSearchParams(params).toString();
                fullUrl += (url.includes('?') ? '&' : '?') + qs;
            }
            return this.request(fullUrl, { method: 'GET' });
        },

        /**
         * POST helper
         */
        async post(url, body, opts) {
            return this.request(url, Object.assign({ method: 'POST', body: body }, opts || {}));
        },

        /**
         * POST with FormData (for file uploads)
         */
        async postForm(url, formData) {
            return this.request(url, {
                method: 'POST',
                body: formData,
                headers: { 'Content-Type': undefined }, // Let browser set multipart boundary
            });
        },

        /**
         * Set auth token
         */
        setToken(token) {
            if (token) {
                localStorage.setItem('coyote_auth_token', token);
            } else {
                localStorage.removeItem('coyote_auth_token');
            }
        },

        /**
         * Clear auth token
         */
        clearToken() {
            localStorage.removeItem('coyote_auth_token');
        },
    };

    // ── Utility helpers ─────────────────────────────────────
    window.CoyoteUtils = {
        /**
         * Debounce function calls
         */
        debounce(fn, delay) {
            let timer;
            return function(...args) {
                clearTimeout(timer);
                timer = setTimeout(() => fn.apply(this, args), delay);
            };
        },

        /**
         * Format currency
         */
        formatCurrency(amount, currency = 'USD') {
            return new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: currency,
            }).format(amount);
        },

        /**
         * Format date
         */
        formatDate(dateStr, options = {}) {
            const d = new Date(dateStr);
            return d.toLocaleDateString('en-US', Object.assign({
                year: 'numeric', month: 'short', day: 'numeric',
            }, options));
        },

        /**
         * Format phone number
         */
        formatPhone(raw) {
            const digits = raw.replace(/\D/g, '');
            if (digits.length === 10) {
                return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
            }
            return raw;
        },
    };

})();
