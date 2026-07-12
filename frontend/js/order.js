/**
 * Coyote's Dune Delivery — Customer Order Form
 * Handles multi-step order flow: Service > Route > Details > Contact > Review
 * Integrated with /api/create-order, /api/get-orders backend
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

    // ── Pricing Constants ───────────────────────────────────
    const PRICING = {
        ride: { base: 12, per_mile: 2.5 },
        package_delivery: { base: 15, per_mile: 2.0 },
        grocery_run: { base: 18, per_mile: 1.5 },
        group_transport: { base: 35, per_mile: 3.0 },
    };

    const ZONE_DISTANCES = {
        'Port Aransas-Padre Island': 18,
        'Padre Island-Port Aransas': 18,
        'Port Aransas-Port Aransas': 4,
        'Padre Island-Padre Island': 5,
        'Corpus Christi-Port Aransas': 22,
        'Port Aransas-Corpus Christi': 22,
        'Corpus Christi-Padre Island': 12,
        'Padre Island-Corpus Christi': 12,
        'Rockport-Port Aransas': 25,
        'Port Aransas-Rockport': 25,
    };

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
            const phone = document.getElementById('customerPhone');
            const email = document.getElementById('customerEmail');

            if (!firstName.value.trim()) { showError(firstName, true); valid = false; }
            else { showError(firstName, false); }

            if (!lastName.value.trim()) { showError(lastName, true); valid = false; }
            else { showError(lastName, false); }

            if (!validatePhone(phone.value.trim())) { showError(phone, true); valid = false; }
            else { showError(phone, false); }

            if (email.value.trim() && !validateEmail(email.value.trim())) {
                showError(email, true); valid = false;
            } else {
                showError(email, false);
            }
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

    // ── Pricing Engine ──────────────────────────────────────
    function calculateEstimate() {
        const serviceType = document.querySelector('input[name="serviceType"]:checked').value;
        const pricing = PRICING[serviceType] || PRICING.ride;
        let price = pricing.base;

        const pickupCity = document.getElementById('pickupCity').value;
        const dropoffCity = document.getElementById('dropoffCity').value || pickupCity;
        const zoneKey = `${pickupCity}-${dropoffCity}`;
        const miles = ZONE_DISTANCES[zoneKey] || 10;
        price += miles * pricing.per_mile;

        const passengerCount = parseInt(document.querySelector('input[name="passengers"]:checked')?.value) || 1;
        if (passengerCount > 1) price += (passengerCount - 1) * 3;

        const packageSize = document.querySelector('input[name="packageSize"]:checked')?.value;
        if (packageSize === 'large') price += 8;
        if (packageSize === 'oversized') price += 15;

        return Math.round(price * 100) / 100;
    }

    // Build review summary
    function buildReviewSummary() {
        const serviceType = document.querySelector('input[name="serviceType"]:checked').value;
        const serviceLabels = {
            ride: 'On-Demand Ride',
            package_delivery: 'Package Delivery',
            grocery_run: 'Grocery & Supply Run',
            group_transport: 'Group Transport',
        };
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
        if (serviceType === 'ride') {
            const passengers = document.querySelector('input[name="passengers"]:checked').value;
            details = `${passengers} passenger${passengers === '1' ? '' : 's'}`;
        } else {
            const size = document.querySelector('input[name="packageSize"]:checked').value;
            details = `${size.charAt(0).toUpperCase() + size.slice(1)} package`;
        }

        const estimatedTotal = calculateEstimate();

        document.getElementById('reviewService').textContent = serviceLabels[serviceType] || serviceType;
        document.getElementById('reviewDateTime').textContent = dateTimeStr;
        document.getElementById('reviewPickup').textContent = pickup;
        document.getElementById('reviewDropoff').textContent = dropoff;
        document.getElementById('reviewDetails').textContent = details;
        document.getElementById('reviewTotal').textContent = `$${estimatedTotal.toFixed(2)}`;

        // Summary table
        const tbody = document.getElementById('summaryBody');
        const firstName = document.getElementById('customerFirstName').value;
        const lastName = document.getElementById('customerLastName').value;
        const email = document.getElementById('customerEmail').value;
        const phone = document.getElementById('customerPhone').value;

        const rows = [
            ['Name', `${firstName} ${lastName}`],
            ['Phone', phone],
        ];
        if (email) rows.push(['Email', email]);

        tbody.innerHTML = rows.map(([label, val]) =>
            `<tr><th>${label}</th><td>${escapeHtml(val)}</td></tr>`
        ).join('');
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ── Submit order ────────────────────────────────────────
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
                document.getElementById('orderIdDisplay').textContent = result.data.orderNumber;
                form.style.display = 'none';
                progressBar.style.display = 'none';
                orderSuccess.classList.add('active');
                window.scrollTo({ top: 0, behavior: 'smooth' });

                // Store order in localStorage
                try {
                    const orders = JSON.parse(localStorage.getItem('cdd_orders') || '[]');
                    orders.push({
                        orderNumber: result.data.orderNumber,
                        orderId: result.data.orderId,
                        createdAt: new Date().toISOString(),
                        serviceType: orderData.service_type,
                    });
                    localStorage.setItem('cdd_orders', JSON.stringify(orders));
                } catch (_) { /* ignore */ }

                // ── Analytics: Order submitted ─────────────────
                const estimatedTotal = calculateEstimate();
                if (typeof trackEvent === 'function') {
                    trackEvent('order', 'submitted', serviceType, estimatedTotal);
                }
                if (typeof firebaseTrackEvent === 'function') {
                    firebaseTrackEvent('order_submitted', {
                        service_type: serviceType,
                        estimated_price: estimatedTotal,
                    });
                }
                if (typeof trackConversion === 'function') {
                    trackConversion('purchase', {
                        value: estimatedTotal,
                        currency: 'USD',
                        service_type: serviceType,
                    });
                }
                if (typeof logAnalyticsEvent === 'function') {
                    logAnalyticsEvent('order_submitted', {
                        category: 'order',
                        service_type: serviceType,
                        estimated_price: estimatedTotal,
                        order_number: result.data.orderNumber,
                    });
                }
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

    // ── Order Tracking ──────────────────────────────────────
    const trackBtn = document.getElementById('trackBtn');
    if (trackBtn) {
        trackBtn.addEventListener('click', trackOrder);
    }

    const trackOrderNumber = document.getElementById('trackOrderNumber');
    if (trackOrderNumber) {
        trackOrderNumber.addEventListener('keydown', e => {
            if (e.key === 'Enter') trackOrder();
        });
    }

    async function trackOrder() {
        const orderNum = document.getElementById('trackOrderNumber').value.trim().toUpperCase();
        const phone = document.getElementById('trackPhone').value.trim();
        const resultEl = document.getElementById('trackingResult');

        if (!orderNum && !phone) {
            alert('Please enter an order number or phone number');
            return;
        }

        const btn = document.getElementById('trackBtn');
        btn.disabled = true;
        btn.textContent = 'Tracking...';

        try {
            const params = {};
            if (orderNum) params.order_number = orderNum;
            if (phone) params.phone = phone;

            const result = await CoyoteAPI.get('/api/get-orders', params);

            if (result.ok && result.data && (Array.isArray(result.data.data) ? result.data.data.length > 0 : result.data.data)) {
                const order = Array.isArray(result.data.data) ? result.data.data[0] : result.data.data;
                displayTrackingResult(order);
            } else {
                alert('Order not found. Please check your order number and phone number.');
            }
        } catch (err) {
            console.error('Tracking failed:', err);
            alert('Unable to track order right now. Please try again.');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Track Order';
        }
    }

    function displayTrackingResult(order) {
        const resultEl = document.getElementById('trackingResult');
        const serviceLabels = {
            ride: 'On-Demand Ride',
            package_delivery: 'Package Delivery',
            grocery_run: 'Grocery & Supply Run',
            group_transport: 'Group Transport',
        };

        document.getElementById('trackingOrderNum').textContent = `Order #${order.order_number}`;

        const statusEl = document.getElementById('trackingStatus');
        statusEl.textContent = order.status.replace('_', ' ');
        statusEl.className = 'status-badge-track ' + order.status;

        document.getElementById('trackingService').textContent = serviceLabels[order.service_type] || order.service_type;
        document.getElementById('trackingScheduled').textContent = order.is_asap
            ? 'ASAP'
            : `${order.scheduled_date} at ${order.scheduled_time}`;
        document.getElementById('trackingPickup').textContent = `${order.pickup_address}, ${order.pickup_city}`;
        document.getElementById('trackingDropoff').textContent = order.dropoff_address
            ? `${order.dropoff_address}, ${order.dropoff_city || order.pickup_city}`
            : 'Same as pickup';
        document.getElementById('trackingPrice').textContent = order.estimated_price
            ? `$${parseFloat(order.estimated_price).toFixed(2)}`
            : '—';
        document.getElementById('trackingDriver').textContent = order.driver_id
            ? 'Assigned'
            : 'Not yet assigned';

        resultEl.classList.add('active');
    }

    // ── Auto-track from URL ─────────────────────────────────
    function initFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const trackNum = params.get('track');
        if (trackNum) {
            document.getElementById('trackOrderNumber').value = trackNum;
            setTimeout(() => {
                document.getElementById('trackingSection').scrollIntoView({ behavior: 'smooth' });
            }, 500);
        }
    }

    // Event listeners
    function init() {
        initDateTime();
        initFromUrl();
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

        // Real-time error clearing
        ['pickupAddress', 'pickupCity', 'pickupZip', 'dropoffAddress', 'dropoffCity', 'dropoffZip',
         'customerFirstName', 'customerLastName', 'customerPhone', 'customerEmail'].forEach(id => {
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
