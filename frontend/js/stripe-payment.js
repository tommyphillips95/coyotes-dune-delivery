/**
 * Coyote's Dune Delivery — Stripe Payment Integration
 * Handles Stripe Elements card input, payment confirmation, and success/failure states.
 *
 * Flow:
 *   1. Order is submitted via submitOrder() → order created in Supabase
 *   2. Payment form is shown with Stripe Elements card input
 *   3. Customer enters card details and clicks "Pay Now"
 *   4. PaymentIntent is created via /api/create-payment-intent
 *   5. stripe.confirmCardPayment() is called with client_secret
 *   6. On success → order marked paid, success screen shown
 *   7. On failure → error message displayed, retry allowed
 */

(function () {
    'use strict';

    // ── Configuration ─────────────────────────────────────────
    // Prefer window.STRIPE_PUBLISHABLE_KEY (inline / Netlify snippet).
    // Otherwise fetch /api/public-config (Netlify env STRIPE_PUBLISHABLE_KEY).
    let STRIPE_PUBLISHABLE_KEY = window.STRIPE_PUBLISHABLE_KEY || '';

    async function ensurePublishableKey() {
        if (STRIPE_PUBLISHABLE_KEY) return STRIPE_PUBLISHABLE_KEY;
        try {
            const res = await fetch('/api/public-config');
            if (!res.ok) return '';
            const data = await res.json();
            STRIPE_PUBLISHABLE_KEY = data.stripePublishableKey || '';
            if (STRIPE_PUBLISHABLE_KEY) {
                window.STRIPE_PUBLISHABLE_KEY = STRIPE_PUBLISHABLE_KEY;
            }
            return STRIPE_PUBLISHABLE_KEY;
        } catch (err) {
            console.warn('Could not load Stripe publishable key from /api/public-config', err);
            return '';
        }
    }

    // ── State ─────────────────────────────────────────────────
    let stripe = null;
    let elements = null;
    let cardElement = null;
    let currentOrderId = null;
    let currentOrderNumber = null;
    let currentAmount = 0;
    let currentTrackingToken = null;

    // ── DOM References ────────────────────────────────────────
    const form = document.getElementById('orderForm');
    const formContainer = document.getElementById('formContainer');
    const progressBar = document.getElementById('progressBar');
    const orderSuccess = document.getElementById('orderSuccess');
    const submitBtn = document.getElementById('submitBtn');

    // Payment form container (injected after order submit)
    let paymentFormContainer = null;
    let paymentSubmitBtn = null;
    let paymentErrorDisplay = null;
    let paymentSpinner = null;

    // ── Load Stripe.js on demand (kept off the critical render path) ──
    const STRIPE_JS_URL = 'https://js.stripe.com/v3/';
    let stripeJsPromise = null;
    function loadStripeJs() {
        if (typeof Stripe !== 'undefined') return Promise.resolve(true);
        if (stripeJsPromise) return stripeJsPromise;
        stripeJsPromise = new Promise(function (resolve) {
            const s = document.createElement('script');
            // A stalled load (weak signal, captive Wi-Fi) fires neither onload
            // nor onerror. The order already exists by then, so give up after
            // the usual request timeout and show the confirmation (pay driver)
            // instead of leaving "Placing Order..." on screen forever.
            const C = window.CoyoteCoastal;
            const ms = C && C.requestTimeoutMs ? C.requestTimeoutMs() : 15000;
            let done = false;
            const settle = function (ok) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (!ok) stripeJsPromise = null;
                resolve(ok);
            };
            const timer = setTimeout(function () { settle(typeof Stripe !== 'undefined'); }, ms);
            s.src = STRIPE_JS_URL;
            s.async = true;
            s.onload = function () { settle(typeof Stripe !== 'undefined'); };
            s.onerror = function () { settle(false); };
            document.head.appendChild(s);
        });
        return stripeJsPromise;
    }
    // Warm it up on the customer's first interaction with the form, so the
    // payment step doesn't wait on the network but first paint never pays for it.
    (function warmStripeJsOnIntent() {
        const f = document.getElementById('orderForm');
        if (!f) return;
        const go = function () {
            f.removeEventListener('focusin', go);
            f.removeEventListener('pointerdown', go);
            loadStripeJs();
        };
        f.addEventListener('focusin', go);
        f.addEventListener('pointerdown', go);
    })();

    // ── Initialize Stripe ─────────────────────────────────────
    async function initStripe() {
        await ensurePublishableKey();
        if (!STRIPE_PUBLISHABLE_KEY) {
            console.warn('Stripe publishable key not configured. Set STRIPE_PUBLISHABLE_KEY in Netlify or window.STRIPE_PUBLISHABLE_KEY.');
            return false;
        }
        await loadStripeJs();
        if (typeof Stripe === 'undefined') {
            console.error('Stripe.js not loaded. Could not load https://js.stripe.com/v3/');
            return false;
        }
        try {
            stripe = Stripe(STRIPE_PUBLISHABLE_KEY);
            elements = stripe.elements();
            return true;
        } catch (err) {
            console.error('Failed to initialize Stripe:', err);
            return false;
        }
    }

    // ── Create Payment Form UI ──────────────────────────────
    function createPaymentForm() {
        // Remove any existing payment form
        const existing = document.getElementById('paymentFormContainer');
        if (existing) existing.remove();

        paymentFormContainer = document.createElement('div');
        paymentFormContainer.id = 'paymentFormContainer';
        paymentFormContainer.className = 'payment-form-container';
        paymentFormContainer.innerHTML = `
            <style>
                .payment-form-container {
                    background: var(--warm-white);
                    border: 1.5px solid var(--border);
                    border-radius: var(--radius-lg);
                    padding: 32px 28px;
                    margin-top: 24px;
                    animation: fadeInUp 0.4s ease;
                }
                .payment-form-container h2 {
                    font-family: var(--font-display);
                    font-size: 1.2rem;
                    color: var(--navy);
                    margin-bottom: 6px;
                }
                .payment-form-container .payment-subtitle {
                    color: var(--muted);
                    font-size: 0.9rem;
                    margin-bottom: 20px;
                }
                .payment-amount {
                    font-size: 1.5rem;
                    font-weight: 700;
                    color: var(--navy);
                    margin-bottom: 20px;
                    display: block;
                }
                .card-element-wrapper {
                    background: var(--pure-white);
                    border: 1.5px solid var(--border);
                    border-radius: var(--radius);
                    padding: 14px 16px;
                    margin-bottom: 16px;
                    transition: var(--transition);
                }
                .card-element-wrapper.StripeElement--focus {
                    border-color: var(--sand);
                    box-shadow: 0 0 0 3px rgba(201, 168, 124, 0.12);
                }
                .card-element-wrapper.StripeElement--invalid {
                    border-color: #C45A3E;
                }
                .payment-error {
                    color: #A84A31; /* was #C45A3E: 3.8:1 on the tinted box; 5.0:1 */
                    font-size: 0.85rem;
                    margin-bottom: 12px;
                    display: none;
                    padding: 8px 12px;
                    background: rgba(196, 90, 62, 0.06);
                    border-radius: var(--radius-sm);
                }
                .payment-error.visible { display: block; }
                .payment-actions {
                    display: flex;
                    gap: 12px;
                    align-items: center;
                    flex-wrap: wrap;
                }
                @media (max-width: 768px) {
                    .payment-actions {
                        position: sticky;
                        bottom: 0;
                        z-index: 6;
                        margin-left: -8px;
                        margin-right: -8px;
                        padding: 12px 8px calc(12px + env(safe-area-inset-bottom, 0px));
                        background: var(--pure-white);
                        border-top: 1px solid var(--border);
                        box-shadow: 0 -6px 16px rgba(44, 62, 80, 0.06);
                    }
                    .payment-actions .btn-pay, .payment-actions .btn-ghost { min-height: 48px; }
                }
                .payment-actions .btn {
                    flex: 1;
                    min-width: 140px;
                }
                .payment-actions .btn-pay {
                    background: var(--navy);
                    color: var(--pure-white);
                    border: none;
                    padding: 14px 28px;
                    font-size: 1rem;
                    font-weight: 600;
                    border-radius: var(--radius);
                    cursor: pointer;
                    transition: var(--transition);
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                }
                .payment-actions .btn-pay:hover {
                    background: var(--navy-light);
                }
                .payment-actions .btn-pay:disabled {
                    opacity: 0.6;
                    cursor: not-allowed;
                }
                .payment-actions .btn-ghost {
                    background: transparent;
                    color: var(--muted);
                    border: 1.5px solid var(--border);
                    padding: 14px 24px;
                    font-size: 0.95rem;
                    font-weight: 500;
                    border-radius: var(--radius);
                    cursor: pointer;
                    transition: var(--transition);
                }
                .payment-actions .btn-ghost:hover {
                    border-color: var(--sand);
                    color: var(--navy);
                }
                .payment-security-note {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-top: 16px;
                    font-size: 0.8rem;
                    color: var(--muted);
                }
                .payment-security-note svg {
                    flex-shrink: 0;
                    color: var(--sand);
                }
                .spinner {
                    width: 18px;
                    height: 18px;
                    border: 2px solid rgba(255,255,255,0.3);
                    border-top-color: #fff;
                    border-radius: 50%;
                    animation: spin 0.6s linear infinite;
                    display: inline-block;
                }
                @keyframes spin { to { transform: rotate(360deg); } }
            </style>
            <h2>Secure Payment</h2>
            <p class="payment-subtitle">Your card information is encrypted and secure.</p>
            <span class="payment-amount" id="paymentAmount">$0.00</span>
            <div class="card-element-wrapper" id="cardElement"></div>
            <div class="payment-error" id="paymentError" role="alert" aria-live="assertive"></div>
            <button type="button" class="btn btn-secondary cc-retry-btn" id="paymentRetryBtn" hidden>Retry</button>
            <p class="cc-sr-only" id="paymentStatusLive" role="status" aria-live="polite"></p>
            <div class="payment-actions">
                <button type="button" class="btn-pay" id="paymentSubmitBtn">
                    <span id="paymentBtnText">Pay Now</span>
                </button>
                <button type="button" class="btn-ghost" id="paymentCancelBtn">Pay Later</button>
            </div>
            <div class="payment-security-note">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                Secured by Stripe. We never store your card details.
            </div>
        `;

        // Insert after the form
        if (form && form.parentNode) {
            form.parentNode.insertBefore(paymentFormContainer, form.nextSibling);
        }

        // Mount Stripe card element
        const cardEl = document.getElementById('cardElement');
        if (cardEl && stripe && elements) {
            cardElement = elements.create('card', {
                style: {
                    base: {
                        fontSize: '16px',
                        color: '#2C3E50',
                        fontFamily: 'Inter, sans-serif',
                        '::placeholder': { color: '#9CA3AF' },
                    },
                    invalid: {
                        color: '#C45A3E',
                        iconColor: '#C45A3E',
                    },
                },
                hidePostalCode: false, // Show ZIP for AVS
            });
            cardElement.mount('#cardElement');
        }

        paymentSubmitBtn = document.getElementById('paymentSubmitBtn');
        paymentErrorDisplay = document.getElementById('paymentError');
        const retry = document.getElementById('paymentRetryBtn');
        if (retry) retry.addEventListener('click', handlePaymentSubmit);
        paymentSpinner = document.getElementById('paymentBtnText');

        // Bind events
        if (paymentSubmitBtn) {
            paymentSubmitBtn.addEventListener('click', handlePaymentSubmit);
        }

        const cancelBtn = document.getElementById('paymentCancelBtn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                // Skip payment — show success without payment
                showPaymentSkippedSuccess();
            });
        }
    }

    // ── Show Payment Skipped Success ────────────────────────
    function finish(ctx) {
        if (paymentFormContainer) paymentFormContainer.remove();
        if (window.CoyoteOrder && window.CoyoteOrder.showSuccess) {
            window.CoyoteOrder.showSuccess(Object.assign({ orderNumber: currentOrderNumber }, ctx));
            return;
        }
        if (form) form.style.display = 'none';
        if (progressBar) progressBar.style.display = 'none';
        orderSuccess.classList.add('active');
    }

    function showPaymentSkippedSuccess() {
        finish({
            title: 'Order Confirmed',
            message: 'Your driver will be assigned shortly. You can pay cash or card to the driver.',
        });
    }

    // ── Handle Payment Submit ───────────────────────────────
    let paying = false;

    async function handlePaymentSubmit() {
        if (paying) return; // no double charges from double clicks
        if (!stripe || !cardElement) {
            showPaymentError('Payment system is not initialized. Please refresh the page.');
            return;
        }

        if (!currentOrderId || !currentAmount) {
            showPaymentError('Order information is missing. Please start over.');
            return;
        }

        paying = true;
        setPaymentLoading(true);
        clearPaymentError();
        const C = window.CoyoteCoastal;
        const retryBtn = document.getElementById('paymentRetryBtn');
        const live = document.getElementById('paymentStatusLive');
        const say = (t) => { if (live) live.textContent = t || ''; };
        if (retryBtn) retryBtn.disabled = true;
        say('Setting up your payment…');

        try {
            // 1. Create PaymentIntent on the server. Safe to retry: #53's
            //    create-payment-intent reuses/updates the open PaymentIntent and
            //    answers 409 already_paid / payment_processing instead of charging twice.
            const customerEmail = document.getElementById('customerEmail')?.value?.trim() || '';
            const piResult = await CoyoteAPI.post('/api/create-payment-intent', {
                order_id: currentOrderId,
                amount: currentAmount,
                customer_email: customerEmail,
                // Proof this is the customer's order: the phone on the form,
                // plus the order's tracking token when we have one.
                phone: document.getElementById('customerPhone')?.value?.trim() || '',
            }, { timeoutMs: C && C.requestTimeoutMs ? C.requestTimeoutMs() : 15000, headers: paymentAuthHeaders() });

            const netKind = C && C.networkFailureKind ? C.networkFailureKind(piResult) : null;
            if (netKind) {
                showPaymentError(C.paymentNetworkMessage(netKind));
                if (retryBtn) retryBtn.hidden = false;
                say('');
                return;
            }
            if (C && C.paymentServerBusy && C.paymentServerBusy(piResult)) {
                showPaymentError(C.paymentBusyMessage());
                if (retryBtn) retryBtn.hidden = false;
                say('');
                return;
            }
            if (retryBtn) retryBtn.hidden = true;

            // 409 + code: the order must not be charged again (#53).
            const conflict = window.CoyoteCoastal ? window.CoyoteCoastal.paymentConflictKind(piResult) : null;
            if (conflict === 'already_paid') { showAlreadyPaid(); return; }
            if (conflict === 'payment_processing') { showPaymentProcessing(); return; }
            if (conflict === 'order_closed') { showOrderClosed(piResult); return; }

            if (!piResult.ok || !piResult.data?.client_secret) {
                throw new Error(piResult.data?.error || piResult.error || 'Failed to initialize payment');
            }

            const clientSecret = piResult.data.client_secret;

            say('Confirming your card…');
            // 2. Confirm the card payment with Stripe.js
            const { error: confirmError, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
                payment_method: {
                    card: cardElement,
                    billing_details: {
                        name: `${document.getElementById('customerFirstName')?.value || ''} ${document.getElementById('customerLastName')?.value || ''}`.trim(),
                        email: customerEmail,
                        phone: document.getElementById('customerPhone')?.value?.trim() || '',
                    },
                },
            });

            if (confirmError) {
                // Card was declined or there was an error. Never re-run
                // confirmCardPayment automatically; a connection error offers
                // Retry, which starts again at create-payment-intent (#53 checks
                // whether the order is already paid/processing before charging).
                if (confirmError.type === 'api_connection_error' && C) {
                    showPaymentError(C.paymentNetworkMessage(C.isOffline() ? 'offline' : 'network'));
                    if (retryBtn) retryBtn.hidden = false;
                    say('');
                    return;
                }
                throw new Error(confirmError.message);
            }

            if (paymentIntent.status === 'succeeded') {
                showPaymentSuccess();
            } else if (paymentIntent.status === 'processing') {
                // Bank still confirming; the webhook marks it paid.
                showPaymentProcessing();
            } else if (paymentIntent.status === 'requires_action') {
                // confirmCardPayment normally completes 3DS itself; if we still
                // see requires_action, offer Retry (re-enters create-payment-intent,
                // which checks already_paid / processing before charging again).
                showPaymentError('Additional authentication is required. Please check your bank app or email.');
                if (retryBtn) retryBtn.hidden = false;
                say('');
                return;
            } else {
                // Never surface the raw Stripe status string (e.g. requires_payment_method).
                console.error('Unexpected PaymentIntent status:', paymentIntent && paymentIntent.status);
                showPaymentError('We couldn\'t finish this payment. Try again or use a different card.');
                if (retryBtn) retryBtn.hidden = false;
                say('');
                return;
            }

        } catch (err) {
            console.error('Payment failed:', err);
            say('');
            showPaymentError(err.message || 'Payment failed. Please try again or use a different card.');
        } finally {
            paying = false;
            setPaymentLoading(false);
            if (retryBtn) retryBtn.disabled = false;
            // Disabling the button while paying drops keyboard focus to <body>;
            // put it back so keyboard users can retry after a decline.
            if (paymentSubmitBtn && paymentSubmitBtn.isConnected && (!document.activeElement || document.activeElement === document.body)) {
                paymentSubmitBtn.focus();
            }
        }
    }

    // ── Show Payment Success ────────────────────────────────
    function showPaymentSuccess() {
        finish({
            title: 'Payment Successful!',
            message: 'Your driver will be assigned shortly.',
            paid: true,
        });
        const successPs = orderSuccess.querySelectorAll('p');
        if (successPs[0]) {
            successPs[0].textContent = 'Thank you for your payment. Your order is confirmed.';
        }

        // Add payment badge
        const orderIdDiv = document.getElementById('orderIdDisplay');
        if (orderIdDiv) {
            orderIdDiv.insertAdjacentHTML('afterend', `
                <div style="margin-top: 12px; color: #3A7550; font-weight: 600; font-size: 0.95rem;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 6px;">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                        <polyline points="22 4 12 14.01 9 11.01"/>
                    </svg>
                    Paid $${currentAmount.toFixed(2)}
                </div>
            `);
        }

        orderSuccess.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ── Already paid / processing screens (#53 409 codes) ──
    function focusHeading(el) {
        if (!el) return;
        el.setAttribute('tabindex', '-1');
        try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
    }

    function trackUrl() {
        return window.CoyoteCoastal && currentOrderNumber
            ? window.CoyoteCoastal.buildTrackUrl(currentOrderNumber)
            : '/track/';
    }

    function showAlreadyPaid(title) {
        const panel = document.getElementById('paymentStatusPanel');
        if (panel) panel.remove();
        finish({
            title: title || 'Already Paid',
            paid: true,
            message: "This order is already paid, so you won't be charged again. Your driver will be assigned shortly.",
        });
        const ps = orderSuccess.querySelectorAll('p');
        if (ps[0]) ps[0].textContent = 'Thank you! Your payment went through.';
        orderSuccess.setAttribute('data-payment-state', 'already_paid');
        focusHeading(orderSuccess.querySelector('h2'));
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function showPaymentProcessing() {
        if (paymentFormContainer) paymentFormContainer.remove();
        const old = document.getElementById('paymentStatusPanel');
        if (old) old.remove();
        if (form) form.style.display = 'none';
        if (progressBar) progressBar.style.display = 'none';

        const panel = document.createElement('section');
        panel.id = 'paymentStatusPanel';
        panel.className = 'payment-status-panel';
        panel.setAttribute('aria-labelledby', 'paymentStatusTitle');
        panel.setAttribute('data-payment-state', 'payment_processing');
        panel.innerHTML = `
            <style>
                .payment-status-panel {
                    background: var(--warm-white);
                    border: 1.5px solid var(--border);
                    border-radius: var(--radius-lg);
                    padding: 32px 24px;
                    margin-top: 24px;
                    text-align: center;
                    animation: fadeInUp 0.4s ease;
                }
                .payment-status-panel h2 {
                    font-family: var(--font-display);
                    color: var(--navy);
                    font-size: 1.4rem;
                    margin: 12px 0 8px;
                }
                .payment-status-panel h2:focus { outline: none; }
                .payment-status-panel p { color: var(--muted); margin-bottom: 12px; }
                .payment-status-panel .status-icon {
                    width: 56px; height: 56px; margin: 0 auto;
                    border-radius: 50%;
                    display: flex; align-items: center; justify-content: center;
                    background: rgba(201, 168, 124, 0.15); color: var(--sand);
                }
                .payment-status-panel .order-id { margin: 8px 0 16px; }
                .payment-status-panel .payment-status-msg { color: var(--navy); font-weight: 500; min-height: 1.5em; }
                .payment-status-panel .status-actions {
                    display: flex; flex-direction: column; gap: 12px; margin-top: 8px;
                }
                .payment-status-panel .status-actions .btn,
                .payment-status-panel .status-actions button {
                    min-height: 48px; width: 100%; font-size: 1rem;
                }
                .payment-status-panel .btn-check {
                    background: var(--navy); color: var(--pure-white); border: none;
                    border-radius: var(--radius); font-weight: 600; cursor: pointer;
                }
                .payment-status-panel .btn-check:disabled { opacity: 0.6; cursor: not-allowed; }
                @media (min-width: 560px) {
                    .payment-status-panel .status-actions { flex-direction: row; }
                    .payment-status-panel .status-actions > * { flex: 1; }
                }
            </style>
            <div class="status-icon" aria-hidden="true">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
            </div>
            <h2 id="paymentStatusTitle">Payment Processing</h2>
            <p>Your bank is still confirming this payment. <strong>Please don't pay again.</strong> This usually takes a minute or two.</p>
            <div class="order-id" id="paymentStatusOrder"></div>
            <p class="payment-status-msg" id="paymentStatusMsg" role="status" aria-live="polite"></p>
            <div class="status-actions">
                <button type="button" class="btn-check" id="paymentCheckBtn">Check payment status</button>
                <a class="btn btn-secondary" id="paymentStatusTrack" href="/track/">Track this order</a>
            </div>
        `;
        if (form && form.parentNode) form.parentNode.insertBefore(panel, form.nextSibling);
        panel.querySelector('#paymentStatusOrder').textContent = currentOrderNumber || '';
        panel.querySelector('#paymentStatusTrack').href = trackUrl();
        panel.querySelector('#paymentCheckBtn').addEventListener('click', checkPaymentStatus);
        focusHeading(panel.querySelector('h2'));
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Cancelled / refunded while the customer is still on Pay Now (#53 sibling).
    // Card form must go away — tapping Pay again only re-hits the same 409.
    function showOrderClosed(piResult) {
        if (paymentFormContainer) paymentFormContainer.remove();
        const old = document.getElementById('paymentStatusPanel');
        if (old) old.remove();
        if (form) form.style.display = 'none';
        if (progressBar) progressBar.style.display = 'none';

        const reason = piResult && piResult.data && piResult.data.reason;
        const copy = window.CoyoteCoastal && window.CoyoteCoastal.orderClosedScreen
            ? window.CoyoteCoastal.orderClosedScreen(reason)
            : { title: 'Order Cancelled', message: "This order was cancelled, so it can't be paid." };
        const serverMsg = piResult && piResult.data && typeof piResult.data.error === 'string'
            ? piResult.data.error
            : null;
        const message = serverMsg || copy.message;

        const panel = document.createElement('section');
        panel.id = 'paymentStatusPanel';
        panel.className = 'payment-status-panel';
        panel.setAttribute('aria-labelledby', 'paymentStatusTitle');
        panel.setAttribute('data-payment-state', 'order_closed');
        panel.innerHTML = `
            <style>
                .payment-status-panel {
                    background: var(--warm-white);
                    border: 1.5px solid var(--border);
                    border-radius: var(--radius-lg);
                    padding: 32px 24px;
                    margin-top: 24px;
                    text-align: center;
                    animation: fadeInUp 0.4s ease;
                }
                .payment-status-panel h2 {
                    font-family: var(--font-display);
                    color: var(--navy);
                    font-size: 1.4rem;
                    margin: 12px 0 8px;
                }
                .payment-status-panel h2:focus { outline: none; }
                .payment-status-panel p { color: var(--muted); margin-bottom: 12px; }
                .payment-status-panel .status-icon {
                    width: 56px; height: 56px; margin: 0 auto;
                    border-radius: 50%;
                    display: flex; align-items: center; justify-content: center;
                    background: rgba(201, 168, 124, 0.15); color: var(--sand);
                }
                .payment-status-panel .order-id { margin: 8px 0 16px; }
                .payment-status-panel .status-actions {
                    display: flex; flex-direction: column; gap: 12px; margin-top: 8px;
                }
                .payment-status-panel .status-actions .btn {
                    min-height: 48px; width: 100%; font-size: 1rem;
                }
                @media (min-width: 560px) {
                    .payment-status-panel .status-actions { flex-direction: row; }
                    .payment-status-panel .status-actions > * { flex: 1; }
                }
            </style>
            <div class="status-icon" aria-hidden="true">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
            </div>
            <h2 id="paymentStatusTitle"></h2>
            <p class="payment-status-msg" id="paymentStatusMsg" role="status" aria-live="polite"></p>
            <div class="order-id" id="paymentStatusOrder"></div>
            <div class="status-actions">
                <a class="btn btn-secondary" id="paymentStatusTrack" href="/track/">Track this order</a>
            </div>
        `;
        if (form && form.parentNode) form.parentNode.insertBefore(panel, form.nextSibling);
        panel.querySelector('#paymentStatusTitle').textContent = copy.title;
        panel.querySelector('#paymentStatusMsg').textContent = message;
        panel.querySelector('#paymentStatusOrder').textContent = currentOrderNumber || '';
        panel.querySelector('#paymentStatusTrack').href = trackUrl();
        focusHeading(panel.querySelector('h2'));
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Read-only: looks at the order (customer tracking token), never creates
    // or touches a payment.
    let checking = false;
    async function checkPaymentStatus() {
        if (checking) return;
        const msg = document.getElementById('paymentStatusMsg');
        const btn = document.getElementById('paymentCheckBtn');
        const say = (t) => { if (msg) msg.textContent = t; };
        if (!currentTrackingToken) {
            say('Use "Track this order" to see the latest status.');
            return;
        }
        checking = true;
        if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }
        say('');
        try {
            const result = await CoyoteAPI.request('/api/get-orders', {
                method: 'GET',
                headers: { Authorization: 'Bearer ' + currentTrackingToken },
            });
            const rows = result.ok && result.data ? result.data.data : null;
            const order = Array.isArray(rows) ? rows[0] : rows;
            if (!order) {
                say("We couldn't check right now. Try again in a moment, or use Track this order.");
                return;
            }
            const kind = window.CoyoteCoastal ? window.CoyoteCoastal.paymentStatusKind(order) : 'processing';
            if (kind === 'paid') { showAlreadyPaid('Payment Confirmed'); return; }
            if (kind === 'failed') {
                say("This payment didn't go through, and you haven't been charged twice. You can pay your driver in cash or card.");
                return;
            }
            say('Still processing. Please check again in a minute. No need to pay again.');
        } catch (err) {
            say("We couldn't check right now. Try again in a moment, or use Track this order.");
        } finally {
            checking = false;
            if (btn && document.body.contains(btn)) { btn.disabled = false; btn.textContent = 'Check payment status'; }
        }
    }

    // ── Payment UI Helpers ──────────────────────────────────
    function showPaymentError(message) {
        if (paymentErrorDisplay) {
            paymentErrorDisplay.textContent = message;
            paymentErrorDisplay.classList.add('visible');
        }
    }

    function clearPaymentError() {
        if (paymentErrorDisplay) {
            paymentErrorDisplay.textContent = '';
            paymentErrorDisplay.classList.remove('visible');
        }
    }

    function setPaymentLoading(isLoading) {
        if (paymentSubmitBtn) {
            paymentSubmitBtn.disabled = isLoading;
        }
        // Pay Later must not fire mid-confirm (would show cash success while Stripe is still working).
        const cancelBtn = document.getElementById('paymentCancelBtn');
        if (cancelBtn) cancelBtn.disabled = isLoading;
        if (paymentSpinner) {
            paymentSpinner.innerHTML = isLoading
                ? '<span class="spinner"></span> Processing...'
                : 'Pay Now';
        }
    }

    // ── Checkout hook ───────────────────────────────────────
    // order.js creates the order exactly once (POST /api/create-order) and
    // then calls CoyoteCheckout.afterOrderCreated(ctx). We only add the card
    // step; the charge amount is re-derived server-side from
    // orders.estimated_price in /api/create-payment-intent.
    // (Previously this file cloned #orderForm to strip listeners, which also
    //  broke order.js step/price handlers and the live estimate.)
    // The tracking token for this order: from create-order, or the one saved
    // on this device (a reload or the "first order went through" panel).
    function paymentAuthToken() {
        if (currentTrackingToken) return currentTrackingToken;
        const C = window.CoyoteCoastal;
        return C && C.getTrackingToken && currentOrderNumber ? C.getTrackingToken(currentOrderNumber) : null;
    }
    function paymentAuthHeaders() {
        const t = paymentAuthToken();
        return t ? { Authorization: 'Bearer ' + t } : {};
    }

    async function afterOrderCreated(ctx) {
        currentOrderId = ctx.orderId;
        currentOrderNumber = ctx.orderNumber;
        currentAmount = Number(ctx.amount) || 0;
        currentTrackingToken = ctx.trackingToken || null;
        const idEl = document.getElementById('orderIdDisplay');
        if (idEl) idEl.textContent = currentOrderNumber;
        if (!currentOrderId || !currentAmount) return false;
        if (!(await initStripe())) return false; // no publishable key → pay driver
        if (form) form.style.display = 'none';
        if (progressBar) progressBar.style.display = 'none';
        const quoteBox = document.getElementById('ccLiveQuote');
        if (quoteBox) quoteBox.hidden = true;
        createPaymentForm();
        const amt = document.getElementById('paymentAmount');
        if (amt) amt.textContent = `$${currentAmount.toFixed(2)}`;
        // The Place Order button is gone: move focus to the card step's heading
        // so keyboard and screen reader users land on it (not <body>).
        focusHeading(paymentFormContainer && paymentFormContainer.querySelector('h2'));
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return true;
    }

    window.CoyoteCheckout = { afterOrderCreated: afterOrderCreated };
})();
