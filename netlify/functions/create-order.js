/**
 * Netlify Function: Create Customer Order
 * POST /api/orders
 */

const { createClient } = require('@supabase/supabase-js');

function generateOrderNumber() {
  const prefix = 'CDD';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
}

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

    // Validate required fields
    if (!body.first_name || !body.last_name || !body.phone) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'First name, last name, and phone are required' }),
      };
    }

    if (!body.pickup_address || !body.pickup_city) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Pickup address and city are required' }),
      };
    }

    if (!body.service_type) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Service type is required' }),
      };
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // 1. Find or create customer
    let customerId;
    const { data: existingCustomer, error: customerLookupError } = await supabase
      .from('customers')
      .select('id')
      .eq('phone', body.phone.trim())
      .maybeSingle();

    if (customerLookupError) throw customerLookupError;

    if (existingCustomer) {
      customerId = existingCustomer.id;
    } else {
      const { data: newCustomer, error: customerError } = await supabase
        .from('customers')
        .insert([{
          first_name: body.first_name.trim(),
          last_name: body.last_name.trim(),
          phone: body.phone.trim(),
          email: body.email ? body.email.trim() : null,
        }])
        .select()
        .single();

      if (customerError) throw customerError;
      customerId = newCustomer.id;
    }

    // 2. Generate order number
    const orderNumber = generateOrderNumber();

    // 3. Parse scheduling
    let isAsap = true;
    let scheduledDate = null;
    let scheduledTime = null;

    if (body.schedule === 'later' && body.scheduled_date && body.scheduled_time) {
      isAsap = false;
      scheduledDate = body.scheduled_date;
      scheduledTime = body.scheduled_time;
    }

    // 4. Estimate price based on service type
    const priceMap = {
      ride: { base: 12, per_mile: 2.5 },
      package_delivery: { base: 15, per_mile: 2.0 },
      grocery_run: { base: 18, per_mile: 1.5 },
      group_transport: { base: 35, per_mile: 3.0 },
    };

    const pricing = priceMap[body.service_type] || priceMap.ride;
    let estimatedPrice = pricing.base;

    // Add distance estimate if cities differ
    const zoneDistances = {
      'Port Aransas-Padre Island': 18,
      'Padre Island-Port Aransas': 18,
      'Port Aransas-Port Aransas': 4,
      'Padre Island-Padre Island': 5,
    };
    const zoneKey = `${body.pickup_city}-${body.dropoff_city || body.pickup_city}`;
    const miles = zoneDistances[zoneKey] || 10;
    estimatedPrice += miles * pricing.per_mile;

    // Add passenger/package surcharges
    if (body.passenger_count && body.passenger_count > 1) {
      estimatedPrice += (body.passenger_count - 1) * 3;
    }
    if (body.package_size === 'large') estimatedPrice += 8;
    if (body.package_size === 'oversized') estimatedPrice += 15;

    estimatedPrice = Math.round(estimatedPrice * 100) / 100;

    // 5. Create order
    const orderData = {
      order_number: orderNumber,
      customer_id: customerId,
      service_type: body.service_type,
      status: 'pending',
      pickup_address: body.pickup_address.trim(),
      pickup_city: body.pickup_city.trim(),
      pickup_zip: body.pickup_zip ? body.pickup_zip.trim() : null,
      dropoff_address: body.dropoff_address ? body.dropoff_address.trim() : null,
      dropoff_city: body.dropoff_city ? body.dropoff_city.trim() : null,
      dropoff_zip: body.dropoff_zip ? body.dropoff_zip.trim() : null,
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      is_asap: isAsap,
      passenger_count: body.passenger_count ? parseInt(body.passenger_count) : 1,
      package_description: body.package_description ? body.package_description.trim() : null,
      package_size: body.package_size || null,
      special_instructions: body.special_instructions ? body.special_instructions.trim() : null,
      estimated_price: estimatedPrice,
      final_price: null,
      tip_amount: body.tip_amount ? parseFloat(body.tip_amount) : 0,
    };

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert([orderData])
      .select()
      .single();

    if (orderError) throw orderError;

    // 6. Add order items if provided (grocery list, etc.)
    if (body.order_items && Array.isArray(body.order_items) && body.order_items.length > 0) {
      const items = body.order_items
        .filter(item => item.item_name && item.item_name.trim())
        .map(item => ({
          order_id: order.id,
          item_name: item.item_name.trim(),
          quantity: item.quantity ? parseInt(item.quantity) : 1,
          description: item.description ? item.description.trim() : null,
        }));

      if (items.length > 0) {
        const { error: itemsError } = await supabase
          .from('order_items')
          .insert(items);
        if (itemsError) console.error('Error inserting order items:', itemsError);
      }
    }

    // 7. Log initial status
    await supabase
      .from('order_status_logs')
      .insert([{
        order_id: order.id,
        status: 'pending',
        note: 'Order received and awaiting assignment',
        changed_by: 'system',
      }]);

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        success: true,
        orderId: order.id,
        orderNumber: order.order_number,
        estimatedPrice: order.estimated_price,
        status: order.status,
      }),
    };
  } catch (err) {
    console.error('Error creating order:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to create order', message: err.message }),
    };
  }
};
