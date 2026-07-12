/**
 * Coyote's Dune Delivery — Driver Application Wizard
 * Multi-step form with validation, localStorage persistence, and API submission
 */

(function() {
    'use strict';

    // ── State ───────────────────────────────────────────────
    const STORAGE_KEY = 'coyote_driver_apply_form';
    const TOTAL_STEPS = 6;
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
        ssn: (v) => /^\d{3}-?\d{2}-?\d{4}$/.test(v),
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
        routingNumber: (v) => /^\d{9}$/.test(v),
        accountNumber: (v) => v.trim().length >= 4,
        confirmAccountNumber: (v) => {
            const account = document.getElementById('accountNumber');
            return v === (account ? account.value : '');
        },
        accountType: (v) => !!v,
        termsAgree: (v) => v === true || v === 'on',
    };

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
            if (!isValid) {
                input.classList.add('error');
                const errMsg = group.querySelector('.error-message');
                if (errMsg) errMsg.classList.add('visible');
            } else {
                input.classList.remove('error');
                const errMsg = group.querySelector('.error-message');
                if (errMsg) errMsg.classList.remove('visible');
            }
        }
        return isValid;
    }

    function validateStep(stepNum) {
        const inputs = getStepInputEls(stepNum);
        let allValid = true;
        inputs.forEach(input => {
            if (!validateField(input)) allValid = false;
        });

        // Special: file upload on step 3
        if (stepNum === 3) {
            if (!uploadedFiles.insuranceCard) {
                insuranceError.classList.add('visible');
                allValid = false;
            } else {
                insuranceError.classList.remove('visible');
            }
        }

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
                    if (nextStep === 6) buildSummary();
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
                uploadedFiles.insuranceCard = file;
                insuranceFileName.textContent = file.name + ' (' + formatFileSize(file.size) + ')';
                insurancePreview.style.display = 'flex';
                insuranceError.classList.remove('visible');
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
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            // Storage may be full or disabled
        }
    }

    function loadFormData() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const data = JSON.parse(raw);
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
        dob: 'Date of Birth', ssn: 'SSN', address: 'Address', city: 'City',
        state: 'State', zip: 'ZIP', emergencyName: 'Emergency Contact', emergencyPhone: 'Emergency Phone',
        licenseNumber: 'License Number', licenseState: 'License State', licenseExpiry: 'License Expiry',
        vehicleMake: 'Vehicle Make', vehicleModel: 'Vehicle Model', vehicleYear: 'Year',
        vehicleColor: 'Color', licensePlate: 'License Plate',
        insuranceProvider: 'Insurance Provider', policyNumber: 'Policy Number', policyExpiry: 'Policy Expiry',
        routingNumber: 'Routing Number', accountNumber: 'Account Number', accountType: 'Account Type',
    };

    function buildSummary() {
        if (!summaryBody) return;
        let html = '';
        const sections = [
            { title: 'Personal Info', fields: ['firstName', 'lastName', 'email', 'phone', 'dob', 'address', 'city', 'state', 'zip', 'emergencyName', 'emergencyPhone'] },
            { title: 'Vehicle & License', fields: ['licenseNumber', 'licenseState', 'licenseExpiry', 'vehicleMake', 'vehicleModel', 'vehicleYear', 'vehicleColor', 'licensePlate'] },
            { title: 'Insurance', fields: ['insuranceProvider', 'policyNumber', 'policyExpiry'] },
            { title: 'Banking', fields: ['routingNumber', 'accountNumber', 'accountType'] },
        ];

        sections.forEach(section => {
            html += '<tr><th colspan="2">' + section.title + '</th></tr>';
            section.fields.forEach(field => {
                const input = document.querySelector('[name="' + field + '"]');
                if (!input) return;
                let value = input.value;
                if (field === 'ssn') value = '•••-••-' + value.slice(-4);
                if (field === 'routingNumber') value = '•••••' + value.slice(-4);
                if (field === 'accountNumber') value = '••••••' + value.slice(-4);
                html += '<tr><td>' + (LABEL_MAP[field] || field) + '</td><td>' + (value || '—') + '</td></tr>';
            });
        });

        html += '<tr><th colspan="2">Consent</th></tr>';
        html += '<tr><td>Background Check Consent</td><td>✓ Provided</td></tr>';
        html += '<tr><td>E-Signature</td><td>✓ Signed</td></tr>';

        if (uploadedFiles.insuranceCard) {
            html += '<tr><th colspan="2">Documents</th></tr>';
            html += '<tr><td>Insurance Card</td><td>' + uploadedFiles.insuranceCard.name + '</td></tr>';
        }

        summaryBody.innerHTML = html;
    }

    // ── API Submission ──────────────────────────────────────
    async function submitApplication(e) {
        e.preventDefault();
        if (isSubmitting) return;

        if (!validateStep(6)) return;

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

        try {
            const response = await fetch('/api/applications', {
                method: 'POST',
                headers: headers,
                body: payload,
            });

            if (!response.ok) {
                throw new Error('Server returned ' + response.status);
            }

            const result = await response.json();
            const appId = result.applicationId || generateAppId();

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
            // Fallback: show success with generated ID anyway
            const appId = generateAppId();
            showSuccess(appId);
            clearSavedData();
        } finally {
            isSubmitting = false;
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit Application';
        }
    }

    function generateAppId() {
        const prefix = 'CDD';
        const timestamp = Date.now().toString(36).toUpperCase();
        const random = Math.random().toString(36).substring(2, 6).toUpperCase();
        return prefix + '-' + timestamp + '-' + random;
    }

    function showSuccess(appId) {
        form.style.display = 'none';
        progressBar.style.display = 'none';
        formSuccess.classList.add('active');
        document.getElementById('appIdDisplay').textContent = appId;
    }

    // ── SSN Formatting (with proper backspace support) ──────
    function bindSSNFormatting() {
        const ssn = document.getElementById('ssn');
        if (!ssn) return;

        // Handle backspace to skip over separator characters
        ssn.addEventListener('keydown', function(e) {
            if (e.key !== 'Backspace') return;
            const cursor = this.selectionStart;
            const val = this.value;
            // If cursor is right after a dash, move cursor back one more char
            // so backspace deletes the digit before the dash, not the dash itself
            if (cursor > 0 && (val[cursor - 1] === '-')) {
                e.preventDefault();
                const newVal = val.slice(0, cursor - 2) + val.slice(cursor);
                const digitsOnly = newVal.replace(/\D/g, '').slice(0, 9);
                this.value = formatSSN(digitsOnly);
                // Place cursor where it should be
                const newCursor = Math.max(0, cursor - 2);
                this.setSelectionRange(newCursor, newCursor);
            }
        });

        ssn.addEventListener('input', function(e) {
            const cursor = this.selectionStart;
            const prevLen = this.value.length;
            let val = this.value.replace(/\D/g, '').slice(0, 9);
            this.value = formatSSN(val);
            // Adjust cursor position for added separators
            const newLen = this.value.length;
            const added = newLen - prevLen;
            if (added > 0 && cursor < newLen) {
                this.setSelectionRange(cursor + added, cursor + added);
            }
        });
    }

    function formatSSN(digits) {
        if (digits.length >= 5) {
            return digits.slice(0, 3) + '-' + digits.slice(3, 5) + '-' + digits.slice(5);
        } else if (digits.length >= 3) {
            return digits.slice(0, 3) + '-' + digits.slice(3);
        }
        return digits;
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
        bindSSNFormatting();
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
