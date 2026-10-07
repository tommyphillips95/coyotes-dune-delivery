/**
 * POST /api/update-driver-location
 * Body: { driver_id, lat, lng, order_id?, accuracy?, online? }
 */

const { createClient } = require('@supabase/supabase-js');

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

    if (!body.driver_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'driver_id is required' }) };
    }

    if (body.lat === undefined || body.lng === undefined) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'lat and lng are required' }) };
    }

    const lat = parseFloat(body.lat);
    const lng = parseFloat(body.lng);

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid latitude or longitude values' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const locationData = {
      driver_id: body.driver_id,
      lat: lat,
      lng: lng,
      order_id: body.order_id || null,
      accuracy: body.accuracy ? parseFloat(body.accuracy) : null,
      timestamp: new Date().toISOString(),
    };

    const { data, error } = await supabase.from('driver_locations').insert([locationData]).select().single();
    if (error) throw error;

    const online = body.online !== false;
    await supabase.from('applications').update({ online }).eq('id', body.driver_id);

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        success: true,
        data: {
          id: data.id,
          driver_id: data.driver_id,
          lat: data.lat,
          lng: data.lng,
          order_id: data.order_id,
          accuracy: data.accuracy,
          timestamp: data.timestamp,
        },
      }),
    };
  } catch (err) {
    console.error('Error updating driver location:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to update driver location', message: err.message }),
    };
  }
};
