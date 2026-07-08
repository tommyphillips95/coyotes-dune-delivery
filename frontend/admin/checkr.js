/* ===== Checkr Admin Dashboard JS ===== */
(function() {
    'use strict';

    const API_BASE = '/api/checkr';
    const PAGE_SIZE = 10;

    let token = localStorage.getItem('admin_token');
    let currentCandidates = [];
    let filteredCandidates = [];
    let currentPage = 1;
    let currentSort = { field: 'created_at', dir: 'desc' };
    let currentDetailId = null;

    /* ===== DOM refs ===== */
    const loginScreen = document.getElementById('login-screen');
    const dashboard = document.getElementById('dashboard');
    const loginForm = document.getElementById('login-form');
    const loginError = document.getElementById('login-error');
    const logoutBtn = document.getElementById('logout-btn');
    const refreshBtn = document.getElementById('refresh-btn');
    const searchInput = document.getElementById('search-input');
    const statusFilter = document.getElementById('status-filter');
    const appStatusFilter = document.getElementById('app-status-filter');
    const tableBody = document.getElementById('candidates-table-body');
    const pagination = document.getElementById('pagination');

    const detailModal = document.getElementById('detail-modal');
    const modalBody = document.getElementById('modal-body');
    const modalClose = document.getElementById('modal-close');
    const modalCancel = document.getElementById('modal-cancel');
    const modalRefresh = document.getElementById('modal-refresh');
    const modalInitiate = document.getElementById('modal-initiate');

    const toastContainer = document.getElementById('toast-container');

    /* ===== Init ===== */
    function init() {
        if (token) {
            showDashboard();
            loadCandidates();
            loadStats();
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
                const err = new Error(data.message || data.error || `HTTP ${r.status}`);
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
            const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            }).then(async r => {
                const data = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(data.message || 'Login failed');
                return data;
            });
            if (!res.token) throw new Error('No token returned');
            token = res.token;
            localStorage.setItem('admin_token', token);
            showDashboard();
            loadCandidates();
            loadStats();
            showToast('Welcome back!', 'success');
        } catch (err) {
            loginError.textContent = err.message || 'Login failed';
        }
    }

    function onLogout() {
        token = null;
        localStorage.removeItem('admin_token');
        showLogin();
        showToast('Logged out', 'success');
    }

    /* ===== Load Candidates ===== */
    async function loadCandidates() {
        try {
            const data = await api('GET', '/candidates');
            currentCandidates = data.data?.candidates || data.candidates || [];
            applyFiltersAndSort();
        } catch (err) {
            console.error(err);
            showToast('Failed to load candidates', 'error');
        }
    }

    /* ===== Stats ===== */
    async function loadStats() {
        try {
            const data = await api('GET', '/stats');
            const stats = data.data || data;
            document.getElementById('stat-total').textContent = stats.total || 0;
            document.getElementById('stat-consented').textContent = stats.consented || 0;
            document.getElementById('stat-in-progress').textContent = 0;
            document.getElementById('stat-clear').textContent = 0;
            document.getElementById('stat-consider').textContent = 0;
            document.getElementById('stat-suspended').textContent = 0;

            (stats.byStatus || []).forEach(s => {
                const el = document.getElementById(`stat-${s.status}`);
                if (el) el.textContent = s.count;
            });
        } catch (err) {
            console.error('Stats error:', err);
        }
    }

    /* ===== Filtering & Sorting ===== */
    function applyFiltersAndSort() {
        const q = searchInput.value.trim().toLowerCase();
        const st = statusFilter.value;
        const appSt = appStatusFilter.value;
        let list = currentCandidates.filter(c => {
            if (st && c.background_check_status !== st) return false;
            if (appSt && c.status !== appSt) return false;
            if (!q) return true;
            const hay = [c.name, c.email, c.phone, String(c.id), c.applicant_id].join(' ').toLowerCase();
            return hay.includes(q);
        });
        list.sort((a, b) => {
            let av = a[currentSort.field];
            let bv = b[currentSort.field];
            if (currentSort.field === 'created_at') { av = av || a.submitted; bv = bv || b.submitted; }
            if (typeof av === 'string') av = av.toLowerCase();
            if (typeof bv === 'string') bv = bv.toLowerCase();
            if (av === bv) return 0;
            const cmp = av < bv ? -1 : 1;
            return currentSort.dir === 'asc' ? cmp : -cmp;
        });
        filteredCandidates = list;
        currentPage = 1;
        renderTable();
    }

    /* ===== Table Render ===== */
    function renderTable() {
        const total = filteredCandidates.length;
        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (currentPage > totalPages) currentPage = totalPages;
        const start = (currentPage - 1) * PAGE_SIZE;
        const pageItems = filteredCandidates.slice(start, start + PAGE_SIZE);

        tableBody.innerHTML = '';
        pageItems.forEach(c => {
            const tr = document.createElement('tr');
            const bgStatus = c.background_check_status || 'pending';
            const hasConsent = c.background_check_consent ? '✅ Yes' : '❌ No';
            const reportId = c.background_check_report_id || '—';
            tr.innerHTML = `
                <td class="col-id">#${c.id}</td>
                <td class="col-name">${esc(c.name)}</td>
                <td class="col-email">${esc(c.email)}</td>
                <td class="col-status"><span class="badge badge-${c.status}">${fmtStatus(c.status)}</span></td>
                <td class="col-status"><span class="badge badge-${bgStatus}">${fmtStatus(bgStatus)}</span></td>
                <td class="col-status">${hasConsent}</td>
                <td class="col-date" title="${esc(reportId)}">${esc(reportId.substring(0, 12))}${reportId.length > 12 ? '…' : ''}</td>
                <td class="col-actions">
                    <div class="actions-cell">
                        <button class="btn btn-secondary btn-icon" title="View Details" data-action="view" data-id="${c.id}">👁</button>
                        ${!c.background_check_report_id && c.background_check_consent ? `<button class="btn btn-primary btn-icon" title="Initiate Check" data-action="initiate" data-id="${c.id}">🔍</button>` : ''}
                        ${c.background_check_report_id ? `<button class="btn btn-warning btn-icon" title="Refresh Status" data-action="refresh" data-id="${c.id}">🔄</button>` : ''}
                    </div>
                </td>
            `;
            tableBody.appendChild(tr);
        });

        renderPagination(totalPages);
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
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const id = parseInt(btn.dataset.id);
        if (action === 'view') openDetail(id);
        else if (action === 'initiate') initiateCheck(id);
        else if (action === 'refresh') refreshStatus(id);
    }

    /* ===== Detail Modal ===== */
    async function openDetail(id) {
        currentDetailId = id;
        try {
            const data = await api('GET', `/candidates/${id}`);
            const candidate = data.data || data;
            modalBody.innerHTML = buildDetailHTML(candidate);

            const canInitiate = candidate.background_check_consent && !candidate.background_check_report_id;
            modalInitiate.style.display = canInitiate ? '' : 'none';
            modalRefresh.style.display = candidate.background_check_report_id ? '' : 'none';

            detailModal.style.display = '';
        } catch (err) {
            showToast(err.message || 'Failed to load details', 'error');
        }
    }

    function buildDetailHTML(candidate) {
        const bgStatus = candidate.background_check_status || 'pending';
        const logs = candidate.logs || [];
        const report = candidate.checkr_report || null;

        const logItems = logs.length
            ? logs.map(l => `
                <div class="log-item">
                    <span class="log-date">${fmtDate(l.created_at)}</span>
                    <span class="log-action">${esc(l.action)}</span>
                    <span class="log-status badge-${l.status || 'pending'}">${esc(l.status || 'pending')}</span>
                    ${l.report_id ? `<span class="log-report">${esc(l.report_id.substring(0, 12))}</span>` : ''}
                </div>
            `).join('')
            : '<p class="detail-paragraph">No background check activity yet.</p>';

        let reportHtml = '';
        if (report) {
            reportHtml = `
                <div class="detail-section">
                    <h4>Checkr Report</h4>
                    <div class="detail-grid">
                        <div class="detail-field"><label>Report ID</label><span>${esc(report.id)}</span></div>
                        <div class="detail-field"><label>Status</label><span>${esc(report.status)}</span></div>
                        <div class="detail-field"><label>Result</label><span>${esc(report.result || '—')}</span></div>
                        <div class="detail-field"><label>Package</label><span>${esc(report.package || '—')}</span></div>
                        <div class="detail-field"><label>Created</label><span>${fmtDate(report.created_at)}</span></div>
                        <div class="detail-field"><label>Completed</label><span>${fmtDate(report.completed_at)}</span></div>
                    </div>
                </div>
            `;
        }

        return `
            <div class="detail-section">
                <h4>Candidate Information</h4>
                <div class="detail-grid">
                    <div class="detail-field"><label>Full Name</label><span>${esc(candidate.name)}</span></div>
                    <div class="detail-field"><label>Email</label><span>${esc(candidate.email)}</span></div>
                    <div class="detail-field"><label>Phone</label><span>${esc(candidate.phone || '—')}</span></div>
                    <div class="detail-field"><label>Date of Birth</label><span>${esc(candidate.dob || '—')}</span></div>
                    <div class="detail-field"><label>SSN</label><span>${esc(candidate.ssn || '—')}</span></div>
                    <div class="detail-field"><label>Address</label><span>${esc([candidate.address, candidate.city, candidate.state, candidate.zip].filter(Boolean).join(', ') || '—')}</span></div>
                </div>
            </div>
            <div class="detail-section">
                <h4>Background Check Status</h4>
                <div class="detail-grid">
                    <div class="detail-field"><label>Consent Given</label><span>${candidate.background_check_consent ? '✅ Yes' : '❌ No'}</span></div>
                    <div class="detail-field"><label>Status</label><span class="badge badge-${bgStatus}">${fmtStatus(bgStatus)}</span></div>
                    <div class="detail-field"><label>Report ID</label><span>${esc(candidate.background_check_report_id || '—')}</span></div>
                    <div class="detail-field"><label>Completed At</label><span>${fmtDate(candidate.background_check_completed_at)}</span></div>
                </div>
            </div>
            ${reportHtml}
            <div class="detail-section">
                <h4>Audit Log</h4>
                <div class="logs-list">${logItems}</div>
            </div>
        `;
    }

    function closeDetail() {
        detailModal.style.display = 'none';
        currentDetailId = null;
    }

    async function doRefresh() {
        if (!currentDetailId) return;
        await refreshStatus(currentDetailId);
        openDetail(currentDetailId);
    }

    async function doInitiate() {
        if (!currentDetailId) return;
        await initiateCheck(currentDetailId);
        openDetail(currentDetailId);
    }

    /* ===== Initiate Background Check ===== */
    async function initiateCheck(id) {
        try {
            await api('POST', `/candidates/${id}/create`, { package: 'driver_pro' });
            showToast('Background check initiated successfully', 'success');
            loadCandidates();
            loadStats();
        } catch (err) {
            showToast(err.message || 'Failed to initiate background check', 'error');
        }
    }

    /* ===== Refresh Status ===== */
    async function refreshStatus(id) {
        try {
            await api('POST', `/candidates/${id}/refresh`);
            showToast('Status refreshed from Checkr', 'success');
            loadCandidates();
            loadStats();
        } catch (err) {
            showToast(err.message || 'Failed to refresh status', 'error');
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
        return (s || '').replace(/_/g, ' ');
    }

    function fmtDate(d) {
        if (!d) return '—';
        const date = new Date(d);
        if (isNaN(date)) return d;
        return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
        refreshBtn.addEventListener('click', () => { loadCandidates(); loadStats(); });
        searchInput.addEventListener('input', debounce(applyFiltersAndSort, 250));
        statusFilter.addEventListener('change', applyFiltersAndSort);
        appStatusFilter.addEventListener('change', applyFiltersAndSort);
        tableBody.addEventListener('click', onTableClick);

        modalClose.addEventListener('click', closeDetail);
        modalCancel.addEventListener('click', closeDetail);
        modalRefresh.addEventListener('click', doRefresh);
        modalInitiate.addEventListener('click', doInitiate);
        detailModal.addEventListener('click', (e) => { if (e.target === detailModal) closeDetail(); });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeDetail();
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
