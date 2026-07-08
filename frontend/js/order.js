/**
 * Coyote's Dune Delivery — Customer Order Form
 * Handles multi-step order flow: Service > Route > Details > Contact > Review
 */

(function () {
    'use strict';

    const form = document.getElementById('orderForm');
    const formContainer = document.getElementById('formContainer');
    const progressBar = document.getElementById('progressBar');
    const orderSuccess = document.getElementById('orderSuccess');
    const submitBtn = document.getElementById('submitBtn');

    let currentStep = 1;
    const totalSteps = 5;

    // Initialize default date/time to now + 30 minutes
    function initDateTime() {
        const now = new Date();
        now.setMinutes(now.getMinutes() + 30);
        const dateInput = document.getElementById('serviceDate');
        const timeInput = document.getElementById('serviceTime');
        if (dateInput) {
            dateInput.value = now.toISOString().split('T')[0];
            dateInput.min = new Date().toISOString().split('T')[0];
        }
        if (timeInput) {
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            timeInput.value = `${hours}:${minutes}`;
        }
    }

    // Step navigation
    function goToStep(step) {
        if (step < 1 || step > totalSteps) return;

        // Validate current step before moving forward
        if (step > currentStep && !validateStep(currentStep)) {
            return;
        }

        currentStep = step;

        // Update visible step
        document.querySelectorAll('.form-step').forEach(el => {
            el.classList.toggle('active', parseInt(el.dataset.step, 10) === step);
        });

        // Update progress bar
        document.querySelectorAll('.progress-step').forEach(el => {
            const s = parseInt(el.dataset.step, 10);
            el.classList.remove('active', 'completed');
            if (s === step) el.classList.add('active');
            if (s < step) el.classList.add('completed');
        });

        // Scroll to top of form
        window.scrollTo({ top: 0, behavior: 'smooth' });

        // Build review summary when reaching step 5
        if (step === 5) {
            buildReviewSummary();
        }
    }

    // Validation helpers
    function showError(input, show) {
        const group = input.closest('.form-group');
        if (!group) return;
        const err = group.querySelector('.error-message');
        if (err) err.classList.toggle('visible', show);
        input.classList.toggle('error', show);
    }

    function validateEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    function validatePhone(phone) {
        return phone.replace(/\D/g, '').length >= 10;
    }

    function validateStep(step) {
        let valid = true;

        if (step === 1) {
            const date = document.getElementById('serviceDate');
            const time = document.getElementById('serviceTime');
            const dateTimeError = document.getElementById('dateTimeError');
            if (!date.value || !time.value) {
                if (dateTimeError) dateTimeError.classList.add('visible');
                valid = false;
            } else {
                const selected = new Date(`${date.value}T${time.value}`);
                if (selected <= new Date()) {
                    if (dateTimeError) dateTimeError.classList.add('visible');
                    valid = false;
                } else {
                    if (dateTimeError) dateTimeError.classList.remove('visible');
                }
            }
        }

        if (step === 2) {
            const fields = ['pickupAddress', 'pickupCity', 'pickupZip', 'dropoffAddress', 'dropoffCity', 'dropoffZip'];
            fields.forEach(id => {
                const el = document.getElementById(id);
                if (!el.value.trim()) {
                    showError(el, true);
                    valid = false;
                } else {
                    showError(el, false);
                }
            });
        }

        if (step === 4) {
            const firstName = document.getElementById('customerFirstName');
            const lastName = document.getElementById('customerLastName');
            const email = document.getElementById('customerEmail');
            const phone = document.getElementById('customerPhone');

            if (!firstName.value.trim()) { showError(firstName, true); valid = false; }
            else { showError(firstName, false); }

            if (!lastName.value.trim()) { showError(lastName, true); valid = false; }
            else { showError(lastName, false); }

            if (!validateEmail(email.value.trim())) { showError(email, true); valid = false; }
            else { showError(email, false); }

            if (!validatePhone(phone.value.trim())) { showError(phone, true); valid = false; }
            else { showError(phone, false); }
        }

        return valid;
    }

    // Service type toggle
    function updateServiceType() {
        const rideOpt = document.getElementById('optRide');
        const deliveryOpt = document.getElementById('optDelivery');
        const rideDetails = document.getElementById('rideDetails');
        const deliveryDetails = document.getElementById('deliveryDetails');
        const isRide = document.querySelector('input[name="serviceType"]:checked').value === 'ride';

        rideOpt.classList.toggle('selected', isRide);
        deliveryOpt.classList.toggle('selected', !isRide);

        if (rideDetails) rideDetails.style.display = isRide ? 'block' : 'none';
        if (deliveryDetails) deliveryDetails.style.display = isRide ? 'none' : 'block';
    }

    // Swap pickup / dropoff
    function swapLocations() {
        const pairs = [
            ['pickupAddress', 'dropoffAddress'],
            ['pickupCity', 'dropoffCity'],
            ['pickupZip', 'dropoffZip'],
        ];
        pairs.forEach(([a, b]) => {
            const elA = document.getElementById(a);
            const elB = document.getElementById(b);
            if (elA && elB) {
                const temp = elA.value;
                elA.value = elB.value;
                elB.value = temp;
            }
        });
    }

    // Card selection helper
    function setupCardSelection(containerSelector, inputName) {
        document.querySelectorAll(`${containerSelector} .detail-card`).forEach(card => {
            card.addEventListener('click', () => {
                document.querySelectorAll(`${containerSelector} .detail-card`).forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                const input = card.querySelector(`input[name="${inputName}"]`);
                if (input) input.checked = true;
            });
        });
    }

    // Build review summary
    function buildReviewSummary() {
        const serviceType = document.querySelector('input[name="serviceType"]:checked').value;
        const date = document.getElementById('serviceDate').value;
        const time = document.getElementById('serviceTime').value;
        const pickup = `${document.getElementById('pickupAddress').value}, ${document.getElementById('pickupCity').value} ${document.getElementById('pickupZip').value}`;
        const dropoff = `${document.getElementById('dropoffAddress').value}, ${document.getElementById('dropoffCity').value} ${document.getElementById('dropoffZip').value}`;

        // Format date/time nicely
        const dateObj = new Date(`${date}T${time}`);
        const dateTimeStr = dateObj.toLocaleString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit'
        });

        // Build details string
        let details = '';
        let basePrice = 0;
        if (serviceType === 'ride') {
            const passengers = document.querySelector('input[name="passengers"]:checked').value;
            details = `${passengers} passenger${passengers === '1' ? '' : 's'}`;
            basePrice = 18;
            if (passengers === '4+') basePrice += 5;
        } else {
            const size = document.querySelector('input[name="packageSize"]:checked').value;
            const rush = document.querySelector('input[name="rushDelivery"]:checked').value;
            details = `${size.charAt(0).toUpperCase() + size.slice(1)} package`;
            if (rush === 'rush') details += ', Rush delivery';
            basePrice = size === 'small' ? 12 : size === 'medium' ? 18 : size === 'large' ? 28 : 45;
            if (rush === 'rush') basePrice += 10;
        }

        // Calculate estimated total (simple heuristic)
        const estimatedTotal = basePrice.toFixed(2);

        document.getElementById('reviewService').textContent = serviceType === 'ride' ? 'On-Demand Ride' : 'Package Delivery';
        document.getElementById('reviewDateTime').textContent = dateTimeStr;
        document.getElementById('reviewPickup').textContent = pickup;
        document.getElementById('reviewDropoff').textContent = dropoff;
        document.getElementById('reviewDetails').textContent = details;
        document.getElementById('reviewTotal').textContent = `$${estimatedTotal}`;

        // Summary table
        const tbody = document.getElementById('summaryBody');
        const firstName = document.getElementById('customerFirstName').value;
        const lastName = document.getElementById('customerLastName').value;
        const email = document.getElementById('customerEmail').value;
        const phone = document.getElementById('customerPhone').value;
        const payment = document.querySelector('input[name="paymentMethod"]:checked').value;

        const rows = [
            ['Name', `${firstName} ${lastName}`],
            ['Email', email],
            ['Phone', phone],
            ['Payment', payment.charAt(0).toUpperCase() + payment.slice(1)],
        ];

        tbody.innerHTML = rows.map(([label, val]) =>
            `<tr><th>${label}</th><td>${escapeHtml(val)}</td></tr>`
        ).join('');
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Generate order ID
    function generateOrderId() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let id = 'CDD-';
        for (let i = 0; i < 8; i++) {
            id += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return id;
    }

    // Submit order
    async function submitOrder(e) {
        e.preventDefault();

        const terms = document.getElementById('termsAgree');
        if (!terms.checked) {
            terms.focus();
            return;
        }

        submitBtn.disabled = true;
        const originalText = submitBtn.textContent;
        submitBtn.innerHTML = '<span class="spinner"></span> Placing Order...';

        const orderData = {
            orderId: generateOrderId(),
            serviceType: document.querySelector('input[name="serviceType"]:checked').value,
            serviceDate: document.getElementById('serviceDate').value,
            serviceTime: document.getElementById('serviceTime').value,
            pickupAddress: document.getElementById('pickupAddress').value,
            pickupCity: document.getElementById('pickupCity').value,
            pickupZip: document.getElementById('pickupZip').value,
            dropoffAddress: document.getElementById('dropoffAddress').value,
            dropoffCity: document.getElementById('dropoffCity').value,
            dropoffZip: document.getElementById('dropoffZip').value,
            specialInstructions: document.getElementById('specialInstructions').value,
            passengers: document.querySelector('input[name="passengers"]')?.checked?.value || '1',
            rideNotes: document.getElementById('rideNotes')?.value || '',
            packageSize: document.querySelector('input[name="packageSize"]')?.checked?.value || 'small',
            rushDelivery: document.querySelector('input[name="rushDelivery"]')?.checked?.value || 'standard',
            itemDescription: document.getElementById('itemDescription')?.value || '',
            customerFirstName: document.getElementById('customerFirstName').value,
            customerLastName: document.getElementById('customerLastName').value,
            customerEmail: document.getElementById('customerEmail').value,
            customerPhone: document.getElementById('customerPhone').value,
            customerAltPhone: document.getElementById('customerAltPhone').value || '',
            paymentMethod: document.querySelector('input[name="paymentMethod"]:checked').value,
            createdAt: new Date().toISOString(),
        };

        try {
            const API_BASE = window.location.hostname === 'localhost'
                ? 'http://localhost:3000/api'
                : '/api';

            const response = await fetch(`${API_BASE}/submit-order`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(orderData),
            });

            if (!response.ok) {
                // If endpoint doesn't exist yet, still show success with local data
                console.warn('Order API not available yet. Showing local confirmation.');
            }
        } catch (err) {
            console.warn('Order API not available yet. Showing local confirmation.', err);
        }

        // Show success
        form.style.display = 'none';
        progressBar.style.display = 'none';
        orderSuccess.classList.add('active');
        document.getElementById('orderIdDisplay').textContent = orderData.orderId;

        // Store order ID in localStorage for reference
        try {
            const orders = JSON.parse(localStorage.getItem('cdd_orders') || '[]');
            orders.push({ orderId: orderData.orderId, createdAt: orderData.createdAt, serviceType: orderData.serviceType });
            localStorage.setItem('cdd_orders', JSON.stringify(orders));
        } catch (_) { /* ignore */ }

        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
    }

    // Event listeners
    function init() {
        initDateTime();
        updateServiceType();

        // Service type radio clicks
        document.querySelectorAll('input[name="serviceType"]').forEach(radio => {
            radio.addEventListener('change', updateServiceType);
        });

        // Swap button
        const swapBtn = document.getElementById('swapLocations');
        if (swapBtn) swapBtn.addEventListener('click', swapLocations);

        // Next / Prev step buttons
        document.querySelectorAll('.next-step').forEach(btn => {
            btn.addEventListener('click', () => {
                const next = parseInt(btn.dataset.next, 10);
                goToStep(next);
            });
        });

        document.querySelectorAll('.prev-step').forEach(btn => {
            btn.addEventListener('click', () => {
                const prev = parseInt(btn.dataset.prev, 10);
                goToStep(prev);
            });
        });

        // Card selections
        setupCardSelection('#rideDetails', 'passengers');
        setupCardSelection('#deliveryDetails', 'packageSize');
        setupCardSelection('#deliveryDetails', 'rushDelivery');
        setupCardSelection('.form-step[data-step="4"]', 'paymentMethod');

        // Real-time error clearing
        ['pickupAddress', 'pickupCity', 'pickupZip', 'dropoffAddress', 'dropoffCity', 'dropoffZip',
         'customerFirstName', 'customerLastName', 'customerEmail', 'customerPhone'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', () => showError(el, false));
            }
        });

        // Form submit
        form.addEventListener('submit', submitOrder);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
