const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const router = express.Router();

let db;
try {
  db = require('../database');
} catch (e) {
  db = null;
}

const CHECKR_API_KEY = process.env.CHECKR_API_KEY;
const CHECKR_API_BASE = 'https://api.checkr.com/v1';

/**
 * Helper: send validation errors
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map(e => ({
        field: e.path,
        message: e.msg,
        value: e.value
      }))
    });
  }
  next();
};

/**
 * Middleware: authenticate admin via JWT
 */
const authenticateAdmin = (req, res, next) => {
  try {
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'coyote-dune-delivery-secret-key-2024';
    const authHeader = req.headers.authorization || '';
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      return res.status(401).json({ success: false, message: 'Missing or malformed Authorization header' });
    }
    const decoded = jwt.verify(parts[1], JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

/**
 * Helper: Checkr API request
 */
async function checkrRequest(path, method = 'GET', body = null) {
  if (!CHECKR_API_KEY) {
    throw new Error('CHECKR_API_KEY not configured');
  }
  const url = `${CHECKR_API_BASE}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': 'Basic ' + Buffer.from(CHECKR_API_KEY + ':').toString('base64'),
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Checkr API error ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Helper: log background check action
 */
function logBgCheck(database, applicationId, action, status, reportId, payload) {
  try {
    database.prepare(
      `INSERT INTO background_check_logs (application_id, provider, action, status, report_id, response_payload) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      applicationId,
      'checkr',
      action,
      status || null,
      reportId || null,
      payload ? JSON.stringify(payload) : null
    );
  } catch (e) {
    console.error('Error logging bg check:', e);
  }
}

/**
 * GET /api/checkr/candidates
 * List all applications with background check status
 */
router.get(
  '/candidates',
  authenticateAdmin,
  [
    query('status')
      .optional()
      .isIn(['pending', 'in_progress', 'clear', 'consider', 'suspended'])
      .withMessage('Invalid background check status'),
    query('search')
      .optional()
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage('Search query must be between 1 and 100 characters'),
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    handleValidationErrors
  ],
  async (req, res) => {
    try {
      const database = db || req.app.locals.db;
      if (!database) {
        return res.status(500).json({ success: false, message: 'Database not available' });
      }

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const offset = (page - 1) * limit;
      const status = req.query.status || null;
      const search = req.query.search || null;

      const whereClauses = [];
      const params = [];

      if (status) {
        whereClauses.push('background_check_status = ?');
        params.push(status);
      }

      if (search) {
        whereClauses.push(
          '(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR applicant_id LIKE ?)'
        );
        const like = `%${search}%`;
        params.push(like, like, like, like);
      }

      const whereString = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

      const countStmt = database.prepare(`SELECT COUNT(*) as total FROM applications ${whereString}`);
      const { total } = countStmt.get(...params);

      const queryStmt = database.prepare(`
        SELECT
          id, applicant_id, first_name, last_name, email, phone,
          status, background_check_consent, background_check_status,
          background_check_report_id, background_check_completed_at,
          admin_notes, created_at, updated_at
        FROM applications
        ${whereString}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `);
      const rows = queryStmt.all(...params, limit, offset);

      return res.status(200).json({
        success: true,
        data: {
          candidates: rows.map(r => ({
            ...r,
            name: `${r.first_name} ${r.last_name}`,
            submitted: r.created_at
          })),
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
          }
        }
      });
    } catch (error) {
      console.error('Error listing candidates:', error);
      return res.status(500).json({ success: false, message: 'Failed to list candidates' });
    }
  }
);

/**
 * GET /api/checkr/candidates/:id
 * Get single application with background check details
 */
router.get(
  '/candidates/:id',
  authenticateAdmin,
  [
    param('id').notEmpty().withMessage('Application ID is required').isInt({ min: 1 }).withMessage('Application ID must be a positive integer'),
    handleValidationErrors
  ],
  async (req, res) => {
    try {
      const database = db || req.app.locals.db;
      if (!database) {
        return res.status(500).json({ success: false, message: 'Database not available' });
      }

      const { id } = req.params;

      const appStmt = database.prepare(`
        SELECT
          id, applicant_id, first_name, last_name, email, phone, ssn, date_of_birth,
          address, city, state, zip_code,
          driver_license_number, driver_license_state,
          status, background_check_consent, background_check_status,
          background_check_report_id, background_check_completed_at,
          admin_notes, created_at, updated_at
        FROM applications
        WHERE id = ?
      `);
      const row = appStmt.get(id);

      if (!row) {
        return res.status(404).json({ success: false, message: 'Application not found' });
      }

      // Get background check logs
      const logsStmt = database.prepare(`
        SELECT id, action, status, report_id, response_payload, created_at
        FROM background_check_logs
        WHERE application_id = ?
        ORDER BY created_at DESC
      `);
      const logs = logsStmt.all(id);

      // If report exists, fetch from Checkr
      let checkrReport = null;
      if (row.background_check_report_id && CHECKR_API_KEY) {
        try {
          checkrReport = await checkrRequest(`/reports/${row.background_check_report_id}`);
        } catch (err) {
          console.error('Error fetching Checkr report:', err.message);
        }
      }

      return res.status(200).json({
        success: true,
        data: {
          ...row,
          name: `${row.first_name} ${row.last_name}`,
          dob: row.date_of_birth,
          logs: logs,
          checkr_report: checkrReport
        }
      });
    } catch (error) {
      console.error('Error fetching candidate details:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch candidate details' });
    }
  }
);

/**
 * POST /api/checkr/candidates/:id/create
 * Create a Checkr candidate and initiate background check
 */
router.post(
  '/candidates/:id/create',
  authenticateAdmin,
  [
    param('id').notEmpty().withMessage('Application ID is required').isInt({ min: 1 }).withMessage('Application ID must be a positive integer'),
    body('package').optional().trim().isLength({ max: 50 }).withMessage('Package must be 50 characters or less'),
    handleValidationErrors
  ],
  async (req, res) => {
    try {
      const database = db || req.app.locals.db;
      if (!database) {
        return res.status(500).json({ success: false, message: 'Database not available' });
      }

      const { id } = req.params;
      const pkg = req.body.package || 'driver_pro';

      const app = database.prepare('SELECT * FROM applications WHERE id = ?').get(id);
      if (!app) {
        return res.status(404).json({ success: false, message: 'Application not found' });
      }

      if (!app.background_check_consent) {
        return res.status(400).json({ success: false, message: 'Applicant has not consented to background check' });
      }

      if (!CHECKR_API_KEY) {
        return res.status(500).json({ success: false, message: 'Checkr API key not configured' });
      }

      // 1. Create Checkr candidate
      const candidate = await checkrRequest('/candidates', 'POST', {
        first_name: app.first_name,
        last_name: app.last_name,
        email: app.email,
        phone: app.phone || undefined,
        ssn: app.ssn || undefined,
        dob: app.date_of_birth || undefined,
        zipcode: app.zip_code || undefined,
        driver_license_number: app.driver_license_number || undefined,
        driver_license_state: app.driver_license_state || undefined
      });

      // 2. Create Checkr report
      const report = await checkrRequest('/reports', 'POST', {
        candidate_id: candidate.id,
        package: pkg
      });

      // 3. Update database
      const now = new Date().toISOString();
      database.prepare(`
        UPDATE applications
        SET background_check_status = ?, background_check_report_id = ?, updated_at = ?
        WHERE id = ?
      `).run('in_progress', report.id, now, id);

      // 4. Log the action
      logBgCheck(database, id, 'initiated', 'in_progress', report.id, { candidate, report });

      // 5. Update application status to background_check if currently pending
      if (app.status === 'pending') {
        database.prepare('UPDATE applications SET status = ? WHERE id = ?').run('background_check', id);
      }

      return res.status(200).json({
        success: true,
        message: 'Background check initiated successfully',
        data: { candidate_id: candidate.id, report_id: report.id, status: report.status }
      });
    } catch (error) {
      console.error('Error creating Checkr candidate:', error);
      const status = error.status || 500;
      return res.status(status).json({
        success: false,
        message: error.message || 'Failed to initiate background check'
      });
    }
  }
);

/**
 * POST /api/checkr/candidates/:id/refresh
 * Refresh background check status from Checkr
 */
router.post(
  '/candidates/:id/refresh',
  authenticateAdmin,
  [
    param('id').notEmpty().withMessage('Application ID is required').isInt({ min: 1 }).withMessage('Application ID must be a positive integer'),
    handleValidationErrors
  ],
  async (req, res) => {
    try {
      const database = db || req.app.locals.db;
      if (!database) {
        return res.status(500).json({ success: false, message: 'Database not available' });
      }

      const { id } = req.params;

      const app = database.prepare('SELECT * FROM applications WHERE id = ?').get(id);
      if (!app) {
        return res.status(404).json({ success: false, message: 'Application not found' });
      }

      if (!app.background_check_report_id) {
        return res.status(400).json({ success: false, message: 'No background check report found for this candidate' });
      }

      if (!CHECKR_API_KEY) {
        return res.status(500).json({ success: false, message: 'Checkr API key not configured' });
      }

      // Fetch report from Checkr
      const report = await checkrRequest(`/reports/${app.background_check_report_id}`);

      const checkrStatus = report.status; // e.g., pending, complete, dispute
      const reportResult = report.result; // e.g., clear, consider, suspended

      // Map Checkr status to our status
      let dbStatus = app.background_check_status;
      let completedAt = app.background_check_completed_at;

      if (checkrStatus === 'complete') {
        dbStatus = reportResult || 'clear';
        completedAt = new Date().toISOString();
      } else if (checkrStatus === 'pending') {
        dbStatus = 'in_progress';
      }

      // Update database
      database.prepare(`
        UPDATE applications
        SET background_check_status = ?, background_check_completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(dbStatus, completedAt, new Date().toISOString(), id);

      // Log the refresh
      logBgCheck(database, id, 'completed', dbStatus, report.id, report);

      // Update application status based on bg check result
      if (dbStatus === 'clear' && app.status === 'background_check') {
        database.prepare('UPDATE applications SET status = ? WHERE id = ?').run('approved', id);
      } else if ((dbStatus === 'consider' || dbStatus === 'suspended') && app.status === 'background_check') {
        database.prepare('UPDATE applications SET status = ? WHERE id = ?').run('on_hold', id);
      }

      return res.status(200).json({
        success: true,
        message: 'Background check status refreshed',
        data: {
          report_id: report.id,
          checkr_status: checkrStatus,
          result: reportResult,
          background_check_status: dbStatus,
          completed_at: completedAt
        }
      });
    } catch (error) {
      console.error('Error refreshing Checkr status:', error);
      const status = error.status || 500;
      return res.status(status).json({
        success: false,
        message: error.message || 'Failed to refresh background check status'
      });
    }
  }
);

/**
 * GET /api/checkr/stats
 * Background check statistics
 */
router.get(
  '/stats',
  authenticateAdmin,
  async (req, res) => {
    try {
      const database = db || req.app.locals.db;
      if (!database) {
        return res.status(500).json({ success: false, message: 'Database not available' });
      }

      const stats = database.prepare(`
        SELECT background_check_status as status, COUNT(*) as count
        FROM applications
        WHERE background_check_status IS NOT NULL
        GROUP BY background_check_status
      `).all();

      const total = database.prepare('SELECT COUNT(*) as total FROM applications').get();
      const consented = database.prepare('SELECT COUNT(*) as count FROM applications WHERE background_check_consent = 1').get();
      const initiated = database.prepare('SELECT COUNT(*) as count FROM applications WHERE background_check_report_id IS NOT NULL').get();

      return res.status(200).json({
        success: true,
        data: {
          total: total.total,
          consented: consented.count,
          initiated: initiated.count,
          byStatus: stats
        }
      });
    } catch (error) {
      console.error('Error fetching Checkr stats:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch stats' });
    }
  }
);

/**
 * POST /api/checkr/webhook
 * Handle Checkr webhooks (no auth required - uses signature verification)
 */
router.post('/webhook', async (req, res) => {
  try {
    const database = db || req.app.locals.db;
    const payload = req.body;

    if (!payload || !payload.type || !payload.data) {
      return res.status(400).json({ success: false, message: 'Invalid webhook payload' });
    }

    const eventType = payload.type;
    const data = payload.data;

    // Find application by report_id
    if (data.id && eventType.startsWith('report.')) {
      const app = database.prepare('SELECT id, status FROM applications WHERE background_check_report_id = ?').get(data.id);
      if (app) {
        const reportResult = data.result || data.status;
        let dbStatus = app.background_check_status;
        let completedAt = app.background_check_completed_at;

        if (eventType === 'report.completed') {
          dbStatus = data.result || 'clear';
          completedAt = new Date().toISOString();

          // Update application status
          if (dbStatus === 'clear' && app.status === 'background_check') {
            database.prepare('UPDATE applications SET status = ? WHERE id = ?').run('approved', app.id);
          } else if ((dbStatus === 'consider' || dbStatus === 'suspended') && app.status === 'background_check') {
            database.prepare('UPDATE applications SET status = ? WHERE id = ?').run('on_hold', app.id);
          }
        } else if (eventType === 'report.disputed') {
          dbStatus = 'in_progress';
        }

        database.prepare(`
          UPDATE applications
          SET background_check_status = ?, background_check_completed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(dbStatus, completedAt, new Date().toISOString(), app.id);

        logBgCheck(database, app.id, 'webhook', dbStatus, data.id, payload);
      }
    }

    return res.status(200).json({ success: true, message: 'Webhook received' });
  } catch (error) {
    console.error('Error handling Checkr webhook:', error);
    return res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
});

module.exports = router;
