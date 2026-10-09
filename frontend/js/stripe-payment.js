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

    // ── Initialize Stripe ─────────────────────────────────────
    async function initStripe() {
        await ensurePublishableKey();
        if (!STRIPE_PUBLISHABLE_KEY) {
            console.warn('Stripe publishable key not configured. Set STRIPE_PUBLISHABLE_KEY in Netlify or window.STRIPE_PUBLISHABLE_KEY.');
            return false;
        }
        if (typeof Stripe === 'undefined') {
            console.error('Stripe.js not loaded. Include https://js.stripe.com/v3/ before stripe-payment.js');
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
                .payment-form-container h3 {
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
                    color: #C45A3E;
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
            <h3>Secure Payment</h3>
            <p class="payment-subtitle">Your card information is encrypted and secure.</p>
            <span class="payment-amount" id="paymentAmount">$0.00</span>
            <div class="card-element-wrapper" id="cardElement"></div>
            <div class="payment-error" id="paymentError"></div>
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

        try {
            // 1. Create PaymentIntent on the server
            const customerEmail = document.getElementById('customerEmail')?.value?.trim() || '';
            const piResult = await CoyoteAPI.post('/api/create-payment-intent', {
                order_id: currentOrderId,
                amount: currentAmount,
                customer_email: customerEmail,
            });

            if (!piResult.ok || !piResult.data?.client_secret) {
                throw new Error(piResult.data?.error || piResult.error || 'Failed to initialize payment');
            }

            const clientSecret = piResult.data.client_secret;

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
                // Card was declined or there was an error
                throw new Error(confirmError.message);
            }

            if (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing') {
                // processing = bank still confirming; the webhook marks it paid.
                showPaymentSuccess();
            } else if (paymentIntent.status === 'requires_action') {
                // 3D Secure or additional authentication required
                // Stripe.js handles this automatically in confirmCardPayment
                showPaymentError('Additional authentication is required. Please check your bank app or email.');
            } else {
                throw new Error(`Payment status: ${paymentIntent.status}`);
            }

        } catch (err) {
            console.error('Payment failed:', err);
            showPaymentError(err.message || 'Payment failed. Please try again or use a different card.');
        } finally {
            paying = false;
            setPaymentLoading(false);
        }
    }

    // ── Show Payment Success ────────────────────────────────
    function showPaymentSuccess() {
        finish({
            title: 'Payment Successful!',
            message: 'Your driver will be assigned shortly. You will receive a confirmation text and email with driver details.',
        });
        const successPs = orderSuccess.querySelectorAll('p');
        if (successPs[0]) {
            successPs[0].textContent = 'Thank you for your payment. Your order is confirmed.';
        }

        // Add payment badge
        const orderIdDiv = document.getElementById('orderIdDisplay');
        if (orderIdDiv) {
            orderIdDiv.insertAdjacentHTML('afterend', `
                <div style="margin-top: 12px; color: #4C8C64; font-weight: 600; font-size: 0.95rem;">
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
    async function afterOrderCreated(ctx) {
        currentOrderId = ctx.orderId;
        currentOrderNumber = ctx.orderNumber;
        currentAmount = Number(ctx.amount) || 0;
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
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return true;
    }

    window.CoyoteCheckout = { afterOrderCreated: afterOrderCreated };
})();
