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

    // Pricing lives in CoyoteZones.priceQuote (frontend/js/zones.js).
    // Do not keep a second mile table here — it will drift from create-order.

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

    function goToStep(step) {
        if (step < 1 || step > totalSteps) return;
        if (step > currentStep && !validateStep(currentStep)) return;
        currentStep = step;
        document.querySelectorAll('.form-step').forEach(el => {
            el.classList.toggle('active', parseInt(el.dataset.step, 10) === step);
        });
        document.querySelectorAll('.progress-step').forEach(el => {
            const s = parseInt(el.dataset.step, 10);
            el.classList.remove('active', 'completed');
            if (s === step) el.classList.add('active');
            if (s < step) el.classList.add('completed');
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
        if (step === 5) buildReviewSummary();
    }

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
                } else if (dateTimeError) {
                    dateTimeError.classList.remove('visible');
                }
            }
        }
        if (step === 2) {
            ['pickupAddress', 'pickupCity', 'pickupZip', 'dropoffAddress', 'dropoffCity', 'dropoffZip'].forEach(id => {
                const el = document.getElementById(id);
                if (!el.value.trim()) { showError(el, true); valid = false; }
                else showError(el, false);
            });
        }
        if (step === 4) {
            const firstName = document.getElementById('customerFirstName');
            const lastName = document.getElementById('customerLastName');
            const phone = document.getElementById('customerPhone');
            const email = document.getElementById('customerEmail');
            if (!firstName.value.trim()) { showError(firstName, true); valid = false; } else showError(firstName, false);
            if (!lastName.value.trim()) { showError(lastName, true); valid = false; } else showError(lastName, false);
            if (!validatePhone(phone.value.trim())) { showError(phone, true); valid = false; } else showError(phone, false);
            if (email.value.trim() && !validateEmail(email.value.trim())) { showError(email, true); valid = false; }
            else showError(email, false);
        }
        return valid;
    }

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

    function swapLocations() {
        [['pickupAddress', 'dropoffAddress'], ['pickupCity', 'dropoffCity'], ['pickupZip', 'dropoffZip']].forEach(([a, b]) => {
            const elA = document.getElementById(a);
            const elB = document.getElementById(b);
            if (elA && elB) { const temp = elA.value; elA.value = elB.value; elB.value = temp; }
        });
    }

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

    function currentQuote() {
        if (typeof CoyoteZones === 'undefined' || !CoyoteZones.priceQuote) {
            console.error('CoyoteZones not loaded — include ../js/zones.js before order.js');
            return { miles: 0, beach: false, requiredClass: '2wd', total: 0 };
        }
        const serviceType = document.querySelector('input[name="serviceType"]:checked').value;
        const pickupCity = document.getElementById('pickupCity').value;
        const dropoffCity = document.getElementById('dropoffCity').value || pickupCity;
        const passengerCount = parseInt(document.querySelector('input[name="passengers"]:checked')?.value, 10) || 1;
        const packageSize = document.querySelector('input[name="packageSize"]:checked')?.value;
        return CoyoteZones.priceQuote(pickupCity, dropoffCity, {
            service_type: serviceType,
            passenger_count: passengerCount,
            package_size: packageSize,
        });
    }

    function calculateEstimate() {
        return currentQuote().total;
    }

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
        const dateObj = new Date(`${date}T${time}`);
        const dateTimeStr = dateObj.toLocaleString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit'
        });
        let details = '';
        if (serviceType === 'ride') {
            const passengers = document.querySelector('input[name="passengers"]:checked').value;
            details = `${passengers} passenger${passengers === '1' ? '' : 's'}`;
        } else {
            const size = document.querySelector('input[name="packageSize"]:checked').value;
            details = `${size.charAt(0).toUpperCase() + size.slice(1)} package`;
        }
        const priced = currentQuote();
        const estimatedTotal = priced.total;
        document.getElementById('reviewService').textContent = serviceLabels[serviceType] || serviceType;
        document.getElementById('reviewDateTime').textContent = dateTimeStr;
        document.getElementById('reviewPickup').textContent = pickup;
        document.getElementById('reviewDropoff').textContent = dropoff;
        document.getElementById('reviewDetails').textContent = priced.beach
            ? `${details} · ${priced.miles} mi · 4x4 + $8 sand`
            : `${details} · ${priced.miles} mi`;
        document.getElementById('reviewTotal').textContent = `$${estimatedTotal.toFixed(2)}`;
        const tbody = document.getElementById('summaryBody');
        const firstName = document.getElementById('customerFirstName').value;
        const lastName = document.getElementById('customerLastName').value;
        const email = document.getElementById('customerEmail').value;
        const phone = document.getElementById('customerPhone').value;
        const rows = [['Name', `${firstName} ${lastName}`], ['Phone', phone]];
        if (email) rows.push(['Email', email]);
        tbody.innerHTML = rows.map(([label, val]) => `<tr><th>${label}</th><td>${escapeHtml(val)}</td></tr>`).join('');
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    let submitting = false;

    async function submitOrder(e) {
        e.preventDefault();
        if (submitting) return; // guard double clicks / Enter-key resubmits
        const terms = document.getElementById('termsAgree');
        if (!terms.checked) { terms.focus(); return; }
        submitting = true;
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
            passenger_count: serviceType === 'ride' ? parseInt(document.querySelector('input[name="passengers"]:checked').value) : null,
            package_size: serviceType === 'package_delivery' ? document.querySelector('input[name="packageSize"]:checked').value : null,
            package_description: document.getElementById('itemDescription')?.value.trim() || null,
            special_instructions: document.getElementById('specialInstructions').value.trim() || null,
        };
        try {
            const result = await CoyoteAPI.post('/api/create-order', orderData);
            if (result.ok) {
                const ctx = {
                    orderId: result.data.orderId,
                    orderNumber: result.data.orderNumber,
                    amount: Number(result.data.estimatedPrice) || 0,
                    trackingToken: result.data.trackingToken || null,
                    email: orderData.email,
                };
                if (ctx.trackingToken && window.CoyoteCoastal) {
                    window.CoyoteCoastal.saveTrackingToken(ctx.orderNumber, ctx.trackingToken);
                }
                // Card checkout (stripe-payment.js) takes over when available;
                // otherwise show the confirmation (pay driver).
                const checkout = window.CoyoteCheckout;
                let handled = false;
                if (checkout && typeof checkout.afterOrderCreated === 'function') {
                    try { handled = await checkout.afterOrderCreated(ctx); } catch (err) { console.error(err); handled = false; }
                }
                if (!handled) showSuccess(ctx);
                try {
                    const orders = JSON.parse(localStorage.getItem('cdd_orders') || '[]');
                    orders.push({ orderNumber: result.data.orderNumber, orderId: result.data.orderId, createdAt: new Date().toISOString(), serviceType: orderData.service_type });
                    localStorage.setItem('cdd_orders', JSON.stringify(orders));
                } catch (_) {}
                const estimatedTotal = calculateEstimate();
                if (typeof trackEvent === 'function') trackEvent('order', 'submitted', serviceType, estimatedTotal);
                if (typeof firebaseTrackEvent === 'function') firebaseTrackEvent('order_submitted', { service_type: serviceType, estimated_price: estimatedTotal });
                if (typeof trackConversion === 'function') trackConversion('purchase', { value: estimatedTotal, currency: 'USD', service_type: serviceType });
                if (typeof logAnalyticsEvent === 'function') logAnalyticsEvent('order_submitted', { category: 'order', service_type: serviceType, estimated_price: estimatedTotal, order_number: result.data.orderNumber });
            } else {
                alert('Failed to place order: ' + (result.error || result.data?.message || 'Unknown error'));
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalText;
                submitting = false;
            }
        } catch (err) {
            console.error('Order submission failed:', err);
            alert('Something went wrong. Please try again or call (361) 555-1234.');
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalText;
            submitting = false;
        }
    }

    const trackBtn = document.getElementById('trackBtn');
    if (trackBtn) trackBtn.addEventListener('click', trackOrder);
    const trackOrderNumber = document.getElementById('trackOrderNumber');
    if (trackOrderNumber) trackOrderNumber.addEventListener('keydown', e => { if (e.key === 'Enter') trackOrder(); });

    async function trackOrder() {
        const orderNum = document.getElementById('trackOrderNumber').value.trim().toUpperCase();
        const phone = document.getElementById('trackPhone').value.trim();
        if (!orderNum || !phone) { alert('Please enter both order number and phone number'); return; }
        const btn = document.getElementById('trackBtn');
        btn.disabled = true;
        btn.textContent = 'Tracking...';
        try {
            const auth = await CoyoteAPI.post('/api/get-orders', { order_number: orderNum, phone: phone });
            if (!auth.ok || !auth.data || !auth.data.token) {
                alert('Order not found. Please check your order number and phone number.');
                return;
            }
            const result = await CoyoteAPI.request('/api/get-orders', {
                method: 'GET',
                headers: { Authorization: 'Bearer ' + auth.data.token }
            });
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
        const serviceLabels = { ride: 'On-Demand Ride', package_delivery: 'Package Delivery', grocery_run: 'Grocery & Supply Run', group_transport: 'Group Transport' };
        document.getElementById('trackingOrderNum').textContent = `Order #${order.order_number}`;
        const statusEl = document.getElementById('trackingStatus');
        statusEl.textContent = order.status.replace('_', ' ');
        statusEl.className = 'status-badge-track ' + order.status;
        document.getElementById('trackingService').textContent = serviceLabels[order.service_type] || order.service_type;
        document.getElementById('trackingScheduled').textContent = order.is_asap ? 'ASAP' : `${order.scheduled_date} at ${order.scheduled_time}`;
        document.getElementById('trackingPickup').textContent = `${order.pickup_address}, ${order.pickup_city}`;
        document.getElementById('trackingDropoff').textContent = order.dropoff_address ? `${order.dropoff_address}, ${order.dropoff_city || order.pickup_city}` : 'Same as pickup';
        document.getElementById('trackingPrice').textContent = order.estimated_price ? `$${parseFloat(order.estimated_price).toFixed(2)}` : '—';
        document.getElementById('trackingDriver').textContent = order.driver_id ? 'Assigned' : 'Not yet assigned';
        resultEl.classList.add('active');
    }

    function initFromUrl() {
        const C = window.CoyoteCoastal;
        const params = C ? C.parseOrderParams(window.location.search) : {};
        if (params.track) {
            document.getElementById('trackOrderNumber').value = params.track;
            setTimeout(() => document.getElementById('trackingSection').scrollIntoView({ behavior: 'smooth' }), 500);
        }
        if (params.service) {
            const radio = document.querySelector(`input[name="serviceType"][value="${params.service}"]`);
            if (radio) radio.checked = true;
        }
        if (params.pickup) document.getElementById('pickupCity').value = params.pickup;
        if (params.dropoff) document.getElementById('dropoffCity').value = params.dropoff;
        const cat = params.category && C ? C.categoryById(params.category) : null;
        const noteParts = [];
        if (cat && cat.note) noteParts.push(cat.note);
        if (params.q) noteParts.push(params.q);
        const item = document.getElementById('itemDescription');
        if (item && noteParts.length && !item.value) item.value = noteParts.join(': ');
        const banner = document.getElementById('ccPrefillNote');
        if (banner && (cat || params.pickup)) {
            const bits = [];
            if (cat) bits.push(cat.label);
            if (params.pickup && params.dropoff) bits.push(`${params.pickup} → ${params.dropoff}`);
            else if (params.pickup) bits.push(`near ${params.pickup}`);
            banner.textContent = 'Starting your order: ' + bits.join(' · ');
            banner.hidden = false;
        }
    }

    // Live quote chip: same numbers create-order stores as estimated_price.
    function updateLiveQuote() {
        const box = document.getElementById('ccLiveQuote');
        if (!box) return;
        const pickupCity = document.getElementById('pickupCity').value;
        if (!pickupCity || typeof CoyoteZones === 'undefined') { box.hidden = true; return; }
        const q = currentQuote();
        const dropoffCity = document.getElementById('dropoffCity').value || pickupCity;
        document.getElementById('ccLiveQuoteText').textContent =
            `${pickupCity} → ${dropoffCity} · ${q.miles} mi${q.beach ? ' · 4x4 beach access' : ''}`;
        document.getElementById('ccLiveQuoteTotal').textContent = `$${q.total.toFixed(2)}`;
        box.hidden = false;
    }

    // Success screen shared by cash and card flows (stripe-payment.js calls this too).
    function showSuccess(ctx) {
        const c = ctx || {};
        if (form) form.style.display = 'none';
        if (progressBar) progressBar.style.display = 'none';
        const quoteBox = document.getElementById('ccLiveQuote');
        if (quoteBox) quoteBox.hidden = true;
        const note = document.getElementById('ccPrefillNote');
        if (note) note.hidden = true;
        if (c.orderNumber) document.getElementById('orderIdDisplay').textContent = c.orderNumber;
        const trackLink = document.getElementById('ccTrackLink');
        if (trackLink && c.orderNumber && window.CoyoteCoastal) {
            trackLink.href = window.CoyoteCoastal.buildTrackUrl(c.orderNumber);
        }
        if (c.title) { const h = orderSuccess.querySelector('h2'); if (h) h.textContent = c.title; }
        if (c.message) { const ps = orderSuccess.querySelectorAll('p'); if (ps[1]) ps[1].textContent = c.message; }
        orderSuccess.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function init() {
        initDateTime();
        initFromUrl();
        updateServiceType();
        document.querySelectorAll('input[name="serviceType"]').forEach(radio => radio.addEventListener('change', updateServiceType));
        const swapBtn = document.getElementById('swapLocations');
        if (swapBtn) swapBtn.addEventListener('click', swapLocations);
        document.querySelectorAll('.next-step').forEach(btn => btn.addEventListener('click', () => goToStep(parseInt(btn.dataset.next, 10))));
        document.querySelectorAll('.prev-step').forEach(btn => btn.addEventListener('click', () => goToStep(parseInt(btn.dataset.prev, 10))));
        setupCardSelection('#rideDetails', 'passengers');
        setupCardSelection('#deliveryDetails', 'packageSize');
        ['pickupAddress', 'pickupCity', 'pickupZip', 'dropoffAddress', 'dropoffCity', 'dropoffZip', 'customerFirstName', 'customerLastName', 'customerPhone', 'customerEmail'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', () => showError(el, false));
        });
        ['pickupCity', 'dropoffCity'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', updateLiveQuote);
        });
        document.querySelectorAll('input[name="serviceType"], input[name="passengers"], input[name="packageSize"]').forEach(r => r.addEventListener('change', updateLiveQuote));
        document.querySelectorAll('#rideDetails .detail-card, #deliveryDetails .detail-card').forEach(c => c.addEventListener('click', updateLiveQuote));
        updateLiveQuote();
        form.addEventListener('submit', submitOrder);
        window.CoyoteOrder = { showSuccess: showSuccess, goToStep: goToStep, currentQuote: currentQuote };
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
