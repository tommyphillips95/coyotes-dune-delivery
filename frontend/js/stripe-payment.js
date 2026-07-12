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
    // Stripe publishable key is loaded from a global set by the backend or inline
    const STRIPE_PUBLISHABLE_KEY = window.STRIPE_PUBLISHABLE_KEY || '';

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
    function initStripe() {
        if (!STRIPE_PUBLISHABLE_KEY) {
            console.warn('Stripe publishable key not configured. Payment form will not be available.');
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
    function showPaymentSkippedSuccess() {
        if (paymentFormContainer) paymentFormContainer.remove();
        if (form) form.style.display = 'none';
        if (progressBar) progressBar.style.display = 'none';

        // Update success message for unpaid
        const successTitle = orderSuccess.querySelector('h2');
        if (successTitle) successTitle.textContent = 'Order Confirmed';

        const successPs = orderSuccess.querySelectorAll('p');
        if (successPs[1]) {
            successPs[1].textContent = 'Your driver will be assigned shortly. You can pay cash or card to the driver.';
        }

        orderSuccess.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ── Handle Payment Submit ───────────────────────────────
    async function handlePaymentSubmit() {
        if (!stripe || !cardElement) {
            showPaymentError('Payment system is not initialized. Please refresh the page.');
            return;
        }

        if (!currentOrderId || !currentAmount) {
            showPaymentError('Order information is missing. Please start over.');
            return;
        }

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

            if (paymentIntent.status === 'succeeded') {
                // Payment succeeded!
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
            setPaymentLoading(false);
        }
    }

    // ── Show Payment Success ────────────────────────────────
    function showPaymentSuccess() {
        if (paymentFormContainer) paymentFormContainer.remove();
        if (form) form.style.display = 'none';
        if (progressBar) progressBar.style.display = 'none';

        // Update success message for paid
        const successTitle = orderSuccess.querySelector('h2');
        if (successTitle) successTitle.textContent = 'Payment Successful!';

        const successPs = orderSuccess.querySelectorAll('p');
        if (successPs[0]) {
            successPs[0].textContent = 'Thank you for your payment. Your order is confirmed.';
        }
        if (successPs[1]) {
            successPs[1].textContent = 'Your driver will be assigned shortly. You will receive a confirmation text and email with driver details.';
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

    // ── Override submitOrder to show payment form ───────────
    // We intercept the original submitOrder flow from order.js
    // After the order is created, we show the payment form instead of the success screen

    const originalSubmitOrder = window.submitOrder;

    async function submitOrderWithPayment(e) {
        e.preventDefault();

        const terms = document.getElementById('termsAgree');
        if (!terms.checked) {
            terms.focus();
            return;
        }

        submitBtn.disabled = true;
        const originalText = submitBtn.textContent;
        submitBtn.innerHTML = '<span class="spinner"></span> Placing Order...';

        const serviceType = document.querySelector('input[name="serviceType"]:checked').value;
        const dateVal = document.getElementById('serviceDate').value;
        const timeVal = document.getElementById('serviceTime').value;
        const now = new Date();
        const isAsap = new Date(`${dateVal}T${timeVal}`) <= new Date(now.getTime() + 60 * 60 * 1000);

        const orderData = {
            first_name: document.getElementById('customerFirstName').value.trim(),
            last_name: document.getElementById('customerLastName').value.trim(),
            phone: document.getElementById('customerPhone').value.trim(),
            email: document.getElementById('customerEmail').value.trim() || null,
            service_type: serviceType,
            pickup_address: document.getElementById('pickupAddress').value.trim(),
            pickup_city: document.getElementById('pickupCity').value,
            pickup_zip: document.getElementById('pickupZip').value.trim() || null,
            dropoff_address: document.getElementById('dropoffAddress').value.trim() || null,
            dropoff_city: document.getElementById('dropoffCity').value || null,
            dropoff_zip: document.getElementById('dropoffZip').value.trim() || null,
            schedule: isAsap ? 'asap' : 'later',
            scheduled_date: isAsap ? null : dateVal,
            scheduled_time: isAsap ? null : timeVal,
            passenger_count: serviceType === 'ride'
                ? parseInt(document.querySelector('input[name="passengers"]:checked').value)
                : null,
            package_size: serviceType === 'package_delivery'
                ? document.querySelector('input[name="packageSize"]:checked').value
                : null,
            package_description: document.getElementById('itemDescription')?.value.trim() || null,
            special_instructions: document.getElementById('specialInstructions').value.trim() || null,
        };

        try {
            const result = await CoyoteAPI.post('/api/create-order', orderData);

            if (result.ok) {
                currentOrderId = result.data.orderId;
                currentOrderNumber = result.data.orderNumber;
                currentAmount = result.data.estimatedPrice || 0;

                // Store order in localStorage
                try {
                    const orders = JSON.parse(localStorage.getItem('cdd_orders') || '[]');
                    orders.push({
                        orderNumber: currentOrderNumber,
                        orderId: currentOrderId,
                        createdAt: new Date().toISOString(),
                        serviceType: orderData.service_type,
                    });
                    localStorage.setItem('cdd_orders', JSON.stringify(orders));
                } catch (_) { /* ignore */ }

                // Hide the order form, show payment form
                form.style.display = 'none';
                progressBar.style.display = 'none';

                // Update order ID display for when payment succeeds
                document.getElementById('orderIdDisplay').textContent = currentOrderNumber;

                // Initialize Stripe and show payment form
                if (initStripe()) {
                    createPaymentForm();
                    document.getElementById('paymentAmount').textContent = `$${currentAmount.toFixed(2)}`;
                } else {
                    // Stripe not configured — show skip-to-success
                    showPaymentSkippedSuccess();
                }

                window.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                alert('Failed to place order: ' + (result.error || result.data?.message || 'Unknown error'));
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalText;
            }
        } catch (err) {
            console.error('Order submission failed:', err);
            alert('Something went wrong. Please try again or call (361) 555-1234.');
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalText;
        }
    }

    // ── Hook into the order form ────────────────────────────
    // Replace the original submit handler from order.js
    // We do this by removing the old listener and adding our new one
    function hookPaymentIntoOrderForm() {
        if (!form) return;

        // Clone the form to remove all existing listeners, then re-add ours
        const newForm = form.cloneNode(true);
        form.parentNode.replaceChild(newForm, form);

        // Re-bind all the original order.js step navigation
        // (The order.js IIFE already bound these, but since we cloned,
        //  we need to re-initialize. However, the order.js IIFE runs
        //  on DOMContentLoaded and binds to elements by ID. Since we
        //  cloned, the new form has the same IDs.)

        // Re-bind step navigation for the new form
        newForm.querySelectorAll('.next-step').forEach(btn => {
            btn.addEventListener('click', () => {
                const next = parseInt(btn.dataset.next, 10);
                // Call the original goToStep if available
                if (window.goToStep) {
                    window.goToStep(next);
                } else {
                    // Fallback: manually switch steps
                    document.querySelectorAll('.form-step').forEach(el => {
                        el.classList.toggle('active', parseInt(el.dataset.step, 10) === next);
                    });
                    document.querySelectorAll('.progress-step').forEach(el => {
                        const s = parseInt(el.dataset.step, 10);
                        el.classList.remove('active', 'completed');
                        if (s === next) el.classList.add('active');
                        if (s < next) el.classList.add('completed');
                    });
                }
            });
        });

        newForm.querySelectorAll('.prev-step').forEach(btn => {
            btn.addEventListener('click', () => {
                const prev = parseInt(btn.dataset.prev, 10);
                if (window.goToStep) {
                    window.goToStep(prev);
                }
            });
        });

        // Bind our payment-aware submit handler
        newForm.addEventListener('submit', submitOrderWithPayment);
    }

    // ── Initialize ──────────────────────────────────────────
    function init() {
        // Wait for order.js to finish initializing, then hook in
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                setTimeout(hookPaymentIntoOrderForm, 100);
            });
        } else {
            setTimeout(hookPaymentIntoOrderForm, 100);
        }
    }

    init();
})();
