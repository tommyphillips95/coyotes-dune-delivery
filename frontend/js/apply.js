/**
 * Coyote's Dune Delivery — Driver Application Wizard
 * Multi-step form with validation, localStorage persistence, and API submission
 */

(function() {
    'use strict';

    // ── State ───────────────────────────────────────────────
    const STORAGE_KEY = 'coyote_driver_apply_form';
    const TOTAL_STEPS = 5;
    let currentStep = 1;
    let uploadedFiles = {}; // { insuranceCard: File|null }
    let isSubmitting = false;

    // ── DOM refs ────────────────────────────────────────────
    const form = document.getElementById('applyForm');
    const progressBar = document.getElementById('progressBar');
    const formSuccess = document.getElementById('formSuccess');
    const formContainer = document.getElementById('formContainer');
    const submitBtn = document.getElementById('submitBtn');
    const summaryBody = document.getElementById('summaryBody');

    const insuranceInput = document.getElementById('insuranceCard');
    const insurancePreview = document.getElementById('insurancePreview');
    const insuranceFileName = document.getElementById('insuranceFileName');
    const removeInsuranceBtn = document.getElementById('removeInsurance');
    const insuranceError = document.getElementById('insuranceError');

    // ── Helpers ─────────────────────────────────────────────
    function $(selector) { return document.querySelector(selector); }
    function $$$(selector) { return document.querySelectorAll(selector); }

    function getStepEl(stepNum) {
        return document.querySelector('.form-step[data-step="' + stepNum + '"]');
    }

    function getStepInputEls(stepNum) {
        const step = getStepEl(stepNum);
        if (!step) return [];
        return Array.from(step.querySelectorAll('input, select, textarea'));
    }

    function showStep(stepNum) {
        // Hide all steps
        $$$('.form-step').forEach(el => el.classList.remove('active'));
        // Show target
        const target = getStepEl(stepNum);
        if (target) target.classList.add('active');
        currentStep = stepNum;
        // The review summary lives on the final step (also when a saved
        // session is restored straight onto it).
        if (stepNum === TOTAL_STEPS) buildSummary();

        // Update progress bar
        $$$('.progress-step').forEach(el => {
            const s = parseInt(el.dataset.step, 10);
            el.classList.remove('active', 'completed');
            if (s < stepNum) el.classList.add('completed');
            else if (s === stepNum) el.classList.add('active');
        });

        // Scroll to top of form
        const header = document.querySelector('.form-header');
        if (header) header.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ── Analytics: Track step progression ───────────────────
    function trackStepProgression(stepNum) {
        if (typeof trackEvent === 'function') {
            trackEvent('application', 'step_progressed', 'step_' + stepNum);
        }
        if (typeof firebaseTrackEvent === 'function') {
            firebaseTrackEvent('application_step_progressed', { step: stepNum, total_steps: TOTAL_STEPS });
        }
        if (typeof logAnalyticsEvent === 'function') {
            logAnalyticsEvent('application_step_progressed', { category: 'application', step: stepNum });
        }
    }

    // ── Validation ──────────────────────────────────────────
    const validators = {
        firstName: (v) => v.trim().length >= 1,
        lastName: (v) => v.trim().length >= 1,
        email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
        phone: (v) => /^[\d\s\-\(\)\+]{10,}$/.test(v.replace(/\D/g, '').length >= 10 ? v : ''),
        dob: (v) => {
            if (!v) return false;
            const birth = new Date(v);
            const now = new Date();
            const age = now.getFullYear() - birth.getFullYear();
            return age >= 18 && age <= 100 && birth < now;
        },
        address: (v) => v.trim().length >= 3,
        city: (v) => v.trim().length >= 1,
        state: (v) => !!v,
        zip: (v) => /^\d{5}(-\d{4})?$/.test(v),
        emergencyName: (v) => v.trim().length >= 1,
        emergencyPhone: (v) => /^[\d\s\-\(\)\+]{10,}$/.test(v.replace(/\D/g, '').length >= 10 ? v : ''),
        licenseNumber: (v) => v.trim().length >= 3,
        licenseState: (v) => !!v,
        licenseExpiry: (v) => {
            if (!v) return false;
            const expiry = new Date(v);
            return expiry > new Date();
        },
        vehicleMake: (v) => v.trim().length >= 1,
        vehicleModel: (v) => v.trim().length >= 1,
        vehicleYear: (v) => {
            const year = parseInt(v, 10);
            return year >= 2000 && year <= 2030;
        },
        vehicleColor: (v) => v.trim().length >= 1,
        vehicleClass: (v) => ['2wd', 'awd', '4x4', 'utv'].includes(v),
        licensePlate: (v) => v.trim().length >= 2,
        insuranceProvider: (v) => v.trim().length >= 1,
        policyNumber: (v) => v.trim().length >= 3,
        policyExpiry: (v) => {
            if (!v) return false;
            const expiry = new Date(v);
            return expiry > new Date();
        },
        bgConsent: (v) => v === true || v === 'on',
        bgDisclosureRead: (v) => v === true || v === 'on',
        esignature: (v) => v === true || v === 'on',
        termsAgree: (v) => v === true || v === 'on',
    };

    // Link an error element to its field only while it's showing: screen readers
    // read aria-describedby text even when the element is hidden.
    function linkError(input, err, show) {
        if (!input || !err) return;
        if (!err.id) err.id = (input.id || input.name) + 'Error';
        const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(x => x && x !== err.id);
        if (show) ids.push(err.id);
        if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
        else input.removeAttribute('aria-describedby');
        input.setAttribute('aria-invalid', show ? 'true' : 'false');
    }

    function focusField(el) {
        if (!el) return;
        try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
        if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    }

    function validateField(input) {
        const name = input.name || input.id;
        const validator = validators[name];
        const isCheckbox = input.type === 'checkbox';
        const value = isCheckbox ? input.checked : input.value;
        const group = input.closest('.form-group') || input.closest('.checkbox-group');

        let isValid = true;
        if (input.required) {
            isValid = validator ? validator(value) : (isCheckbox ? input.checked : value.trim().length > 0);
        }

        if (group) {
            const errMsg = group.querySelector('.error-message');
            if (!isValid) {
                input.classList.add('error');
                if (errMsg) errMsg.classList.add('visible');
            } else {
                input.classList.remove('error');
                if (errMsg) errMsg.classList.remove('visible');
            }
            linkError(input, errMsg, !isValid);
        }
        return isValid;
    }

    function validateStep(stepNum) {
        const inputs = getStepInputEls(stepNum);
        let allValid = true;
        let firstInvalid = null;
        inputs.forEach(input => {
            if (!validateField(input)) {
                allValid = false;
                if (!firstInvalid) firstInvalid = input;
            }
        });

        // Special: file upload on step 3
        if (stepNum === 3) {
            if (!uploadedFiles.insuranceCard) {
                insuranceError.textContent = INSURANCE_REQUIRED_MSG;
                insuranceError.classList.add('visible');
                linkError(insuranceInput, insuranceError, true);
                allValid = false;
                if (!firstInvalid) firstInvalid = insuranceInput;
            } else {
                insuranceError.classList.remove('visible');
                linkError(insuranceInput, insuranceError, false);
            }
        }

        // Move focus to the first field to fix so keyboard and screen-reader
        // users hear its error instead of staying on the Next/Submit button.
        if (firstInvalid) focusField(firstInvalid);
        return allValid;
    }

    // Clear validation on input
    function bindInputValidation() {
        $$$('.form-step input, .form-step select, .form-step textarea').forEach(input => {
            input.addEventListener('input', () => {
                if (input.classList.contains('error')) {
                    validateField(input);
                }
            });
            input.addEventListener('change', () => {
                if (input.classList.contains('error')) {
                    validateField(input);
                }
                saveFormData();
            });
        });
    }

    // ── Navigation ──────────────────────────────────────────
    function bindNavButtons() {
        $$$('.next-step').forEach(btn => {
            btn.addEventListener('click', () => {
                const nextStep = parseInt(btn.dataset.next, 10);
                if (validateStep(currentStep)) {
                    showStep(nextStep);
                    trackStepProgression(nextStep);
                }
            });
        });

        $$$('.prev-step').forEach(btn => {
            btn.addEventListener('click', () => {
                const prevStep = parseInt(btn.dataset.prev, 10);
                showStep(prevStep);
            });
        });
    }

    // ── File Upload ─────────────────────────────────────────
    function bindFileUpload() {
        if (!insuranceInput) return;

        insuranceInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const problem = window.CoyoteApplySubmit ? window.CoyoteApplySubmit.checkInsuranceFile(file) : null;
                if (problem) {
                    uploadedFiles.insuranceCard = null;
                    insuranceInput.value = '';
                    insurancePreview.style.display = 'none';
                    insuranceError.textContent = problem;
                    insuranceError.classList.add('visible');
                    linkError(insuranceInput, insuranceError, true);
                    return;
                }
                insuranceError.textContent = INSURANCE_REQUIRED_MSG;
                uploadedFiles.insuranceCard = file;
                insuranceFileName.textContent = file.name + ' (' + formatFileSize(file.size) + ')';
                insurancePreview.style.display = 'flex';
                insuranceError.classList.remove('visible');
                linkError(insuranceInput, insuranceError, false);
                saveFormData();
            }
        });

        if (removeInsuranceBtn) {
            removeInsuranceBtn.addEventListener('click', () => {
                uploadedFiles.insuranceCard = null;
                insuranceInput.value = '';
                insurancePreview.style.display = 'none';
                saveFormData();
            });
        }
    }

    const INSURANCE_REQUIRED_MSG = 'Please upload your insurance card.';

    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // ── localStorage Persistence ────────────────────────────
    function saveFormData() {
        const data = {};
        $$$('.form-step input, .form-step select, .form-step textarea').forEach(input => {
            if (input.type === 'checkbox') {
                data[input.name || input.id] = input.checked;
            } else if (input.type !== 'file') {
                data[input.name || input.id] = input.value;
            }
        });
        data._currentStep = currentStep;
        data._insuranceFileName = uploadedFiles.insuranceCard ? uploadedFiles.insuranceCard.name : null;
        try {
            // SSN and bank numbers never go into localStorage.
            const safe = window.CoyoteApplySubmit ? window.CoyoteApplySubmit.stripSensitive(data) : {};
            localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
        } catch (e) {
            // Storage may be full or disabled
        }
    }

    function loadFormData() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            let data = JSON.parse(raw);
            // Drop sensitive values saved by older versions of this page.
            if (window.CoyoteApplySubmit) {
                const cleaned = window.CoyoteApplySubmit.stripSensitive(data);
                if (Object.keys(cleaned).length !== Object.keys(data).length) {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
                }
                data = cleaned;
            }
            Object.keys(data).forEach(key => {
                if (key.startsWith('_')) return;
                const input = document.querySelector('[name="' + key + '"], #' + key);
                if (!input) return;
                if (input.type === 'checkbox') {
                    input.checked = data[key];
                } else if (input.type !== 'file') {
                    input.value = data[key] || '';
                }
            });
            if (data._currentStep && data._currentStep >= 1 && data._currentStep <= TOTAL_STEPS) {
                showStep(data._currentStep);
            }
        } catch (e) {
            // Ignore parse errors
        }
    }

    function clearSavedData() {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (e) {}
    }

    // ── Summary Generation ──────────────────────────────────
    const LABEL_MAP = {
        firstName: 'First Name', lastName: 'Last Name', email: 'Email', phone: 'Phone',
        dob: 'Date of Birth', address: 'Address', city: 'City',
        state: 'State', zip: 'ZIP', emergencyName: 'Emergency Contact', emergencyPhone: 'Emergency Phone',
        licenseNumber: 'License Number', licenseState: 'License State', licenseExpiry: 'License Expiry',
        vehicleMake: 'Vehicle Make', vehicleModel: 'Vehicle Model', vehicleYear: 'Year',
        vehicleColor: 'Color', vehicleClass: 'Vehicle Type', licensePlate: 'License Plate',
        insuranceProvider: 'Insurance Provider', policyNumber: 'Policy Number', policyExpiry: 'Policy Expiry',
    };

    function escapeHtml(v) {
        return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function buildSummary() {
        if (!summaryBody) return;
        let html = '';
        const sections = [
            { title: 'Personal Info', fields: ['firstName', 'lastName', 'email', 'phone', 'dob', 'address', 'city', 'state', 'zip', 'emergencyName', 'emergencyPhone'] },
            { title: 'Vehicle & License', fields: ['licenseNumber', 'licenseState', 'licenseExpiry', 'vehicleMake', 'vehicleModel', 'vehicleYear', 'vehicleColor', 'vehicleClass', 'licensePlate'] },
            { title: 'Insurance', fields: ['insuranceProvider', 'policyNumber', 'policyExpiry'] },
        ];

        sections.forEach(section => {
            html += '<tr><th colspan="2">' + section.title + '</th></tr>';
            section.fields.forEach(field => {
                const input = document.querySelector('[name="' + field + '"]');
                if (!input) return;
                let value = input.value;
                if (input.tagName === 'SELECT' && input.selectedIndex > 0) value = input.options[input.selectedIndex].text;
                html += '<tr><td>' + (LABEL_MAP[field] || field) + '</td><td>' + (value ? escapeHtml(value) : '—') + '</td></tr>';
            });
        });

        html += '<tr><th colspan="2">Consent</th></tr>';
        html += '<tr><td>Background Check Consent</td><td>✓ Provided</td></tr>';
        html += '<tr><td>E-Signature</td><td>✓ Signed</td></tr>';

        if (uploadedFiles.insuranceCard) {
            html += '<tr><th colspan="2">Documents</th></tr>';
            html += '<tr><td>Insurance Card</td><td>' + escapeHtml(uploadedFiles.insuranceCard.name) + '</td></tr>';
        }

        summaryBody.innerHTML = html;
    }

    // Before submit, check every step up to the real final one (TOTAL_STEPS),
    // including the background-check consents (step 4) and the final
    // confirm/terms box. On the first step with a problem, show that step with
    // its linked errors and focus the first field to fix (e.g. an unticked box).
    function validateAllSteps() {
        for (let s = 1; s <= TOTAL_STEPS; s++) {
            if (validateStep(s)) continue;
            if (s !== currentStep) {
                showStep(s);
                validateStep(s); // re-run now it's visible so focus lands
            }
            return false;
        }
        return true;
    }

    // ── API Submission ──────────────────────────────────────
    async function submitApplication(e) {
        e.preventDefault();
        if (isSubmitting) return;

        if (!validateAllSteps()) return;

        isSubmitting = true;
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner"></span> Submitting...';

        const formData = new FormData();
        $$$('.form-step input, .form-step select, .form-step textarea').forEach(input => {
            const name = input.name || input.id;
            if (input.type === 'checkbox') {
                formData.append(name, input.checked);
            } else if (input.type !== 'file') {
                formData.append(name, input.value);
            }
        });

        if (uploadedFiles.insuranceCard) {
            formData.append('insuranceCard', uploadedFiles.insuranceCard);
        }

        // Build JSON payload for fetch (multipart for file, JSON otherwise)
        let payload;
        let headers = {};
        const hasFile = !!uploadedFiles.insuranceCard;

        if (hasFile) {
            payload = formData;
        } else {
            const jsonData = {};
            formData.forEach((val, key) => { jsonData[key] = val; });
            payload = JSON.stringify(jsonData);
            headers['Content-Type'] = 'application/json';
        }

        const S = window.CoyoteApplySubmit;
        hideSubmitError();
        try {
            const result = S
                ? await S.sendApplication(fetch.bind(window), '/api/submit-application', { method: 'POST', headers: headers, body: payload })
                : { ok: false, reason: 'helper_missing' };

            if (!result.ok) {
                // Honest failure: keep the form and everything typed, no fake ID.
                console.error('Application not submitted:', result.reason);
                showSubmitError(result.message);
                if (typeof logAnalyticsEvent === 'function') {
                    logAnalyticsEvent('application_submit_failed', { category: 'application', reason: result.reason });
                }
                return;
            }

            const appId = result.applicationId;
            showSuccess(appId);
            clearSavedData();

            // ── Analytics: Application submitted ───────────────
            if (typeof trackEvent === 'function') {
                trackEvent('application', 'submitted', 'driver_application');
            }
            if (typeof firebaseTrackEvent === 'function') {
                firebaseTrackEvent('application_submitted', { application_id: appId });
            }
            if (typeof trackConversion === 'function') {
                trackConversion('generate_lead', { lead_type: 'driver_application' });
            }
            if (typeof logAnalyticsEvent === 'function') {
                logAnalyticsEvent('application_submitted', { category: 'application', application_id: appId });
            }
        } catch (err) {
            console.error('Submission error:', err);
            showSubmitError();
        } finally {
            isSubmitting = false;
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit Application';
        }
    }

    const SUBMIT_ERROR_FALLBACK = "We couldn't submit your application right now. Please try again later or contact us.";

    // serverMessage: a 4xx reason from submit-application (e.g. file too large).
    function showSubmitError(serverMessage) {
        const el = document.getElementById('submitError');
        const msg = serverMessage || (window.CoyoteApplySubmit && window.CoyoteApplySubmit.SUBMIT_ERROR_MESSAGE) || SUBMIT_ERROR_FALLBACK;
        if (!el) { alert(msg); return; }
        el.textContent = msg;
        el.hidden = false;
        if (el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Keyboard users land on the message (it's also role=alert for screen readers).
        try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    }

    function hideSubmitError() {
        const el = document.getElementById('submitError');
        if (el) { el.hidden = true; el.textContent = ''; }
    }

    function showSuccess(appId) {
        form.style.display = 'none';
        progressBar.style.display = 'none';
        formSuccess.classList.add('active');
        document.getElementById('appIdDisplay').textContent = appId;
    }


    // ── Phone Formatting (with proper backspace support) ────
    function bindPhoneFormatting() {
        ['phone', 'emergencyPhone'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;

            // Handle backspace to skip over separator characters
            el.addEventListener('keydown', function(e) {
                if (e.key !== 'Backspace') return;
                const cursor = this.selectionStart;
                const val = this.value;
                const separators = ['(', ')', ' ', '-'];
                if (cursor > 0 && separators.indexOf(val[cursor - 1]) !== -1) {
                    e.preventDefault();
                    // Find how many separator chars to skip backwards
                    let skip = 1;
                    while (cursor - skip - 1 >= 0 && separators.indexOf(val[cursor - skip - 1]) !== -1) {
                        skip++;
                    }
                    const newVal = val.slice(0, cursor - skip - 1) + val.slice(cursor);
                    const digitsOnly = newVal.replace(/\D/g, '').slice(0, 10);
                    this.value = formatPhone(digitsOnly);
                    const newCursor = Math.max(0, cursor - skip - 1);
                    this.setSelectionRange(newCursor, newCursor);
                }
            });

            el.addEventListener('input', function(e) {
                const cursor = this.selectionStart;
                const prevLen = this.value.length;
                let val = this.value.replace(/\D/g, '').slice(0, 10);
                this.value = formatPhone(val);
                const newLen = this.value.length;
                const added = newLen - prevLen;
                if (added > 0 && cursor < newLen) {
                    this.setSelectionRange(cursor + added, cursor + added);
                }
            });
        });
    }

    function formatPhone(digits) {
        if (digits.length >= 6) {
            return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
        } else if (digits.length >= 3) {
            return '(' + digits.slice(0, 3) + ') ' + digits.slice(3);
        }
        return digits;
    }

    // ── Init ────────────────────────────────────────────────
    function init() {
        bindNavButtons();
        bindInputValidation();
        bindFileUpload();
        bindPhoneFormatting();
        loadFormData();
        if (form) form.addEventListener('submit', submitApplication);

        // ── Analytics: Application started ─────────────────
        if (typeof trackEvent === 'function') {
            trackEvent('application', 'started', 'step_1');
        }
        if (typeof firebaseTrackEvent === 'function') {
            firebaseTrackEvent('application_started', { step: 1, total_steps: TOTAL_STEPS });
        }
        if (typeof logAnalyticsEvent === 'function') {
            logAnalyticsEvent('application_started', { category: 'application', step: 1 });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
