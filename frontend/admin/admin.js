/* ===== Admin Dashboard JS ===== */
(function() {
    'use strict';

    const API_BASE = '/api/admin';
    const PAGE_SIZE = 10;

    let token = localStorage.getItem('admin_token');
    let currentApps = [];
    let filteredApps = [];
    let currentPage = 1;
    let currentSort = { field: 'submitted', dir: 'desc' };
    let selectedIds = new Set();
    let currentDetailId = null;
    let deleteTargetId = null;
    let currentOrders = [];

    /* ===== DOM refs ===== */
    const loginScreen = document.getElementById('login-screen');
    const dashboard = document.getElementById('dashboard');
    const loginForm = document.getElementById('login-form');
    const loginError = document.getElementById('login-error');
    const logoutBtn = document.getElementById('logout-btn');
    const adminName = document.getElementById('admin-name');
    const refreshBtn = document.getElementById('refresh-btn');
    const searchInput = document.getElementById('search-input');
    const statusFilter = document.getElementById('status-filter');
    const selectAll = document.getElementById('select-all');
    const tableBody = document.getElementById('apps-table-body');
    const pagination = document.getElementById('pagination');
    const bulkActions = document.getElementById('bulk-actions');
    const bulkCount = document.getElementById('bulk-count');

    const detailModal = document.getElementById('detail-modal');
    const modalBody = document.getElementById('modal-body');
    const modalClose = document.getElementById('modal-close');
    const modalCancel = document.getElementById('modal-cancel');
    const modalSave = document.getElementById('modal-save');
    const modalStatus = document.getElementById('modal-status');

    const deleteModal = document.getElementById('delete-modal');
    const deleteModalClose = document.getElementById('delete-modal-close');
    const deleteCancel = document.getElementById('delete-cancel');
    const deleteConfirm = document.getElementById('delete-confirm');
    const deleteTargetName = document.getElementById('delete-target-name');

    const toastContainer = document.getElementById('toast-container');

    /* ===== Init ===== */
    function init() {
        if (token) {
            showDashboard();
            loadApplications();
            loadOrders();
        } else {
            showLogin();
        }
        bindEvents();
    }

    /* ===== Auth ===== */
    function showLogin() {
        loginScreen.style.display = '';
        dashboard.style.display = 'none';
    }

    function showDashboard() {
        loginScreen.style.display = 'none';
        dashboard.style.display = '';
    }

    function api(method, endpoint, body) {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' }
        };
        if (token) opts.headers['Authorization'] = 'Bearer ' + token;
        if (body) opts.body = JSON.stringify(body);
        return fetch(API_BASE + endpoint, opts).then(async r => {
            if (r.status === 401) { handleTokenExpired(); }
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
                const err = new Error(data.error || data.message || `HTTP ${r.status}`);
                err.status = r.status;
                err.data = data;
                throw err;
            }
            return data;
        });
    }

    /* ===== Login / Logout ===== */
    async function onLogin(e) {
        e.preventDefault();
        loginError.textContent = '';
        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        try {
            const res = await api('POST', '/login', { username, password });
            if (!res.token) throw new Error('No token returned');
            token = res.token;
            localStorage.setItem('admin_token', token);
            showDashboard();
            loadApplications();
            loadOrders();
            showToast('Welcome back!', 'success');

            // ── Analytics: Admin login success ───────────────
            if (typeof trackEvent === 'function') {
                trackEvent('admin', 'login_success');
            }
            if (typeof firebaseTrackEvent === 'function') {
                firebaseTrackEvent('admin_login_success', { admin_user: username });
            }
            if (typeof logAnalyticsEvent === 'function') {
                logAnalyticsEvent('admin_login_success', { category: 'admin', admin_user: username });
            }
        } catch (err) {
            loginError.textContent = err.message || 'Login failed';

            // ── Analytics: Admin login failed ────────────────
            if (typeof trackEvent === 'function') {
                trackEvent('admin', 'login_failed');
            }
            if (typeof firebaseTrackEvent === 'function') {
                firebaseTrackEvent('admin_login_failed', { admin_user: username });
            }
        }
    }

    function onLogout() {
        token = null;
        localStorage.removeItem('admin_token');
        showLogin();
        showToast('Logged out', 'success');

        if (typeof trackEvent === 'function') {
            trackEvent('admin', 'logout');
        }
    }

    /* ===== Load Applications ===== */
    async function loadApplications() {
        try {
            const data = await api('GET', '/applications');
            currentApps = Array.isArray(data) ? data : (data.applications || []);
            applyFiltersAndSort();
            updateStats();
        } catch (err) {
            console.error(err);
            showToast('Failed to load applications', 'error');
        }
    }

    /* ===== Stats ===== */
    function updateStats() {
        const counts = {
            total: currentApps.length,
            pending: 0,
            background_check: 0,
            approved: 0,
            rejected: 0,
            on_hold: 0
        };
        currentApps.forEach(a => {
            if (counts[a.status] !== undefined) counts[a.status]++;
        });
        document.getElementById('stat-total').textContent = counts.total;
        document.getElementById('stat-pending').textContent = counts.pending;
        document.getElementById('stat-bg').textContent = counts.background_check;
        document.getElementById('stat-approved').textContent = counts.approved;
        document.getElementById('stat-rejected').textContent = counts.rejected;
        document.getElementById('stat-hold').textContent = counts.on_hold;
    }

    /* ===== Filtering & Sorting ===== */
    function applyFiltersAndSort() {
        const q = searchInput.value.trim().toLowerCase();
        const st = statusFilter.value;
        let list = currentApps.filter(a => {
            if (st && a.status !== st) return false;
            if (!q) return true;
            const hay = [a.name, a.email, a.phone, String(a.id)].join(' ').toLowerCase();
            return hay.includes(q);
        });
        list.sort((a, b) => {
            let av = a[currentSort.field];
            let bv = b[currentSort.field];
            if (currentSort.field === 'submitted') { av = av || a.created_at; bv = bv || b.created_at; }
            if (typeof av === 'string') av = av.toLowerCase();
            if (typeof bv === 'string') bv = bv.toLowerCase();
            if (av === bv) return 0;
            const cmp = av < bv ? -1 : 1;
            return currentSort.dir === 'asc' ? cmp : -cmp;
        });
        filteredApps = list;
        currentPage = 1;
        renderTable();
    }

    /* ===== Table Render ===== */
    function renderTable() {
        const total = filteredApps.length;
        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (currentPage > totalPages) currentPage = totalPages;
        const start = (currentPage - 1) * PAGE_SIZE;
        const pageItems = filteredApps.slice(start, start + PAGE_SIZE);

        tableBody.innerHTML = '';
        pageItems.forEach(app => {
            const tr = document.createElement('tr');
            const checked = selectedIds.has(String(app.id)) ? 'checked' : '';
            tr.innerHTML = `
                <td class="col-check"><input type="checkbox" data-id="${esc(app.id)}" ${checked}></td>
                <td class="col-id" title="${esc(app.id)}">#${esc(String(app.id).slice(0, 8))}</td>
                <td class="col-name">${esc(app.name)}</td>
                <td class="col-email">${esc(app.email)}</td>
                <td class="col-status"><span class="badge badge-${esc(app.status)}">${esc(fmtStatus(app.status))}</span></td>
                <td class="col-date">${fmtDate(app.submitted || app.created_at)}</td>
                <td class="col-actions">
                    <div class="actions-cell">
                        <button class="btn btn-secondary btn-icon" title="View" data-action="view" data-id="${esc(app.id)}">👁</button>
                        <button class="btn btn-success btn-icon" title="Approve" data-action="approve" data-id="${esc(app.id)}">✅</button>
                        <button class="btn btn-danger btn-icon" title="Reject" data-action="reject" data-id="${esc(app.id)}">❌</button>
                        <button class="btn btn-warning btn-icon" title="Background Check" data-action="bg" data-id="${esc(app.id)}">🔍</button>
                        <button class="btn btn-warning btn-icon" title="On Hold" data-action="hold" data-id="${esc(app.id)}">🛑</button>
                        <button class="btn btn-danger btn-icon" title="Delete" data-action="delete" data-id="${esc(app.id)}">🗑</button>
                    </div>
                </td>
            `;
            tableBody.appendChild(tr);
        });

        renderPagination(totalPages);
        updateBulkUI();
    }

    function renderPagination(totalPages) {
        pagination.innerHTML = '';
        if (totalPages <= 1) return;

        const prev = document.createElement('button');
        prev.textContent = 'Prev';
        prev.disabled = currentPage === 1;
        prev.addEventListener('click', () => { currentPage--; renderTable(); });
        pagination.appendChild(prev);

        const pageInfo = document.createElement('span');
        pageInfo.className = 'page-info';
        pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
        pagination.appendChild(pageInfo);

        const next = document.createElement('button');
        next.textContent = 'Next';
        next.disabled = currentPage === totalPages;
        next.addEventListener('click', () => { currentPage++; renderTable(); });
        pagination.appendChild(next);
    }

    /* ===== Row actions ===== */
    function onTableClick(e) {
        const checkbox = e.target.closest('input[type="checkbox"][data-id]');
        if (checkbox) {
            const id = checkbox.dataset.id;
            if (checkbox.checked) selectedIds.add(id); else selectedIds.delete(id);
            updateBulkUI();
            return;
        }
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (action === 'view') openDetail(id);
        else if (action === 'delete') confirmDelete(id);
        else if (['approve','reject','bg','hold'].includes(action)) {
            const map = { approve: 'approved', reject: 'rejected', bg: 'background_check', hold: 'on_hold' };
            updateStatus(id, map[action]);
        }
    }

    /* ===== Detail Modal ===== */
    async function openDetail(id) {
        currentDetailId = id;
        const app = currentApps.find(a => String(a.id) === id);
        if (!app) return;
        modalStatus.value = app.status || 'pending';
        modalBody.innerHTML = buildDetailHTML(app);
        detailModal.style.display = '';
    }

    function buildDetailHTML(app) {
        const docs = (app.documents || []);
        const docList = docs.length
            ? docs.map(d => `<div class="doc-item">📄 <a href="${esc(d.url)}" target="_blank">${esc(d.name || d.filename || 'Document')}</a></div>`).join('')
            : '<p class="detail-paragraph">No documents uploaded.</p>';

        return `
            <div class="detail-section">
                <h4>Personal Information</h4>
                <div class="detail-grid">
                    <div class="detail-field"><label>Full Name</label><span>${esc(app.name)}</span></div>
                    <div class="detail-field"><label>Email</label><span>${esc(app.email)}</span></div>
                    <div class="detail-field"><label>Phone</label><span>${esc(app.phone || '—')}</span></div>
                    <div class="detail-field"><label>Date of Birth</label><span>${esc(app.dob || '—')}</span></div>
                </div>
            </div>
            <div class="detail-section">
                <h4>Address</h4>
                <div class="detail-grid">
                    <div class="detail-field"><label>Street</label><span>${esc(app.address || '—')}</span></div>
                    <div class="detail-field"><label>City</label><span>${esc(app.city || '—')}</span></div>
                    <div class="detail-field"><label>State</label><span>${esc(app.state || '—')}</span></div>
                    <div class="detail-field"><label>ZIP</label><span>${esc(app.zip || '—')}</span></div>
                </div>
            </div>
            <div class="detail-section">
                <h4>Vehicle Information</h4>
                <div class="detail-grid">
                    <div class="detail-field"><label>Make</label><span>${esc(app.vehicle_make || '—')}</span></div>
                    <div class="detail-field"><label>Model</label><span>${esc(app.vehicle_model || '—')}</span></div>
                    <div class="detail-field"><label>Year</label><span>${esc(app.vehicle_year || '—')}</span></div>
                    <div class="detail-field"><label>License Plate</label><span>${esc(app.vehicle_plate || '—')}</span></div>
                </div>
            </div>
            <div class="detail-section">
                <h4>Insurance</h4>
                <div class="detail-grid">
                    <div class="detail-field"><label>Insurance Provider</label><span>${esc(app.insurance_provider || '—')}</span></div>
                    <div class="detail-field"><label>Policy Number</label><span>${esc(app.insurance_policy || '—')}</span></div>
                </div>
            </div>
            <div class="detail-section">
                <h4>Background / Experience</h4>
                <p class="detail-paragraph">${esc(app.background || 'No additional notes provided.')}</p>
            </div>
            <div class="detail-section">
                <h4>Documents</h4>
                <div class="documents-list">${docList}</div>
            </div>
            <div class="detail-section">
                <h4>Beach / Dune Access</h4>
                <label class="beach-permit-toggle"><input type="checkbox" id="beach-permit-ok" ${app.beach_permit_ok ? 'checked' : ''}> Current beach / dune access permit on file</label>
                <textarea id="beach-access-notes" class="admin-notes" placeholder="Permit number, expiry, which beaches...">${esc(app.beach_access_notes || '')}</textarea>
            </div>
            <div class="detail-section">
                <h4>Admin Notes</h4>
                <textarea id="admin-notes" class="admin-notes" placeholder="Add internal notes...">${esc(app.admin_notes || '')}</textarea>
            </div>
        `;
    }

    function closeDetail() {
        detailModal.style.display = 'none';
        currentDetailId = null;
    }

    async function saveDetail() {
        if (!currentDetailId) return;
        const notesEl = document.getElementById('admin-notes');
        const notes = notesEl ? notesEl.value : '';
        const status = modalStatus.value;
        const permitEl = document.getElementById('beach-permit-ok');
        const beachNotesEl = document.getElementById('beach-access-notes');
        const beach_permit_ok = permitEl ? permitEl.checked : undefined;
        const beach_access_notes = beachNotesEl ? beachNotesEl.value : undefined;
        try {
            await api('PUT', `/applications/${currentDetailId}`, { status, admin_notes: notes, beach_permit_ok, beach_access_notes });
            const app = currentApps.find(a => String(a.id) === currentDetailId);
            if (app) {
                app.status = status;
                app.admin_notes = notes;
                if (beach_permit_ok !== undefined) app.beach_permit_ok = beach_permit_ok;
                if (beach_access_notes !== undefined) app.beach_access_notes = beach_access_notes;
            }
            applyFiltersAndSort();
            updateStats();
            closeDetail();
            showToast('Application updated', 'success');

            // ── Analytics: Application status changed ──────────
            if (typeof trackEvent === 'function') {
                trackEvent('admin', 'status_change', status);
            }
            if (typeof firebaseTrackEvent === 'function') {
                firebaseTrackEvent('application_status_changed', { application_id: currentDetailId, new_status: status });
            }
            if (typeof logAnalyticsEvent === 'function') {
                logAnalyticsEvent('application_status_changed', {
                    category: 'admin',
                    application_id: currentDetailId,
                    new_status: status,
                });
            }
        } catch (err) {
            showToast(err.message || 'Update failed', 'error');
        }
    }

    /* ===== Delete ===== */
    function confirmDelete(id) {
        deleteTargetId = id;
        const app = currentApps.find(a => String(a.id) === id);
        deleteTargetName.textContent = app ? esc(app.name) : '';
        deleteModal.style.display = '';
    }

    function closeDelete() {
        deleteModal.style.display = 'none';
        deleteTargetId = null;
    }

    async function doDelete() {
        if (!deleteTargetId) return;
        try {
            await api('DELETE', `/applications/${deleteTargetId}`);
            currentApps = currentApps.filter(a => String(a.id) !== deleteTargetId);
            selectedIds.delete(deleteTargetId);
            applyFiltersAndSort();
            updateStats();
            closeDelete();
            showToast('Application deleted', 'success');
        } catch (err) {
            showToast(err.message || 'Delete failed', 'error');
        }
    }

    /* ===== Bulk actions ===== */
    function updateBulkUI() {
        const count = selectedIds.size;
        bulkCount.textContent = `${count} selected`;
        bulkActions.style.display = count > 0 ? '' : 'none';
        selectAll.checked = count > 0 && tableBody.querySelectorAll('input[type="checkbox"]:checked').length === tableBody.querySelectorAll('input[type="checkbox"]').length;
    }

    function onSelectAll(e) {
        const checkboxes = tableBody.querySelectorAll('input[type="checkbox"][data-id]');
        checkboxes.forEach(cb => {
            const id = cb.dataset.id;
            if (e.target.checked) selectedIds.add(id); else selectedIds.delete(id);
            cb.checked = e.target.checked;
        });
        updateBulkUI();
    }

    async function onBulkAction(e) {
        const btn = e.target.closest('button[data-bulk]');
        if (!btn) return;
        const status = btn.dataset.bulk;
        const ids = Array.from(selectedIds);
        if (!ids.length) return;
        try {
            await api('POST', '/applications/bulk', { ids, status });
            currentApps.forEach(a => { if (selectedIds.has(String(a.id))) a.status = status; });
            selectedIds.clear();
            applyFiltersAndSort();
            updateStats();
            showToast(`Updated ${ids.length} applications`, 'success');

            // ── Analytics: Bulk status change ────────────────
            if (typeof trackEvent === 'function') {
                trackEvent('admin', 'bulk_status_change', status, ids.length);
            }
            if (typeof firebaseTrackEvent === 'function') {
                firebaseTrackEvent('application_bulk_status_changed', { new_status: status, count: ids.length });
            }
            if (typeof logAnalyticsEvent === 'function') {
                logAnalyticsEvent('application_bulk_status_changed', {
                    category: 'admin',
                    new_status: status,
                    count: ids.length,
                });
            }
        } catch (err) {
            showToast(err.message || 'Bulk update failed', 'error');
        }
    }

    async function updateStatus(id, status) {
        try {
            await api('PUT', `/applications/${id}`, { status });
            const app = currentApps.find(a => String(a.id) === id);
            if (app) app.status = status;
            applyFiltersAndSort();
            updateStats();
            showToast(`Status updated to ${fmtStatus(status)}`, 'success');

            // ── Analytics: Status change from row action ─────
            if (typeof trackEvent === 'function') {
                trackEvent('admin', 'status_change', status);
            }
            if (typeof firebaseTrackEvent === 'function') {
                firebaseTrackEvent('application_status_changed', { application_id: id, new_status: status });
            }
            if (typeof logAnalyticsEvent === 'function') {
                logAnalyticsEvent('application_status_changed', {
                    category: 'admin',
                    application_id: id,
                    new_status: status,
                });
            }

            // ── Analytics: Background check initiated ─────────
            if (status === 'background_check') {
                if (typeof trackEvent === 'function') {
                    trackEvent('admin', 'background_check_initiated');
                }
                if (typeof firebaseTrackEvent === 'function') {
                    firebaseTrackEvent('background_check_initiated', { application_id: id });
                }
                if (typeof logAnalyticsEvent === 'function') {
                    logAnalyticsEvent('background_check_initiated', {
                        category: 'admin',
                        application_id: id,
                    });
                }
            }
        } catch (err) {
            showToast(err.message || 'Status update failed', 'error');
        }
    }

    /* ===== Orders + weather hold (#33) ===== */
    const ordersBody = document.getElementById('orders-table-body');
    const weatherBanner = document.getElementById('weather-banner');

    function renderWeather(w) {
        if (!weatherBanner) return;
        if (w && w.active) {
            weatherBanner.className = 'weather-banner weather-on';
            weatherBanner.textContent = `Global weather shutdown is ON (Netlify env WEATHER_SHUTDOWN). New orders and offers are paused. ${w.reason || ''}`;
        } else {
            weatherBanner.className = 'weather-banner weather-off';
            weatherBanner.textContent = 'Global weather shutdown is off. Use the per-order hold below to pause a single delivery.';
        }
    }

    // Order states from #53-#65 (payment, refunds, dispatch, address checks)
    // come shaped by GET /api/admin/orders: o.payment {cls,label},
    // o.attention [{level,code,text}], o.history [{status,note,by,at}].
    const ordersFilter = document.getElementById('orders-filter');
    const ordersCount = document.getElementById('orders-attention-count');
    const ordersAlert = document.getElementById('orders-alert');
    const PAYMENT_CODES = ['stripe_paid_not_marked', 'second_payment', 'payment_failed'];
    const ORDER_COLS = 7;

    function needsAttention(o) {
        return (o.attention || []).some(a => a.level === 'danger' || a.level === 'warn');
    }
    function orderMatchesFilter(o, f) {
        if (f === 'attention') return needsAttention(o);
        if (f === 'payment') return (o.attention || []).some(a => PAYMENT_CODES.includes(a.code));
        if (f === 'unpaid') return !o.payment || !['paid', 'partial', 'refunded'].includes(o.payment.cls);
        return true;
    }
    function fmtWhen(d) {
        if (!d) return '';
        const date = new Date(d);
        if (isNaN(date)) return String(d);
        return date.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT';
    }

    function renderOrders(orders) {
        if (!ordersBody) return;
        const all = orders || [];
        const flagged = all.filter(needsAttention).length;
        const urgent = all.filter(o => (o.attention || []).some(a => a.level === 'danger')).length;
        if (ordersCount) ordersCount.textContent = flagged ? `${flagged} of ${all.length} recent orders need attention${urgent ? ` (${urgent} payment problem${urgent === 1 ? '' : 's'})` : ''}.` : (all.length ? 'Nothing needs attention.' : '');
        if (ordersAlert) {
            ordersAlert.hidden = !flagged;
            ordersAlert.className = 'orders-alert' + (urgent ? ' orders-alert-danger' : '');
            ordersAlert.textContent = flagged ? `⚠ ${flagged} order${flagged === 1 ? '' : 's'} need${flagged === 1 ? 's' : ''} attention${urgent ? ` — ${urgent} payment problem${urgent === 1 ? '' : 's'}` : ''}. View orders ↓` : '';
        }
        const f = ordersFilter ? ordersFilter.value : 'all';
        const list = all.filter(o => orderMatchesFilter(o, f));
        if (!all.length) {
            ordersBody.innerHTML = `<tr><td colspan="${ORDER_COLS}">No orders yet.</td></tr>`;
            return;
        }
        if (!list.length) {
            ordersBody.innerHTML = `<tr><td colspan="${ORDER_COLS}">No orders match this filter.</td></tr>`;
            return;
        }
        ordersBody.innerHTML = list.map(o => {
            const status = o.status || 'pending';
            const pay = o.payment || { cls: 'none', label: '—' };
            const flags = (o.attention || []).map(a =>
                `<li class="attn attn-${esc(a.level)}"><span class="attn-level">${a.level === 'danger' ? 'Urgent' : a.level === 'warn' ? 'Check' : 'Note'}:</span> ${esc(a.text)}</li>`).join('');
            const history = (o.history || []).map(h =>
                `<li><time>${esc(fmtWhen(h.at))}</time> <span class="hist-status">${esc(fmtStatus(h.status))}</span> ${esc(h.note || '')}${h.by ? ` <span class="hist-by">(${esc(h.by)})</span>` : ''}</li>`).join('');
            const price = Number(o.final_price || o.estimated_price);
            const detail = (flags || history) ? `
            <tr class="order-detail-row${needsAttention(o) ? ' needs-attention' : ''}">
                <td colspan="${ORDER_COLS}">
                    ${flags ? `<ul class="attn-list">${flags}</ul>` : ''}
                    ${history ? `<details class="order-history"><summary>History (${(o.history || []).length})</summary><ul>${history}</ul></details>` : ''}
                </td>
            </tr>` : '';
            return `
            <tr class="order-row${needsAttention(o) ? ' needs-attention' : ''}">
                <td><strong>${esc(o.order_number || String(o.id).slice(0, 8))}</strong><br><small>${esc(fmtWhen(o.created_at))}${price ? ` · $${price.toFixed(2)}` : ''}</small></td>
                <td data-label="Route">${esc(o.pickup_city || '—')} to ${esc(o.dropoff_city || o.pickup_city || '—')}</td>
                <td data-label="Vehicle">${esc(o.required_vehicle_class || '—')}</td>
                <td data-label="Status"><span class="badge badge-${esc(status)}">${esc(fmtStatus(status))}</span></td>
                <td data-label="Payment"><span class="pay-badge pay-${esc(pay.cls)}">${esc(pay.label)}</span></td>
                <td data-label="Weather hold">${o.weather_hold ? '<span class="badge badge-on_hold">on hold</span>' : 'none'}</td>
                <td data-label="Action"><button class="btn ${o.weather_hold ? 'btn-success' : 'btn-warning'}" data-hold-id="${esc(o.id)}" data-hold-next="${o.weather_hold ? 'false' : 'true'}">${o.weather_hold ? 'Clear hold' : 'Set weather hold'}</button></td>
            </tr>${detail}`;
        }).join('');
    }

    async function loadOrders() {
        if (!ordersBody) return;
        try {
            const data = await api('GET', '/orders');
            currentOrders = data.orders || [];
            renderOrders(currentOrders);
            renderWeather(data.weather);
            if (data.logsError) showToast('Order history could not be loaded; payment/dispatch flags may be missing.', 'warning');
        } catch (err) {
            console.error(err);
            ordersBody.innerHTML = `<tr><td colspan="${ORDER_COLS}">Could not load orders.</td></tr>`;
        }
    }

    async function onOrdersClick(e) {
        const btn = e.target.closest('button[data-hold-id]');
        if (!btn) return;
        const id = btn.dataset.holdId;
        const hold = btn.dataset.holdNext === 'true';
        btn.disabled = true;
        try {
            await api('PUT', `/orders/${id}/weather-hold`, { weather_hold: hold });
            const o = currentOrders.find(x => String(x.id) === id);
            if (o) o.weather_hold = hold;
            renderOrders(currentOrders);
            showToast(hold ? 'Weather hold set' : 'Weather hold cleared', 'success');
        } catch (err) {
            btn.disabled = false;
            showToast(err.message || 'Could not update weather hold', 'error');
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

    function fmtStatus(s) {
        return String(s == null || s === '' ? 'unknown' : s).replace(/_/g, ' ');
    }

    function fmtDate(d) {
        if (!d) return '—';
        const date = new Date(d);
        if (isNaN(date)) return d;
        return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function showToast(message, type) {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        toastContainer.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    function handleTokenExpired() {
        token = null;
        localStorage.removeItem('admin_token');
        showLogin();
        showToast('Session expired. Please log in again.', 'warning');
    }

    /* ===== Event bindings ===== */
    function bindEvents() {
        loginForm.addEventListener('submit', onLogin);
        logoutBtn.addEventListener('click', onLogout);
        refreshBtn.addEventListener('click', () => { loadApplications(); loadOrders(); });
        if (ordersBody) ordersBody.addEventListener('click', onOrdersClick);
        if (ordersFilter) ordersFilter.addEventListener('change', () => renderOrders(currentOrders));
        searchInput.addEventListener('input', debounce(applyFiltersAndSort, 250));
        statusFilter.addEventListener('change', applyFiltersAndSort);
        selectAll.addEventListener('change', onSelectAll);
        tableBody.addEventListener('click', onTableClick);
        bulkActions.addEventListener('click', onBulkAction);

        modalClose.addEventListener('click', closeDetail);
        modalCancel.addEventListener('click', closeDetail);
        modalSave.addEventListener('click', saveDetail);
        detailModal.addEventListener('click', (e) => { if (e.target === detailModal) closeDetail(); });

        deleteModalClose.addEventListener('click', closeDelete);
        deleteCancel.addEventListener('click', closeDelete);
        deleteConfirm.addEventListener('click', doDelete);
        deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) closeDelete(); });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { closeDetail(); closeDelete(); }
        });

        // Sorting
        document.querySelectorAll('.sortable').forEach(th => {
            th.addEventListener('click', () => {
                const field = th.dataset.sort;
                if (currentSort.field === field) {
                    currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
                } else {
                    currentSort.field = field;
                    currentSort.dir = 'asc';
                }
                document.querySelectorAll('.sortable').forEach(el => {
                    el.querySelector('.sort-indicator').textContent = el.dataset.sort === field ? (currentSort.dir === 'asc' ? '↑' : '↓') : '↕';
                });
                applyFiltersAndSort();
            });
        });
    }

    function debounce(fn, ms) {
        let t;
        return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    }

    init();
})();
