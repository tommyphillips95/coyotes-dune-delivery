const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, param, query, validationResult } = require('express-validator');
const router = express.Router();

let db;
try {
  db = require('../database');
} catch (e) {
  db = null;
}

// JWT secret from environment or default (change in production)
const JWT_SECRET = process.env.JWT_SECRET || 'coyote-dune-delivery-secret-key-2024';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

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
    const authHeader = req.headers.authorization || '';
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      return res.status(401).json({
        success: false,
        message: 'Missing or malformed Authorization header'
      });
    }
    const decoded = jwt.verify(parts[1], JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Admin access required'
      });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }
};

/**
 * POST /api/admin/login
 * Admin login with JWT
 */
router.post(
  '/login',
  [
    body('username')
      .trim()
      .notEmpty().withMessage('Username is required'),
    body('password')
      .notEmpty().withMessage('Password is required'),
    handleValidationErrors
  ],
  async (req, res) => {
    try {
      const database = db || req.app.locals.db;
      if (!database) {
        return res.status(500).json({
          success: false,
          message: 'Database not available'
        });
      }

      const { username, password } = req.body;

      const admin = database.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
      if (!admin) {
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials'
        });
      }

      const valid = await bcrypt.compare(password, admin.password_hash);
      if (!valid) {
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials'
        });
      }

      const token = jwt.sign(
        { username: admin.username, role: 'admin' },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );

      return res.status(200).json({
        success: true,
        message: 'Login successful',
        token,
        expiresIn: JWT_EXPIRES_IN
      });
    } catch (error) {
      console.error('Error during admin login:', error);
      return res.status(500).json({
        success: false,
        message: 'Login failed'
      });
    }
  }
);

/**
 * GET /api/admin/applications
 * List all applications with optional filtering
 * Requires admin auth
 */
router.get(
  '/applications',
  authenticateAdmin,
  [
    query('status')
      .optional()
      .isIn(['pending', 'background_check', 'approved', 'rejected', 'on_hold'])
      .withMessage('Invalid status value'),
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
        return res.status(500).json({
          success: false,
          message: 'Database not available'
        });
      }

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const offset = (page - 1) * limit;
      const status = req.query.status || null;
      const search = req.query.search || null;

      const whereClauses = [];
      const params = [];

      if (status) {
        whereClauses.push('status = ?');
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

      // Get total count
      const countStmt = database.prepare(
        `SELECT COUNT(*) as total FROM applications ${whereString}`
      );
      const { total } = countStmt.get(...params);

      // Get paginated results
      const queryStmt = database.prepare(`
        SELECT
          id, applicant_id, first_name, last_name, email, phone,
          status, admin_notes, created_at, updated_at
        FROM applications
        ${whereString}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `);
      const rows = queryStmt.all(...params, limit, offset);

      return res.status(200).json({
        success: true,
        data: {
          applications: rows.map(r => ({
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
      console.error('Error listing applications:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to list applications'
      });
    }
  }
);

/**
 * GET /api/admin/applications/:id
 * Single application details (full)
 * Requires admin auth
 */
router.get(
  '/applications/:id',
  authenticateAdmin,
  [
    param('id')
      .notEmpty().withMessage('Application ID is required')
      .isInt({ min: 1 }).withMessage('Application ID must be a positive integer'),
    handleValidationErrors
  ],
  async (req, res) => {
    try {
      const database = db || req.app.locals.db;
      if (!database) {
        return res.status(500).json({
          success: false,
          message: 'Database not available'
        });
      }

      const { id } = req.params;

      const stmt = database.prepare(`
        SELECT
          id, applicant_id, first_name, last_name, email, phone, ssn, date_of_birth,
          address, city, state, zip_code,
          vehicle_year, vehicle_make, vehicle_model, vehicle_color, license_plate,
          driver_license_number, driver_license_state, driver_license_expiry,
          insurance_provider, insurance_policy_number, insurance_expiry,
          bank_account_name, bank_account_number, bank_routing_number, bank_name,
          status, admin_notes, created_at, updated_at
        FROM applications
        WHERE id = ?
      `);
      const row = stmt.get(id);

      if (!row) {
        return res.status(404).json({
          success: false,
          message: 'Application not found'
        });
      }

      // Map to frontend expected field names
      const mapped = {
        id: row.id,
        applicant_id: row.applicant_id,
        name: `${row.first_name} ${row.last_name}`,
        first_name: row.first_name,
        last_name: row.last_name,
        email: row.email,
        phone: row.phone,
        ssn: row.ssn,
        dob: row.date_of_birth,
        address: row.address,
        city: row.city,
        state: row.state,
        zip: row.zip_code,
        vehicle_year: row.vehicle_year,
        vehicle_make: row.vehicle_make,
        vehicle_model: row.vehicle_model,
        vehicle_color: row.vehicle_color,
        vehicle_plate: row.license_plate,
        license_number: row.driver_license_number,
        license_state: row.driver_license_state,
        license_expiry: row.driver_license_expiry,
        insurance_provider: row.insurance_provider,
        insurance_policy: row.insurance_policy_number,
        insurance_expiry: row.insurance_expiry,
        bank_name: row.bank_name,
        bank_account: row.bank_account_number,
        bank_routing: row.bank_routing_number,
        status: row.status,
        admin_notes: row.admin_notes,
        submitted: row.created_at,
        created_at: row.created_at,
        updated_at: row.updated_at
      };

      return res.status(200).json({
        success: true,
        data: mapped
      });
    } catch (error) {
      console.error('Error fetching application details:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch application details'
      });
    }
  }
);

/**
 * PUT /api/admin/applications/:id
 * Update application status and notes
 * Requires admin auth
 */
router.put(
  '/applications/:id',
  authenticateAdmin,
  [
    param('id')
      .notEmpty().withMessage('Application ID is required')
      .isInt({ min: 1 }).withMessage('Application ID must be a positive integer'),
    body('status')
      .optional()
      .isIn(['pending', 'background_check', 'approved', 'rejected', 'on_hold'])
      .withMessage('Invalid status value'),
    body('notes')
      .optional()
      .trim()
      .isLength({ max: 2000 })
      .withMessage('Notes must be 2000 characters or less'),
    handleValidationErrors
  ],
  async (req, res) => {
    try {
      const database = db || req.app.locals.db;
      if (!database) {
        return res.status(500).json({
          success: false,
          message: 'Database not available'
        });
      }

      const { id } = req.params;
      const { status, notes } = req.body;

      const existing = database.prepare('SELECT id FROM applications WHERE id = ?').get(id);
      if (!existing) {
        return res.status(404).json({
          success: false,
          message: 'Application not found'
        });
      }

      const updates = [];
      const params = [];

      if (status !== undefined) {
        updates.push('status = ?');
        params.push(status);
      }
      if (notes !== undefined) {
        updates.push('admin_notes = ?');
        params.push(notes);
      }
      if (updates.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No fields to update'
        });
      }

      updates.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(id);

      const sql = `UPDATE applications SET ${updates.join(', ')} WHERE id = ?`;
      database.prepare(sql).run(...params);

      return res.status(200).json({
        success: true,
        message: 'Application updated successfully'
      });
    } catch (error) {
      console.error('Error updating application:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to update application'
      });
    }
  }
);

/**
 * DELETE /api/admin/applications/:id
 * Remove an application
 * Requires admin auth
 */
router.delete(
  '/applications/:id',
  authenticateAdmin,
  [
    param('id')
      .notEmpty().withMessage('Application ID is required')
      .isInt({ min: 1 }).withMessage('Application ID must be a positive integer'),
    handleValidationErrors
  ],
  async (req, res) => {
    try {
      const database = db || req.app.locals.db;
      if (!database) {
        return res.status(500).json({
          success: false,
          message: 'Database not available'
        });
      }

      const { id } = req.params;

      const existing = database.prepare('SELECT id FROM applications WHERE id = ?').get(id);
      if (!existing) {
        return res.status(404).json({
          success: false,
          message: 'Application not found'
        });
      }

      // Delete related documents first (if any)
      database.prepare('DELETE FROM documents WHERE applicant_id IN (SELECT applicant_id FROM applications WHERE id = ?)').run(id);
      // Delete the application
      database.prepare('DELETE FROM applications WHERE id = ?').run(id);

      return res.status(200).json({
        success: true,
        message: 'Application deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting application:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to delete application'
      });
    }
  }
);

/**
 * GET /api/admin/stats
 * Dashboard counts by status
 * Requires admin auth
 */
router.get(
  '/stats',
  authenticateAdmin,
  async (req, res) => {
    try {
      const database = db || req.app.locals.db;
      if (!database) {
        return res.status(500).json({
          success: false,
          message: 'Database not available'
        });
      }

      const stats = database.prepare(`
        SELECT status, COUNT(*) as count
        FROM applications
        GROUP BY status
      `).all();

      const total = database.prepare('SELECT COUNT(*) as total FROM applications').get();

      return res.status(200).json({
        success: true,
        data: {
          total: total.total,
          byStatus: stats
        }
      });
    } catch (error) {
      console.error('Error fetching stats:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch stats'
      });
    }
  }
);

module.exports = router;
