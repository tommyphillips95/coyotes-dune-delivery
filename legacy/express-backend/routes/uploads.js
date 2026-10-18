const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'coyote-dune-dev-secret-2024';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

let db;
try {
  db = require('../database');
} catch (e) {
  db = null;
}

/**
 * Middleware: authenticate admin for uploads
 */
const authenticateAdminForUpload = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
    }
    const decoded = jwt.verify(parts[1], JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
};

function sanitizeFilename(raw) {
  const filename = path.basename(raw).replace(/[^a-zA-Z0-9._-]/g, '_');
  return filename;
}

function getMimeType(ext) {
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * GET /api/uploads/documents/:filename
 * Serve uploaded documents with admin-only access protection
 */
router.get(
  '/documents/:filename',
  authenticateAdminForUpload,
  (req, res) => {
    try {
      const rawFilename = req.params.filename;
      const filename = sanitizeFilename(rawFilename);

      if (!filename || filename.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid filename'
        });
      }

      const filePath = path.resolve(UPLOAD_DIR, filename);
      // Ensure the file is within the upload directory
      if (!filePath.startsWith(path.resolve(UPLOAD_DIR))) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({
          success: false,
          message: 'File not found'
        });
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeType = getMimeType(ext);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    } catch (error) {
      console.error('Error serving document:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to serve document'
      });
    }
  }
);

/**
 * GET /api/uploads/documents/:filename/download
 * Download uploaded documents with admin-only access
 */
router.get(
  '/documents/:filename/download',
  authenticateAdminForUpload,
  (req, res) => {
    try {
      const rawFilename = req.params.filename;
      const filename = sanitizeFilename(rawFilename);

      if (!filename || filename.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid filename'
        });
      }

      const filePath = path.resolve(UPLOAD_DIR, filename);
      if (!filePath.startsWith(path.resolve(UPLOAD_DIR))) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({
          success: false,
          message: 'File not found'
        });
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeType = getMimeType(ext);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    } catch (error) {
      console.error('Error downloading document:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to download document'
      });
    }
  }
);

module.exports = router;
