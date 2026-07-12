/**
 * Coyote's Dune Delivery — Driver Portal JavaScript
 * Includes: auth, profile, documents, and GPS location sharing (Go Online)
 */

(function() {
    'use strict';

    const API_BASE = '/api';
    const GPS_POST_INTERVAL_MS = 30000; // 30 seconds

    let session = null;
    let pendingFiles = [];
    let gpsWatchId = null;
    let gpsPostTimer = null;
    let lastPosition = null;
    let isOnline = false;

    /* ===== DOM refs ===== */
    const loginScreen = document.getElementById('login-screen');
    const portal = document.getElementById('portal');
    const loginForm = document.getElementById('login-form');
    const loginError = document.getElementById('login-error');
    const logoutBtn = document.getElementById('logout-btn');

    const statusTitle = document.getElementById('status-title');
    const statusMessage = document.getElementById('status-message');
    const statusBadge = document.getElementById('status-badge');
    const approvedContent = document.getElementById('approved-content');
    const nonApprovedMessage = document.getElementById('non-approved-message');

    const profileDisplay = document.getElementById('profile-display');
    const profileEdit = document.getElementById('profile-edit');
    const profileGrid = document.getElementById('profile-grid');
    const editProfileBtn = document.getElementById('edit-profile-btn');
    const cancelEditBtn = document.getElementById('cancel-edit-btn');
    const profileForm = document.getElementById('profile-form');
    const profileSaveError = document.getElementById('profile-save-error');

    const uploadDropzone = document.getElementById('upload-dropzone');
    const uploadInput = document.getElementById('upload-input');
    const uploadPreview = document.getElementById('upload-preview');
    const uploadSubmit = document.getElementById('upload-submit');
    const driverDocsList = document.getElementById('driver-docs-list');

    const toastContainer = document.getElementById('toast-container');

    /* ===== GPS / Go Online refs ===== */
    const goOnlineBtn = document.getElementById('go-online-btn');
    const gpsStatus = document.getElementById('gps-status');
    const gpsIndicator = document.getElementById('gps-indicator');

    /* ===== Init ===== */
    function init() {
        const saved = localStorage.getItem('driver_session');
        if (saved) {
            try { session = JSON.parse(saved); } catch (e) { session = null; }
        }
        if (session && session.applicantId && session.email) {
            showPortal();
            loadStatus();
        } else {
            showLogin();
        }
        bindEvents();

        // Restore online state if page was refreshed
        if (session && session.isOnline) {
            startGPSTracking();
        }
    }

    /* ===== Auth / Session ===== */
    function showLogin() {
        loginScreen.style.display = '';
        portal.style.display = 'none';
    }

    function showPortal() {
        loginScreen.style.display = 'none';
        portal.style.display = '';
    }

    function saveSession() {
        localStorage.setItem('driver_session', JSON.stringify(session));
    }

    function clearSession() {
        stopGPSTracking();
        session = null;
        localStorage.removeItem('driver_session');
    }

    async function api(method, endpoint, body) {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' }
        };
        if (body) opts.body = JSON.stringify(body);
        return fetch(API_BASE + endpoint, opts).then(async r => {
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
                const err = new Error(data.message || data.error || `HTTP ${r.status}`);
                err.status = r.status; err.data = data; throw err;
            }
            return data;
        });
    }

    async function onLogin(e) {
        e.preventDefault();
        loginError.textContent = '';
        const applicantId = document.getElementById('applicant-id').value.trim();
        const email = document.getElementById('login-email').value.trim().toLowerCase();
        if (!applicantId || !email) { loginError.textContent = 'Please fill in both fields.'; return; }
        try {
            const data = await api('POST', '/get-status', { applicantId, email });
            session = { applicantId, email, data };
            saveSession();
            showPortal();
            renderStatus(data);
            showToast('Welcome back!', 'success');

            // ── Analytics: Driver portal login ───────────────
            if (typeof trackEvent === 'function') {
                trackEvent('driver', 'login_success');
            }
            if (typeof firebaseTrackEvent === 'function') {
                firebaseTrackEvent('driver_login_success', { applicant_id: applicantId });
            }
            if (typeof logAnalyticsEvent === 'function') {
                logAnalyticsEvent('driver_login_success', {
                    category: 'driver',
                    applicant_id: applicantId,
                });
            }
        } catch (err) {
            loginError.textContent = err.message || 'Login failed. Check your ID and email.';

            // ── Analytics: Driver portal login failed ────────
            if (typeof trackEvent === 'function') {
                trackEvent('driver', 'login_failed');
            }
            if (typeof firebaseTrackEvent === 'function') {
                firebaseTrackEvent('driver_login_failed', { applicant_id: applicantId });
            }
        }
    }

    function onLogout() {
        clearSession();
        showLogin();
        showToast('Logged out', 'success');

        if (typeof trackEvent === 'function') {
            trackEvent('driver', 'logout');
        }
    }

    async function loadStatus() {
        if (!session) return;
        try {
            const data = await api('POST', '/get-status', { applicantId: session.applicantId, email: session.email });
            session.data = data;
            saveSession();
            renderStatus(data);
        } catch (err) {
            showToast('Failed to refresh status', 'error');
            console.error(err);
        }
    }

    /* ===== Render Status & Profile ===== */
    function renderStatus(data) {
        const status = data.status || 'pending';
        const name = data.name || 'Driver';
        statusBadge.className = 'status-badge ' + status;
        statusBadge.textContent = status.replace(/_/g, ' ');

        if (status === 'approved') {
            statusTitle.textContent = `Welcome, ${esc(name)}!`;
            statusMessage.textContent = 'Your application was approved. You are active as a driver.';
            approvedContent.style.display = '';
            nonApprovedMessage.style.display = 'none';
            renderProfile(data);
            renderDocuments(data.documents || []);
        } else if (status === 'rejected') {
            statusTitle.textContent = `Hello, ${esc(name)}`;
            statusMessage.textContent = 'Your application was not approved at this time.';
            approvedContent.style.display = 'none';
            nonApprovedMessage.style.display = '';
        } else if (status === 'on_hold') {
            statusTitle.textContent = `Hello, ${esc(name)}`;
            statusMessage.textContent = 'Your application is on hold. We may need additional information.';
            approvedContent.style.display = 'none';
            nonApprovedMessage.style.display = '';
        } else if (status === 'background_check') {
            statusTitle.textContent = `Hello, ${esc(name)}`;
            statusMessage.textContent = 'We are currently processing your background check.';
            approvedContent.style.display = 'none';
            nonApprovedMessage.style.display = 'none';
        } else {
            statusTitle.textContent = `Hello, ${esc(name)}`;
            statusMessage.textContent = 'Your application is pending review. We will update you soon.';
            approvedContent.style.display = 'none';
            nonApprovedMessage.style.display = 'none';
        }
    }

    function renderProfile(data) {
        const fields = [
            ['Full Name', data.name],
            ['Email', data.email],
            ['Phone', data.phone],
            ['Date of Birth', data.dob],
            ['Address', [data.address, data.city, data.state, data.zip].filter(Boolean).join(', ')],
            ['Vehicle', [data.vehicle_year, data.vehicle_make, data.vehicle_model].filter(Boolean).join(' ')],
            ['License Plate', data.vehicle_plate],
            ['Insurance', data.insurance_provider],
            ['Policy Number', data.insurance_policy],
            ['Bank', data.bank_name],
            ['Account Number', data.bank_account],
            ['Routing Number', data.bank_routing],
        ];
        profileGrid.innerHTML = fields.map(([label, value]) => `
            <div class="info-field">
                <label>${esc(label)}</label>
                <span>${esc(value || '—')}</span>
            </div>
        `).join('');

        // Pre-fill edit form
        document.getElementById('edit-phone').value = data.phone || '';
        document.getElementById('edit-vehicle-make').value = data.vehicle_make || '';
        document.getElementById('edit-vehicle-model').value = data.vehicle_model || '';
        document.getElementById('edit-vehicle-year').value = data.vehicle_year || '';
        document.getElementById('edit-vehicle-plate').value = data.vehicle_plate || '';
        document.getElementById('edit-insurance-provider').value = data.insurance_provider || '';
        document.getElementById('edit-insurance-policy').value = data.insurance_policy || '';
        document.getElementById('edit-bank-name').value = data.bank_name || '';
        document.getElementById('edit-bank-account').value = data.bank_account || '';
        document.getElementById('edit-bank-routing').value = data.bank_routing || '';
    }

    /* ===== Edit Profile ===== */
    function openEdit() {
        profileDisplay.style.display = 'none';
        profileEdit.style.display = '';
        editProfileBtn.style.display = 'none';
    }

    function closeEdit() {
        profileDisplay.style.display = '';
        profileEdit.style.display = 'none';
        editProfileBtn.style.display = '';
        profileSaveError.textContent = '';
    }

    async function onSaveProfile(e) {
        e.preventDefault();
        profileSaveError.textContent = '';
        const payload = {
            phone: document.getElementById('edit-phone').value.trim(),
            vehicle_make: document.getElementById('edit-vehicle-make').value.trim(),
            vehicle_model: document.getElementById('edit-vehicle-model').value.trim(),
            vehicle_year: document.getElementById('edit-vehicle-year').value.trim(),
            vehicle_plate: document.getElementById('edit-vehicle-plate').value.trim(),
            insurance_provider: document.getElementById('edit-insurance-provider').value.trim(),
            insurance_policy: document.getElementById('edit-insurance-policy').value.trim(),
            bank_name: document.getElementById('edit-bank-name').value.trim(),
            bank_account: document.getElementById('edit-bank-account').value.trim(),
            bank_routing: document.getElementById('edit-bank-routing').value.trim(),
        };
        try {
            await api('PUT', '/update-application?' + new URLSearchParams({ applicantId: session.applicantId }), payload);
            Object.assign(session.data, payload);
            saveSession();
            renderProfile(session.data);
            closeEdit();
            showToast('Profile updated', 'success');
        } catch (err) {
            profileSaveError.textContent = err.message || 'Failed to save profile';
        }
    }

    /* ===== Upload ===== */
    function onDragOver(e) { e.preventDefault(); uploadDropzone.classList.add('dragover'); }
    function onDragLeave(e) { e.preventDefault(); uploadDropzone.classList.remove('dragover'); }
    function onDrop(e) {
        e.preventDefault();
        uploadDropzone.classList.remove('dragover');
        const files = Array.from(e.dataTransfer.files);
        addFiles(files);
    }
    function onFileInputChange(e) {
        addFiles(Array.from(e.target.files));
        e.target.value = '';
    }

    function addFiles(files) {
        files.forEach(f => { if (!pendingFiles.some(p => p.name === f.name && p.size === f.size)) pendingFiles.push(f); });
        renderUploadPreview();
    }

    function renderUploadPreview() {
        uploadPreview.innerHTML = pendingFiles.map((f, i) => `
            <div class="preview-item">
                <span>${esc(f.name)}</span>
                <button data-remove="${i}" title="Remove">&times;</button>
            </div>
        `).join('');
        uploadSubmit.style.display = pendingFiles.length ? '' : 'none';
    }

    function removeFile(e) {
        const btn = e.target.closest('button[data-remove]');
        if (!btn) return;
        const idx = parseInt(btn.dataset.remove);
        pendingFiles.splice(idx, 1);
        renderUploadPreview();
    }

    async function onUploadSubmit() {
        if (!pendingFiles.length) return;
        const fd = new FormData();
        fd.append('applicantId', session.applicantId);
        fd.append('email', session.email);
        pendingFiles.forEach(f => fd.append('documents', f));
        try {
            const res = await fetch(API_BASE + '/update-application/' + session.applicantId + '/documents', { method: 'POST', body: fd });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || 'Upload failed');
            pendingFiles = [];
            renderUploadPreview();
            showToast('Documents uploaded', 'success');
            loadStatus();
        } catch (err) {
            showToast(err.message || 'Upload failed', 'error');
        }
    }

    function renderDocuments(docs) {
        if (!docs.length) {
            driverDocsList.innerHTML = '<p style="font-size:13px;color:var(--muted);">No documents on file.</p>';
            return;
        }
        driverDocsList.innerHTML = docs.map(d => `
            <div class="doc-list-item">
                📄 <a href="${esc(d.url)}" target="_blank">${esc(d.name || d.filename || 'Document')}</a>
            </div>
        `).join('');
    }

    /* ===== GPS / Go Online ===== */
    function toggleOnline() {
        if (isOnline) {
            stopGPSTracking();
        } else {
            startGPSTracking();
        }
    }

    function startGPSTracking() {
        if (!navigator.geolocation) {
            showToast('Geolocation is not supported by your browser', 'error');
            return;
        }

        if (!session || !session.applicantId) {
            showToast('Please log in first', 'error');
            return;
        }

        isOnline = true;
        if (session) { session.isOnline = true; saveSession(); }
        updateOnlineUI();
        showToast('You are now online. Sharing your location.', 'success');

        // ── Analytics: Go Online clicked ───────────────────
        if (typeof trackEvent === 'function') {
            trackEvent('driver', 'go_online');
        }
        if (typeof firebaseTrackEvent === 'function') {
            firebaseTrackEvent('driver_go_online', { applicant_id: session.applicantId });
        }
        if (typeof logAnalyticsEvent === 'function') {
            logAnalyticsEvent('driver_go_online', {
                category: 'driver',
                applicant_id: session.applicantId,
            });
        }

        // Start watching position
        gpsWatchId = navigator.geolocation.watchPosition(
            onPositionUpdate,
            onPositionError,
            {
                enableHighAccuracy: true,
                maximumAge: 30000,
                timeout: 10000,
            }
        );

        // Also post immediately and then every 30 seconds
        postLocationImmediately();
        gpsPostTimer = setInterval(postLocation, GPS_POST_INTERVAL_MS);
    }

    function stopGPSTracking() {
        isOnline = false;
        if (session) { session.isOnline = false; saveSession(); }
        updateOnlineUI();

        // ── Analytics: Go Offline ──────────────────────────
        if (typeof trackEvent === 'function') {
            trackEvent('driver', 'go_offline');
        }
        if (typeof firebaseTrackEvent === 'function') {
            firebaseTrackEvent('driver_go_offline', { applicant_id: session && session.applicantId });
        }

        if (gpsWatchId !== null) {
            navigator.geolocation.clearWatch(gpsWatchId);
            gpsWatchId = null;
        }
        if (gpsPostTimer) {
            clearInterval(gpsPostTimer);
            gpsPostTimer = null;
        }
        lastPosition = null;
        showToast('You are now offline. Location sharing stopped.', 'success');
    }

    function updateOnlineUI() {
        if (!goOnlineBtn) return;
        if (isOnline) {
            goOnlineBtn.textContent = 'Go Offline';
            goOnlineBtn.classList.remove('btn-primary');
            goOnlineBtn.classList.add('btn-danger');
            if (gpsStatus) gpsStatus.textContent = 'Online — sharing location';
            if (gpsIndicator) {
                gpsIndicator.classList.remove('offline');
                gpsIndicator.classList.add('online');
            }
        } else {
            goOnlineBtn.textContent = 'Go Online';
            goOnlineBtn.classList.remove('btn-danger');
            goOnlineBtn.classList.add('btn-primary');
            if (gpsStatus) gpsStatus.textContent = 'Offline';
            if (gpsIndicator) {
                gpsIndicator.classList.remove('online');
                gpsIndicator.classList.add('offline');
            }
        }
    }

    function onPositionUpdate(position) {
        lastPosition = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: new Date().toISOString(),
        };
        console.log('GPS position updated:', lastPosition);
    }

    function onPositionError(error) {
        console.error('GPS error:', error);
        let msg = 'Unable to get your location.';
        switch (error.code) {
            case error.PERMISSION_DENIED: msg = 'Location permission denied. Please enable location services.'; break;
            case error.POSITION_UNAVAILABLE: msg = 'Location information is unavailable.'; break;
            case error.TIMEOUT: msg = 'Location request timed out.'; break;
        }
        showToast(msg, 'error');
    }

    async function postLocationImmediately() {
        if (!lastPosition) {
            // Try to get a one-time position
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    lastPosition = {
                        lat: pos.coords.latitude,
                        lng: pos.coords.longitude,
                        accuracy: pos.coords.accuracy,
                        timestamp: new Date().toISOString(),
                    };
                    postLocation();
                },
                onPositionError,
                { enableHighAccuracy: true, timeout: 10000 }
            );
        } else {
            postLocation();
        }
    }

    async function postLocation() {
        if (!lastPosition || !session || !session.applicantId) return;

        try {
            const res = await fetch(`${API_BASE}/update-driver-location`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    driver_id: session.applicantId,
                    lat: lastPosition.lat,
                    lng: lastPosition.lng,
                    accuracy: lastPosition.accuracy,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                console.log('Location posted successfully');
            } else {
                console.error('Failed to post location:', data.error || data.message);
            }
        } catch (err) {
            console.error('Error posting location:', err);
        }
    }

    /* ===== Utilities ===== */
    function esc(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function showToast(message, type) {
        const toast = document.createElement('div');
        toast.className = 'toast ' + type;
        toast.textContent = message;
        toastContainer.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    /* ===== Events ===== */
    function bindEvents() {
        loginForm.addEventListener('submit', onLogin);
        logoutBtn.addEventListener('click', onLogout);
        editProfileBtn.addEventListener('click', openEdit);
        cancelEditBtn.addEventListener('click', closeEdit);
        profileForm.addEventListener('submit', onSaveProfile);

        uploadDropzone.addEventListener('dragover', onDragOver);
        uploadDropzone.addEventListener('dragleave', onDragLeave);
        uploadDropzone.addEventListener('drop', onDrop);
        uploadInput.addEventListener('change', onFileInputChange);
        uploadPreview.addEventListener('click', removeFile);
        uploadSubmit.addEventListener('click', onUploadSubmit);

        // GPS / Go Online
        if (goOnlineBtn) goOnlineBtn.addEventListener('click', toggleOnline);

        // Cleanup on page unload
        window.addEventListener('beforeunload', () => {
            if (gpsPostTimer) clearInterval(gpsPostTimer);
            if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
        });
    }

    init();
})();
