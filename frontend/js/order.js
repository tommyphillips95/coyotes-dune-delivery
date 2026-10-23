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
        const dateInput = document.getElementById('serviceDate');
        const timeInput = document.getElementById('serviceTime');
        const C = window.CoyoteCoastal;
        let slot;
        if (C && typeof C.defaultServiceSlot === 'function') {
            slot = C.defaultServiceSlot(new Date(), 30);
        } else {
            // Local wall-clock fallback (never toISOString: that is UTC).
            const pad = n => String(n).padStart(2, '0');
            const now = new Date();
            const later = new Date(now.getTime() + 30 * 60000);
            const day = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            slot = { date: day(later), time: `${pad(later.getHours())}:${pad(later.getMinutes())}`, minDate: day(now) };
        }
        if (dateInput) {
            dateInput.value = slot.date;
            dateInput.min = slot.minDate;
        }
        if (timeInput) timeInput.value = slot.time;
    }

    function goToStep(step) {
        if (step < 1 || step > totalSteps) return;
        if (step > currentStep && !validateStep(currentStep)) {
            const firstBad = document.querySelector(`.form-step[data-step="${currentStep}"] .error`);
            if (firstBad && typeof firstBad.focus === 'function') firstBad.focus();
            return;
        }
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
        // Move focus to the new step's heading so screen readers announce it and
        // keyboard users don't land on <body> after the Next/Back button disappears.
        const heading = document.querySelector(`.form-step[data-step="${step}"] h2`);
        if (heading) {
            if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
            try { heading.focus({ preventScroll: true }); } catch (e) { heading.focus(); }
        }
    }

    // Link an error element to its field only while it's showing: screen readers
    // read aria-describedby text even when the element is hidden.
    function linkError(input, err, show) {
        if (!input || !err) return;
        if (!err.id) err.id = (input.id || input.name) + 'Error';
        const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(x => x && x !== err.id);
        if (show) ids.push(err.id);
        if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
        else input.removeAttribute('aria-describedby');
    }

    function showError(input, show) {
        const group = input.closest('.form-group');
        if (!group) return;
        const err = group.querySelector('.error-message');
        if (err) err.classList.toggle('visible', show);
        linkError(input, err, show);
        input.classList.toggle('error', show);
        input.setAttribute('aria-invalid', show ? 'true' : 'false');
    }

    function validateEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    function isValidZip(zip) {
        const C = window.CoyoteCoastal;
        if (C && typeof C.isValidZip === 'function') return C.isValidZip(zip);
        return /^\d{5}(-?\d{4})?$/.test(String(zip || '').trim());
    }

    function validatePhone(phone) {
        return phone.replace(/\D/g, '').length >= 10;
    }

    // Date/time inputs are Central (Port Aransas) wall-clock, whatever zone the
    // phone is in. Falls back to device-local parsing if coastal.js is missing.
    function serviceInstant(date, time) {
        const C = window.CoyoteCoastal;
        if (C && typeof C.centralInstant === 'function') return C.centralInstant(date, time);
        return new Date(`${date}T${time}`);
    }

    function serviceIso(date, time) {
        const C = window.CoyoteCoastal;
        if (C && typeof C.centralIso === 'function') return C.centralIso(date, time);
        return null;
    }

    function validateStep(step) {
        let valid = true;
        if (step === 1) {
            const date = document.getElementById('serviceDate');
            const time = document.getElementById('serviceTime');
            const dateTimeError = document.getElementById('dateTimeError');
            // Mark the field to fix so goToStep() focuses it (date if missing, else time).
            const mark = (bad) => {
                [date, time].forEach(el => {
                    el.classList.toggle('error', el === bad);
                    el.setAttribute('aria-invalid', el === bad ? 'true' : 'false');
                    linkError(el, dateTimeError, el === bad);
                });
            };
            if (!date.value || !time.value) {
                if (dateTimeError) dateTimeError.classList.add('visible');
                mark(!date.value ? date : time);
                valid = false;
            } else {
                const selected = serviceInstant(date.value, time.value);
                if (!selected || selected <= new Date()) {
                    if (dateTimeError) dateTimeError.classList.add('visible');
                    mark(time);
                    valid = false;
                } else {
                    if (dateTimeError) dateTimeError.classList.remove('visible');
                    mark(null);
                }
            }
        }
        if (step === 2) {
            ['pickupAddress', 'pickupCity', 'pickupZip', 'dropoffAddress', 'dropoffCity', 'dropoffZip'].forEach(id => {
                const el = document.getElementById(id);
                const bad = !el.value.trim() || (/Zip$/.test(id) && !isValidZip(el.value));
                if (bad) { showError(el, true); valid = false; }
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

    // ── ZIP 78418 + Corpus Christi: island or Flour Bluff? ──
    // Asked on the Review step before the order is created. "island" prices as
    // Padre Island (create-order does the same with <end>_zip_area).
    const ZIP_AREA_ENDS = ['pickup', 'dropoff'];
    function endTownZip(end) {
        const town = document.getElementById(end + 'City').value || (end === 'dropoff' ? document.getElementById('pickupCity').value : '');
        return { town, zip: document.getElementById(end + 'Zip').value };
    }
    function zipAreaQuestion(end) {
        const C = window.CoyoteCoastal;
        if (!C || typeof C.zipAreaQuestion !== 'function') return null;
        const tz = endTownZip(end);
        return C.zipAreaQuestion(tz.town, tz.zip);
    }
    function zipAreaAnswer(end) {
        if (!zipAreaQuestion(end)) return null;
        const r = document.querySelector(`input[name="${end}ZipArea"]:checked`);
        return r ? r.value : null;
    }
    function pricedTown(end, assume) {
        const tz = endTownZip(end);
        const C = window.CoyoteCoastal;
        const answer = (assume && assume[end]) || zipAreaAnswer(end);
        return C && typeof C.zipAreaTown === 'function' ? C.zipAreaTown(tz.town, tz.zip, answer) : tz.town;
    }
    function setZipAreaError(end, show) {
        const group = document.getElementById(end + 'ZipAreaGroup');
        const msg = document.getElementById(end + 'ZipAreaError');
        if (msg) msg.hidden = !show;
        if (group) group.classList.toggle('cc-invalid', !!show);
        if (group && msg) linkError(group, msg, !!show);
        document.querySelectorAll(`input[name="${end}ZipArea"]`).forEach(r => r.setAttribute('aria-invalid', show ? 'true' : 'false'));
    }
    function updateZipAreaQuestions() {
        ZIP_AREA_ENDS.forEach(end => {
            const group = document.getElementById(end + 'ZipAreaGroup');
            if (!group) return;
            const q = zipAreaQuestion(end);
            group.hidden = !q;
            if (q) { const z = group.querySelector('.cc-zip-area-zip'); if (z) z.textContent = q.zip; }
            else setZipAreaError(end, false);
        });
    }
    /** Ends still waiting for an answer (focus target first). */
    function unansweredZipAreas() {
        return ZIP_AREA_ENDS.filter(end => zipAreaQuestion(end) && !zipAreaAnswer(end));
    }
    function focusZipArea(end) {
        const first = document.querySelector(`input[name="${end}ZipArea"]`);
        if (first) { first.focus(); const g = document.getElementById(end + 'ZipAreaGroup'); if (g && g.scrollIntoView) g.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }

    function currentQuote(assume) {
        if (typeof CoyoteZones === 'undefined' || !CoyoteZones.priceQuote) {
            console.error('CoyoteZones not loaded — include ../js/zones.js before order.js');
            return { miles: 0, beach: false, requiredClass: '2wd', total: 0 };
        }
        const serviceType = document.querySelector('input[name="serviceType"]:checked').value;
        const pickupCity = pricedTown('pickup', assume);
        const dropoffCity = pricedTown('dropoff', assume) || pickupCity;
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
        const dateObj = serviceInstant(date, time);
        const C = window.CoyoteCoastal;
        const dateTimeStr = !dateObj ? '--' : (C && typeof C.formatCentral === 'function')
            ? C.formatCentral(dateObj)
            : dateObj.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        let details = '';
        if (serviceType === 'ride') {
            const passengers = document.querySelector('input[name="passengers"]:checked').value;
            details = `${passengers} passenger${passengers === '1' ? '' : 's'}`;
        } else {
            const size = document.querySelector('input[name="packageSize"]:checked').value;
            details = `${size.charAt(0).toUpperCase() + size.slice(1)} package`;
        }
        updateZipAreaQuestions();
        const priced = currentQuote();
        const estimatedTotal = priced.total;
        document.getElementById('reviewService').textContent = serviceLabels[serviceType] || serviceType;
        document.getElementById('reviewDateTime').textContent = dateTimeStr;
        document.getElementById('reviewPickup').textContent = pickup;
        document.getElementById('reviewDropoff').textContent = dropoff;
        document.getElementById('reviewDetails').textContent = priced.beach
            ? `${details} · ${priced.miles} mi · 4x4 + $8 sand`
            : `${details} · ${priced.miles} mi`;
        const pending = unansweredZipAreas();
        if (pending.length) {
            // Not answered yet: show both possible totals until they choose.
            const islandTotal = currentQuote(Object.fromEntries(pending.map(e => [e, 'island']))).total;
            document.getElementById('reviewTotal').textContent = `$${estimatedTotal.toFixed(2)} (Flour Bluff) or $${islandTotal.toFixed(2)} (Padre Island) · choose above`;
        } else {
            document.getElementById('reviewTotal').textContent = `$${estimatedTotal.toFixed(2)}`;
        }
        const tbody = document.getElementById('summaryBody');
        const firstName = document.getElementById('customerFirstName').value;
        const lastName = document.getElementById('customerLastName').value;
        const email = document.getElementById('customerEmail').value;
        const phone = document.getElementById('customerPhone').value;
        const rows = [['Name', `${firstName} ${lastName}`], ['Phone', phone]];
        if (email) rows.push(['Email', email]);
        tbody.innerHTML = rows.map(([label, val]) => `<tr><th>${label}</th><td>${escapeHtml(val)}</td></tr>`).join('');
    }

    // One idempotency key per order, kept (sessionStorage) across edits and
    // reloads until an order succeeds; see CoyoteCoastal.checkoutSession.
    // A retry reuses the key and the exact payload; an edit reuses the key
    // with the new details. create-order then makes the order (first try never
    // arrived) or answers 422 checkout_changed naming the order the first try
    // made, so an edit after a timeout can never create a second order.
    function newIdempotencyKey() {
        const c = window.crypto;
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
        const bytes = new Uint8Array(16);
        if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
        else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }

    const checkoutState = (window.CoyoteCoastal && typeof window.CoyoteCoastal.checkoutSession === 'function')
        ? window.CoyoteCoastal.checkoutSession(undefined, newIdempotencyKey)
        : (function () { // memory-only fallback if coastal.js is missing
            let key = null, payload = null;
            return {
                key: () => key || (key = newIdempotencyKey()),
                attemptPayload: (d) => (payload && payload.idempotency_key === d.idempotency_key ? payload : (payload = d)),
                edited: () => { payload = null; },
                clear: () => { key = null; payload = null; },
            };
        })();

    function checkoutIdempotencyKey() { return checkoutState.key(); }
    function attemptPayload(orderData) { return checkoutState.attemptPayload(orderData); }

    // Editing keeps the key (so the server can tell us if the first try went
    // through) but sends the new details instead of the frozen payload.
    function checkoutEdited(e) {
        if (e && e.target && e.target.id === 'termsAgree') return;
        checkoutState.edited();
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    let submitting = false;

    function orderErrorMessage(result) {
        const C = window.CoyoteCoastal;
        if (C && typeof C.orderErrorMessage === 'function') return C.orderErrorMessage(result);
        return 'Something went wrong placing your order. Please try again or call (361) 555-1234.';
    }

    // Inline, screen-reader-announced errors instead of alert() popups.
    function showSubmitError(message) {
        const box = document.getElementById('orderSubmitError');
        if (!box) { alert(message); return; }
        box.textContent = message;
        box.hidden = false;
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Keyboard users land on the message (it's also role=alert for screen readers).
        try { box.focus({ preventScroll: true }); } catch (e) { box.focus(); }
    }

    // create-order names the bad route field (town/ZIP checks); highlight it on
    // the Route step so "go back and fix" lands on the right input.
    const SERVER_FIELDS = { pickup_city: 'pickupCity', pickup_zip: 'pickupZip', dropoff_city: 'dropoffCity', dropoff_zip: 'dropoffZip' };
    function markServerField(result) {
        const f = result && result.data && result.data.field;
        const zipArea = /^(pickup|dropoff)_zip_area$/.exec(f || '');
        if (zipArea) {
            // Server needs the island/mainland answer: show the question here.
            updateZipAreaQuestions();
            const group = document.getElementById(zipArea[1] + 'ZipAreaGroup');
            if (group) group.hidden = false;
            setZipAreaError(zipArea[1], true);
            return;
        }
        const id = Object.prototype.hasOwnProperty.call(SERVER_FIELDS, f) ? SERVER_FIELDS[f] : null;
        const el = id && document.getElementById(id);
        if (!el) return;
        // Not showError(): its text ("Please enter a city.") would be wrong here;
        // the server's message is shown in the submit error box.
        el.classList.add('error');
        el.setAttribute('aria-invalid', 'true');
        linkError(el, document.getElementById('orderSubmitError'), true);
        const clear = () => {
            el.classList.remove('error');
            el.setAttribute('aria-invalid', 'false');
            linkError(el, document.getElementById('orderSubmitError'), false);
        };
        el.addEventListener('change', clear, { once: true });
        el.addEventListener('input', clear, { once: true });
    }

    function clearSubmitError() {
        const box = document.getElementById('orderSubmitError');
        if (box) { box.textContent = ''; box.hidden = true; }
    }

    function setTermsError(show) {
        const terms = document.getElementById('termsAgree');
        const msg = document.getElementById('termsError');
        if (msg) msg.hidden = !show;
        if (terms) terms.setAttribute('aria-invalid', show ? 'true' : 'false');
        linkError(terms, msg, !!show);
    }

    // Slow/dropped connection: inline message + Retry. Retry goes through
    // submitOrder() again, which reuses the same idempotency key and payload
    // (checkoutState.key/attemptPayload), so the server returns the order it may
    // already have made instead of creating a second one.
    const retryBtn = document.getElementById('orderRetryBtn');
    const submitStatus = document.getElementById('orderSubmitStatus');
    function announce(text) { if (submitStatus) submitStatus.textContent = text || ''; }
    function showRetry(show) { if (retryBtn) { retryBtn.hidden = !show; retryBtn.disabled = false; } }
    let lastFailureWasNetwork = false;
    if (retryBtn) retryBtn.addEventListener('click', () => submitOrder({ preventDefault() {} }));
    window.addEventListener('online', () => { if (lastFailureWasNetwork && retryBtn && !retryBtn.hidden) announce("You're back online. Tap Retry to finish your order."); });

    // ── "Your first order went through" (edit/reload after a lost response) ──
    let firstOrder = null;
    // While the panel is up, Place Order is hidden: resending would only get
    // the same answer. "Place a different order" brings it back.
    function setOrderNavHidden(hide) {
        const nav = submitBtn && submitBtn.closest ? submitBtn.closest('.form-nav') : null;
        if (nav) nav.hidden = !!hide;
    }
    function hideCheckoutConflict() {
        const panel = document.getElementById('firstOrderPanel');
        if (panel) panel.hidden = true;
        setOrderNavHidden(false);
        firstOrder = null;
    }
    /** Handles 422 checkout_changed / 409 checkout_used. Returns true if shown. */
    function showCheckoutConflict(result) {
        const C = window.CoyoteCoastal;
        const conflict = C && typeof C.checkoutConflict === 'function' ? C.checkoutConflict(result) : null;
        const panel = document.getElementById('firstOrderPanel');
        if (!conflict || !panel) return false;
        lastFailureWasNetwork = false;
        showRetry(false);
        const known = conflict.kind === 'changed';
        const o = known ? conflict.order : null;
        firstOrder = o;
        document.getElementById('firstOrderTitle').textContent = known ? 'Your first order went through' : 'This checkout was already used';
        const text = document.getElementById('firstOrderText');
        if (known) {
            const when = o.isAsap ? 'ASAP' : `${o.scheduledDate || ''} ${String(o.scheduledTime || '').slice(0, 5)} Central`.trim();
            const route = o.dropoffCity && o.dropoffCity !== o.pickupCity ? `${o.pickupCity} → ${o.dropoffCity}` : o.pickupCity;
            const price = Number(o.estimatedPrice) ? ` · $${Number(o.estimatedPrice).toFixed(2)}` : '';
            text.textContent = `Order ${o.orderNumber} was placed with the details you sent first (${route} · ${when}${price}), before your changes. We did not place a second order.`;
            if (o.trackingToken && C.saveTrackingToken) C.saveTrackingToken(o.orderNumber, o.trackingToken);
        } else {
            text.textContent = 'An earlier try from this page used a different phone number, so we can\'t show that order here. If you placed it, use the text or order number you got to track it.';
        }
        const track = document.getElementById('firstOrderTrack');
        if (track) { track.hidden = !known; if (known) track.href = C.buildTrackUrl(o.orderNumber); }
        const pay = document.getElementById('firstOrderPay');
        if (pay) pay.hidden = !(known && window.CoyoteCheckout && o.paymentStatus !== 'paid' && o.orderId && Number(o.estimatedPrice) > 0);
        panel.hidden = false;
        setOrderNavHidden(true);
        announce(document.getElementById('firstOrderTitle').textContent + '. ' + text.textContent);
        if (panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const heading = document.getElementById('firstOrderTitle');
        if (heading) { try { heading.focus({ preventScroll: true }); } catch (e) { heading.focus(); } }
        return true;
    }
    // Explicit choice: a second, separate order with the current details.
    function startDifferentOrder() {
        checkoutState.clear();
        hideCheckoutConflict();
        clearSubmitError();
        announce('Started a new order. Check your details, then tap Place Order.');
        if (submitBtn && submitBtn.focus) submitBtn.focus();
    }
    // Finish the order that already exists: card checkout when it's on (amount
    // comes from the server), otherwise the normal confirmation (pay driver).
    async function payFirstOrder() {
        const o = firstOrder;
        if (!o || !window.CoyoteCheckout) return;
        lastBooking = {
            asap: o.isAsap, date: o.scheduledDate, time: String(o.scheduledTime || '').slice(0, 5),
            pickupCity: o.pickupCity, dropoffCity: o.dropoffCity,
            amount: Number(o.estimatedPrice) || 0, phone: document.getElementById('customerPhone').value.trim(), smsSent: false,
        };
        const ctx = { orderId: o.orderId, orderNumber: o.orderNumber, amount: Number(o.estimatedPrice) || 0, trackingToken: o.trackingToken || null };
        checkoutState.clear(); // this order is the one we are finishing
        let handled = false;
        try { handled = await window.CoyoteCheckout.afterOrderCreated(ctx); } catch (err) { console.error(err); }
        if (!handled) showSuccess(ctx);
    }

    async function submitOrder(e) {
        e.preventDefault();
        if (submitting) return; // guard double clicks / Enter-key resubmits
        const terms = document.getElementById('termsAgree');
        clearSubmitError();
        hideCheckoutConflict();
        if (!terms.checked) {
            setTermsError(true);
            terms.focus();
            return;
        }
        setTermsError(false);
        const needArea = unansweredZipAreas();
        if (needArea.length) {
            needArea.forEach(end => setZipAreaError(end, true));
            focusZipArea(needArea[0]);
            return;
        }
        submitting = true;
        submitBtn.disabled = true;
        if (retryBtn) retryBtn.disabled = true;
        announce(lastFailureWasNetwork ? 'Retrying. Checking whether your order already went through…' : 'Placing your order…');
        const originalText = submitBtn.textContent;
        submitBtn.innerHTML = '<span class="spinner"></span> Placing Order...';
        const serviceType = document.querySelector('input[name="serviceType"]:checked').value;
        const dateVal = document.getElementById('serviceDate').value;
        const timeVal = document.getElementById('serviceTime').value;
        const now = new Date();
        const chosen = serviceInstant(dateVal, timeVal);
        const isAsap = !chosen || chosen <= new Date(now.getTime() + 60 * 60 * 1000);
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
            // Only set for ZIP 78418 with Corpus Christi ('island' | 'mainland').
            pickup_zip_area: zipAreaAnswer('pickup'),
            dropoff_zip_area: zipAreaAnswer('dropoff'),
            schedule: isAsap ? 'asap' : 'later',
            scheduled_date: isAsap ? null : dateVal,
            scheduled_time: isAsap ? null : timeVal,
            // Explicit offset so the server never guesses the zone (e.g. "2026-10-18T21:30:00-05:00").
            scheduled_at: isAsap ? null : serviceIso(dateVal, timeVal),
            passenger_count: serviceType === 'ride' ? parseInt(document.querySelector('input[name="passengers"]:checked').value) : null,
            package_size: serviceType === 'package_delivery' ? document.querySelector('input[name="packageSize"]:checked').value : null,
            package_description: document.getElementById('itemDescription')?.value.trim() || null,
            special_instructions: document.getElementById('specialInstructions').value.trim() || null,
            idempotency_key: checkoutIdempotencyKey(),
        };
        try {
            const C = window.CoyoteCoastal;
            let result = await CoyoteAPI.post('/api/create-order', attemptPayload(orderData),
                { timeoutMs: C && C.requestTimeoutMs ? C.requestTimeoutMs() : 15000 });
            // A 200 we can't read (proxy/captive-portal page, cut-off body) is not a
            // confirmation: don't show "Order Confirmed" with no order number. We
            // can't tell if the order was made, so treat it like a lost answer
            // (Retry re-checks under the same key, no second order).
            if (result.ok && !(result.data && typeof result.data === 'object' && result.data.orderNumber && result.data.orderId)) {
                console.error('create-order: unreadable success response');
                result = { ok: false, status: 0, error: 'unreadable response', timedOut: true, network: true };
            }
            const netKind = C && C.networkFailureKind ? C.networkFailureKind(result) : null;
            lastFailureWasNetwork = !!netKind;
            showRetry(!!netKind);
            announce(result.ok ? 'Order placed.' : '');
            // This checkout already made an order (first try's answer was lost).
            if (!result.ok && showCheckoutConflict(result)) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalText;
                submitting = false;
                return;
            }
            if (result.ok) {
                // Keep the checkout key until the order is finished (showSuccess:
                // paid, pay-driver, already paid). A reload on the card form then
                // resends under the same key and gets this order back instead of
                // creating a second, unpaid one.
                lastBooking = {
                    asap: isAsap, date: dateVal, time: timeVal,
                    pickupAddress: orderData.pickup_address, pickupCity: pricedTown('pickup'),
                    dropoffAddress: orderData.dropoff_address, dropoffCity: orderData.dropoff_city ? pricedTown('dropoff') : null,
                    amount: Number(result.data.estimatedPrice) || 0,
                    phone: orderData.phone, smsSent: result.data.smsSent === true,
                };
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
                markServerField(result);
                showSubmitError(orderErrorMessage(result));
                if (result.data && result.data.code === 'zip_area_required') {
                    const m = /^(pickup|dropoff)/.exec(result.data.field || '');
                    if (m) focusZipArea(m[1]);
                }
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalText;
                submitting = false;
            }
        } catch (err) {
            console.error('Order submission failed:', err);
            announce('');
            if (retryBtn) retryBtn.disabled = false;
            showSubmitError(orderErrorMessage({ ok: false, status: 500 }));
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalText;
            submitting = false;
        }
    }

    const trackBtn = document.getElementById('trackBtn');
    if (trackBtn) trackBtn.addEventListener('click', trackOrder);
    const trackOrderNumber = document.getElementById('trackOrderNumber');
    if (trackOrderNumber) trackOrderNumber.addEventListener('keydown', e => { if (e.key === 'Enter') trackOrder(); });

    function trackMessage(text) {
        const box = document.getElementById('trackMessage');
        if (!box) { if (text) alert(text); return; }
        box.textContent = text || '';
        box.hidden = !text;
    }

    function trackErrorMessage(kind) {
        const C = window.CoyoteCoastal;
        if (C && typeof C.trackErrorMessage === 'function') return C.trackErrorMessage(kind);
        return kind === 'missing'
            ? 'Enter both your order number and the phone number used for the order.'
            : "We couldn't find that order. Check the order number and phone number.";
    }

    async function trackOrder() {
        const numEl = document.getElementById('trackOrderNumber');
        const phoneEl = document.getElementById('trackPhone');
        const orderNum = numEl.value.trim().toUpperCase();
        const phone = phoneEl.value.trim();
        numEl.setAttribute('aria-invalid', orderNum ? 'false' : 'true');
        phoneEl.setAttribute('aria-invalid', phone ? 'false' : 'true');
        if (!orderNum || !phone) {
            trackMessage(trackErrorMessage('missing'));
            (orderNum ? phoneEl : numEl).focus();
            return;
        }
        trackMessage('');
        document.getElementById('trackingResult').classList.remove('active');
        const btn = document.getElementById('trackBtn');
        btn.disabled = true;
        btn.textContent = 'Tracking...';
        try {
            const C = window.CoyoteCoastal;
            const timeoutMs = C && C.requestTimeoutMs ? C.requestTimeoutMs() : 15000; // no stuck "Tracking..."
            const auth = await CoyoteAPI.post('/api/get-orders', { order_number: orderNum, phone: phone }, { timeoutMs });
            // 200 but not our JSON (proxy page): "try again", not "not found".
            if (auth.ok && (!auth.data || typeof auth.data !== 'object')) {
                trackMessage(trackErrorMessage({ ok: false, status: 500 }));
                return;
            }
            if (!auth.ok || !auth.data || !auth.data.token) {
                trackMessage(trackErrorMessage(auth));
                return;
            }
            const result = await CoyoteAPI.request('/api/get-orders', {
                method: 'GET',
                headers: { Authorization: 'Bearer ' + auth.data.token },
                timeoutMs
            });
            if (result.ok && result.data && (Array.isArray(result.data.data) ? result.data.data.length > 0 : result.data.data)) {
                const order = Array.isArray(result.data.data) ? result.data.data[0] : result.data.data;
                displayTrackingResult(order);
            } else {
                trackMessage(trackErrorMessage(result.ok ? { ok: true, status: 404 } : result));
            }
        } catch (err) {
            console.error('Tracking failed:', err);
            trackMessage(trackErrorMessage({ ok: false, status: 500 }));
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
        statusEl.textContent = window.CoyoteCoastal && window.CoyoteCoastal.statusLabel ? window.CoyoteCoastal.statusLabel(order.status) : String(order.status || '').replace(/_/g, ' ');
        statusEl.className = 'status-badge-track ' + order.status;
        document.getElementById('trackingService').textContent = serviceLabels[order.service_type] || order.service_type;
        document.getElementById('trackingScheduled').textContent = order.is_asap ? 'ASAP' : `${order.scheduled_date} at ${String(order.scheduled_time || '').slice(0, 5)} Central`;
        document.getElementById('trackingPickup').textContent = `${order.pickup_address}, ${order.pickup_city}`;
        document.getElementById('trackingDropoff').textContent = order.dropoff_address ? `${order.dropoff_address}, ${order.dropoff_city || order.pickup_city}` : 'Same as pickup';
        document.getElementById('trackingPrice').textContent = order.estimated_price ? `$${parseFloat(order.estimated_price).toFixed(2)}` : '—';
        document.getElementById('trackingDriver').textContent = order.status === 'cancelled' ? 'None (order cancelled)' : order.driver_id ? 'Assigned' : 'Not yet assigned';
        const payBox = document.getElementById('trackingPaymentStatus');
        if (payBox && window.CoyoteCoastal && window.CoyoteCoastal.paymentBadge) {
            const b = window.CoyoteCoastal.paymentBadge(order);
            const badge = document.createElement('span');
            badge.className = 'payment-status-badge ' + b.cls;
            badge.textContent = b.label;
            payBox.replaceChildren(badge);
        }
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
        const partner = params.restaurant && C ? C.partnerBySlug(params.restaurant) : null;
        // Partner names come from a fixed whitelist and are only ever set via .value/.textContent.
        const pickupAddr = document.getElementById('pickupAddress');
        if (partner && pickupAddr && !pickupAddr.value) pickupAddr.value = partner.name;
        const noteParts = [];
        if (cat && cat.note) noteParts.push(cat.note);
        if (partner) noteParts.push(partner.name);
        if (params.q) noteParts.push(params.q);
        const item = document.getElementById('itemDescription');
        if (item && noteParts.length && !item.value) item.value = noteParts.join(': ');
        const banner = document.getElementById('ccPrefillNote');
        if (banner && (cat || params.pickup || partner)) {
            const bits = [];
            if (partner) bits.push(partner.name);
            else if (cat) bits.push(cat.label);
            if (params.pickup && params.dropoff) bits.push(`${params.pickup} → ${params.dropoff}`);
            else if (params.pickup) bits.push(`near ${params.pickup}`);
            banner.textContent = 'Starting your order: ' + bits.join(' · ');
            banner.hidden = false;
        }
        // Unknown ?restaurant= slug: fixed text only (the slug is never shown).
        const partnerNote = document.getElementById('ccPartnerNote');
        if (partnerNote && params.restaurantUnknown) {
            const link = document.createElement('a');
            link.href = '/#partners-menu';
            link.textContent = 'Choose a partner';
            partnerNote.textContent = "We couldn't find that partner. ";
            partnerNote.appendChild(link);
            partnerNote.appendChild(document.createTextNode(' or start a regular order below.'));
            partnerNote.hidden = false;
        }
    }

    // The <head> script reserved space for the note/quote; real content is in place now.
    function releaseReservedSpace() {
        document.documentElement.classList.remove('cc-pre-note-1', 'cc-pre-note-2', 'cc-pre-quote', 'cc-pre-partner');
    }
    window.addEventListener('load', releaseReservedSpace);

    // Live quote chip: same numbers create-order stores as estimated_price.
    function updateLiveQuote() {
        const box = document.getElementById('ccLiveQuote');
        if (!box) return;
        const pickupCity = document.getElementById('pickupCity').value;
        if (!pickupCity || typeof CoyoteZones === 'undefined') { box.hidden = true; return; }
        const q = currentQuote();
        const dropoffCity = pricedTown('dropoff') || pricedTown('pickup');
        const ask = unansweredZipAreas().length ? ' · ZIP 78418: confirm island or Flour Bluff on Review' : '';
        document.getElementById('ccLiveQuoteText').textContent =
            `${pricedTown('pickup')} → ${dropoffCity} · ${q.miles} mi${q.beach ? ' · 4x4 beach access' : ''}${ask}`;
        document.getElementById('ccLiveQuoteTotal').textContent = `$${q.total.toFixed(2)}`;
        box.hidden = false;
    }

    // Success screen shared by cash and card flows (stripe-payment.js calls this too).
    let lastBooking = null;
    // Booking summary + accurate "what happens next" (textContent only).
    function renderConfirmationDetails(paid) {
        const C = window.CoyoteCoastal;
        if (!C || !lastBooking) return;
        const dl = document.getElementById('ccConfirmSummary');
        if (dl) {
            dl.textContent = '';
            C.confirmationSummary(Object.assign({}, lastBooking, { paid: !!paid })).forEach(([label, value]) => {
                const dt = document.createElement('dt'); dt.textContent = label;
                const dd = document.createElement('dd'); dd.textContent = value;
                dl.appendChild(dt); dl.appendChild(dd);
            });
            dl.hidden = !dl.children.length;
        }
        const next = document.getElementById('ccNextSteps');
        if (next) { next.textContent = C.confirmationNextSteps(lastBooking); next.hidden = false; }
    }

    function showSuccess(ctx) {
        checkoutState.clear(); // order finished: the next booking is a new order
        const c = ctx || {};
        renderConfirmationDetails(c.paid);
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
        // Focus the confirmation heading so it is announced and Tab continues
        // from here (the form that had focus is now hidden).
        const heading = orderSuccess.querySelector('h2');
        if (heading) {
            heading.setAttribute('tabindex', '-1');
            try { heading.focus({ preventScroll: true }); } catch (_) { heading.focus(); }
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function init() {
        initDateTime();
        initFromUrl();
        updateServiceType();
        document.querySelectorAll('input[name="serviceType"]').forEach(radio => radio.addEventListener('change', updateServiceType));
        const swapBtn = document.getElementById('swapLocations');
        if (swapBtn) swapBtn.addEventListener('click', () => { swapLocations(); updateLiveQuote(); });
        document.querySelectorAll('.next-step').forEach(btn => btn.addEventListener('click', () => goToStep(parseInt(btn.dataset.next, 10))));
        document.querySelectorAll('.prev-step').forEach(btn => btn.addEventListener('click', () => goToStep(parseInt(btn.dataset.prev, 10))));
        setupCardSelection('#rideDetails', 'passengers');
        setupCardSelection('#deliveryDetails', 'packageSize');
        form.addEventListener('input', checkoutEdited);
        form.addEventListener('change', checkoutEdited);
        document.querySelectorAll('.detail-card').forEach(c => c.addEventListener('click', checkoutEdited));
        const swapForKey = document.getElementById('swapLocations');
        if (swapForKey) swapForKey.addEventListener('click', checkoutEdited); // swap sets .value, no input event
        const newOrderBtn = document.getElementById('firstOrderNew');
        if (newOrderBtn) newOrderBtn.addEventListener('click', startDifferentOrder);
        const payFirstBtn = document.getElementById('firstOrderPay');
        if (payFirstBtn) payFirstBtn.addEventListener('click', payFirstOrder);
        ['pickupAddress', 'pickupCity', 'pickupZip', 'dropoffAddress', 'dropoffCity', 'dropoffZip', 'customerFirstName', 'customerLastName', 'customerPhone', 'customerEmail'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', () => showError(el, false));
        });
        ['pickupCity', 'dropoffCity', 'pickupZip', 'dropoffZip'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', updateLiveQuote);
        });
        document.querySelectorAll('input[name="serviceType"], input[name="passengers"], input[name="packageSize"]').forEach(r => r.addEventListener('change', updateLiveQuote));
        document.querySelectorAll('#rideDetails .detail-card, #deliveryDetails .detail-card').forEach(c => c.addEventListener('click', updateLiveQuote));
        updateLiveQuote();
        releaseReservedSpace();
        ZIP_AREA_ENDS.forEach(end => document.querySelectorAll(`input[name="${end}ZipArea"]`).forEach(r => r.addEventListener('change', () => {
            setZipAreaError(end, false);
            buildReviewSummary();
            updateLiveQuote();
            announce(`Estimated total updated: ${document.getElementById('reviewTotal').textContent}`);
        })));
        const termsBox = document.getElementById('termsAgree');
        if (termsBox) termsBox.addEventListener('change', () => { if (termsBox.checked) setTermsError(false); });
        form.addEventListener('submit', submitOrder);
        window.CoyoteOrder = { showSuccess: showSuccess, goToStep: goToStep, currentQuote: currentQuote };
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
