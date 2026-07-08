/**
 * Netlify Function: Admin Login
 * POST /api/admin/login
 */

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { username, password } = body;

    const adminUser = process.env.ADMIN_USERNAME;
    const adminPass = process.env.ADMIN_PASSWORD;

    if (!adminUser || !adminPass) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Admin not configured' }) };
    }

    if (username !== adminUser || password !== adminPass) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid credentials' }) };
    }

    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ role: 'admin', user: username }, process.env.JWT_SECRET, { expiresIn: '8h' });

    return { statusCode: 200, headers, body: JSON.stringify({ token }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
