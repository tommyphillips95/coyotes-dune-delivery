/**
 * Netlify Function: Get Driver Location
 * GET /api/get-driver-location?driver_id=XXX
 * GET /api/get-driver-location?order_id=YYY
 * 
 * Returns the latest location for a given driver or order.
 */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // Parse query params
    const url = new URL(event.rawUrl || `http://localhost${event.path}`);
    const driverId = url.searchParams.get('driver_id');
    const orderId = url.searchParams.get('order_id');

    if (!driverId && !orderId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Please provide driver_id or order_id parameter' }),
      };
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    let query = supabase
      .from('driver_locations')
      .select('*');

    if (driverId) {
      query = query.eq('driver_id', driverId);
    } else if (orderId) {
      query = query.eq('order_id', orderId);
    }

    // Get the most recent location
    query = query.order('timestamp', { ascending: false }).limit(1);

    const { data, error } = await query;

    if (error) throw error;

    if (!data || data.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'No location found for this driver/order' }),
      };
    }

    const location = data[0];

    // Also fetch driver info if available
    let driverInfo = null;
    if (location.driver_id) {
      const { data: driverData, error: driverError } = await supabase
        .from('applications')
        .select('first_name, last_name, vehicle_make, vehicle_model, vehicle_color')
        .eq('id', location.driver_id)
        .maybeSingle();
      
      if (!driverError && driverData) {
        driverInfo = driverData;
      }
    }

    // Fetch order info if available
    let orderInfo = null;
    if (location.order_id) {
      const { data: orderData, error: orderError } = await supabase
        .from('orders')
        .select('order_number, pickup_address, dropoff_address, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng')
        .eq('id', location.order_id)
        .maybeSingle();
      
      if (!orderError && orderData) {
        orderInfo = orderData;
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        data: {
          location: {
            id: location.id,
            driver_id: location.driver_id,
            lat: location.lat,
            lng: location.lng,
            order_id: location.order_id,
            accuracy: location.accuracy,
            timestamp: location.timestamp,
          },
          driver: driverInfo,
          order: orderInfo,
        },
      }),
    };
  } catch (err) {
    console.error('Error fetching driver location:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to fetch driver location', message: err.message }),
    };
  }
};
