const express = require('express');
const { body, param, validationResult } = require('express-validator');
const router = express.Router();

let db;
try {
  db = require('../database');
} catch (e) {
  db = null;
}

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
 * Middleware: ensure driver exists and is approved
 */
const requireApprovedDriver = async (req, res, next) => {
  try {
    const database = db || req.app.locals.db;
    if (!database) {
      return res.status(500).json({
        success: false,
        message: 'Database not available'
      });
    }

    const { applicantId } = req.params;

    const row = database.prepare('SELECT status FROM applications WHERE applicant_id = ?').get(applicantId);
    if (!row) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      });
    }
    if (row.status !== 'approved') {
      return res.status(403).json({
        success: false,
        message: 'Driver is not approved'
      });
    }
    next();
  } catch (err) {
    console.error('Error in requireApprovedDriver:', err);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

/**
 * POST /api/drivers/status
 * Check application status by applicantId + email (public, no auth required)
 */
router.post(
  '/status',
  [
    body('applicantId')
      .trim()
      .notEmpty().withMessage('Applicant ID is required'),
    body('email')
      .trim()
      .notEmpty().withMessage('Email is required')
      .isEmail().withMessage('Invalid email format'),
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

      const { applicantId, email } = req.body;

      const stmt = database.prepare(`
        SELECT
          id, applicant_id, first_name, last_name, email, phone,
          date_of_birth, address, city, state, zip_code,
          vehicle_year, vehicle_make, vehicle_model, vehicle_color, license_plate,
          driver_license_number, driver_license_state, driver_license_expiry,
          insurance_provider, insurance_policy_number, insurance_expiry,
          bank_account_name, bank_name, bank_account_number, bank_routing_number,
          status, admin_notes, created_at, updated_at
        FROM applications
        WHERE applicant_id = ? AND email = ?
      `);
      const row = stmt.get(applicantId, email);

      if (!row) {
        return res.status(404).json({
          success: false,
          message: 'Application not found. Please check your Applicant ID and email.'
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
      console.error('Error fetching driver status:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch driver status'
      });
    }
  }
);

/**
 * GET /api/drivers/:applicantId
 * Get approved driver profile
 */
router.get(
  '/:applicantId',
  [
    param('applicantId')
      .trim()
      .notEmpty().withMessage('Applicant ID is required')
      .matches(/^APP-[\d]+-[A-Z0-9]+$/)
      .withMessage('Invalid applicant ID format'),
    handleValidationErrors,
    requireApprovedDriver
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

      const { applicantId } = req.params;

      const stmt = database.prepare(`
        SELECT
          id, applicant_id, first_name, last_name, email, phone,
          date_of_birth, address, city, state, zip_code,
          vehicle_year, vehicle_make, vehicle_model, vehicle_color, license_plate,
          driver_license_number, driver_license_state, driver_license_expiry,
          insurance_provider, insurance_policy_number, insurance_expiry,
          bank_account_name, bank_name, bank_account_number, bank_routing_number,
          status, created_at, updated_at
        FROM applications
        WHERE applicant_id = ?
      `);
      const row = stmt.get(applicantId);

      if (!row) {
        return res.status(404).json({
          success: false,
          message: 'Driver not found'
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
        created_at: row.created_at,
        updated_at: row.updated_at
      };

      return res.status(200).json({
        success: true,
        data: mapped
      });
    } catch (error) {
      console.error('Error fetching driver profile:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch driver profile'
      });
    }
  }
);

/**
 * PUT /api/drivers/:applicantId
 * Update driver info (for approved drivers)
 */
router.put(
  '/:applicantId',
  [
    param('applicantId')
      .trim()
      .notEmpty().withMessage('Applicant ID is required')
      .matches(/^APP-[\d]+-[A-Z0-9]+$/)
      .withMessage('Invalid applicant ID format'),
    body('phone')
      .optional()
      .trim()
      .matches(/^\+?1?\s*[-.]?\s*\(?\d{3}\)?\s*[-.]?\s*\d{3}\s*[-.]?\s*\d{4}$/)
      .withMessage('Phone must be a valid US phone number'),
    body('vehicle_year')
      .optional()
      .isInt({ min: 1990, max: new Date().getFullYear() + 1 })
      .withMessage('Vehicle year must be between 1990 and next year'),
    handleValidationErrors,
    requireApprovedDriver
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

      const { applicantId } = req.params;
      const b = req.body;

      // Map frontend field names to DB column names
      const updates = [];
      const params = [];

      if (b.phone !== undefined) { updates.push('phone = ?'); params.push(b.phone); }
      if (b.vehicle_make !== undefined) { updates.push('vehicle_make = ?'); params.push(b.vehicle_make); }
      if (b.vehicle_model !== undefined) { updates.push('vehicle_model = ?'); params.push(b.vehicle_model); }
      if (b.vehicle_year !== undefined) { updates.push('vehicle_year = ?'); params.push(b.vehicle_year); }
      if (b.vehicle_color !== undefined) { updates.push('vehicle_color = ?'); params.push(b.vehicle_color); }
      if (b.vehicle_plate !== undefined) { updates.push('license_plate = ?'); params.push(b.vehicle_plate); }
      if (b.insurance_provider !== undefined) { updates.push('insurance_provider = ?'); params.push(b.insurance_provider); }
      if (b.insurance_policy !== undefined) { updates.push('insurance_policy_number = ?'); params.push(b.insurance_policy); }
      if (b.insurance_expiry !== undefined) { updates.push('insurance_expiry = ?'); params.push(b.insurance_expiry); }
      if (b.bank_name !== undefined) { updates.push('bank_name = ?'); params.push(b.bank_name); }
      if (b.bank_account !== undefined) { updates.push('bank_account_number = ?'); params.push(b.bank_account); }
      if (b.bank_routing !== undefined) { updates.push('bank_routing_number = ?'); params.push(b.bank_routing); }

      if (updates.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No fields to update'
        });
      }

      updates.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(applicantId);

      const sql = `UPDATE applications SET ${updates.join(', ')} WHERE applicant_id = ?`;
      database.prepare(sql).run(...params);

      return res.status(200).json({
        success: true,
        message: 'Driver profile updated successfully'
      });
    } catch (error) {
      console.error('Error updating driver profile:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to update driver profile'
      });
    }
  }
);

/**
 * POST /api/drivers/:applicantId/documents
 * Upload endpoint for documents
 */
router.post(
  '/:applicantId/documents',
  [
    param('applicantId')
      .trim()
      .notEmpty().withMessage('Applicant ID is required')
      .matches(/^APP-[\d]+-[A-Z0-9]+$/)
      .withMessage('Invalid applicant ID format'),
    handleValidationErrors,
    requireApprovedDriver
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

      const { applicantId } = req.params;
      // In a real implementation, you'd use multer here to handle file uploads
      // For now, we accept a document_type and a file_url (or base64 data)
      const { document_type, file_url } = req.body;

      if (!document_type || !file_url) {
        return res.status(400).json({
          success: false,
          message: 'document_type and file_url are required'
        });
      }

      const stmt = database.prepare(
        'INSERT INTO documents (applicant_id, doc_type, file_path) VALUES (?, ?, ?)'
      );
      const result = stmt.run(applicantId, document_type, file_url);

      return res.status(201).json({
        success: true,
        message: 'Document uploaded successfully',
        data: {
          document_id: result.lastInsertRowid,
          applicant_id: applicantId,
          document_type,
          file_url
        }
      });
    } catch (error) {
      console.error('Error uploading document:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to upload document'
      });
    }
  }
);

/**
 * GET /api/drivers/:applicantId/documents
 * List uploaded documents
 */
router.get(
  '/:applicantId/documents',
  [
    param('applicantId')
      .trim()
      .notEmpty().withMessage('Applicant ID is required')
      .matches(/^APP-[\d]+-[A-Z0-9]+$/)
      .withMessage('Invalid applicant ID format'),
    handleValidationErrors,
    requireApprovedDriver
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

      const { applicantId } = req.params;

      const rows = database.prepare(
        'SELECT id, doc_type, file_path, uploaded_at FROM documents WHERE applicant_id = ? ORDER BY uploaded_at DESC'
      ).all(applicantId);

      return res.status(200).json({
        success: true,
        data: rows.map(r => ({
          id: r.id,
          name: r.file_path,
          filename: r.file_path,
          url: r.file_path,
          doc_type: r.doc_type,
          uploaded_at: r.uploaded_at
        }))
      });
    } catch (error) {
      console.error('Error fetching documents:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch documents'
      });
    }
  }
);

module.exports = router;
