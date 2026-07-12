/**
 * Netlify Function: Send Push Notification via Firebase Cloud Messaging
 * POST /api/send-push-notification
 *
 * Receives an FCM token (or topic), title, body, and data payload,
 * then sends a push notification via the Firebase Admin SDK.
 *
 * Body:
 *   {
 *     fcm_token: string,      // target device token (or use topic)
 *     topic: string,          // optional: send to topic instead of token
 *     title: string,
 *     body: string,
 *     data: object,           // optional key-value payload
 *     image: string,          // optional image URL
 *     require_interaction: boolean
 *   }
 */

const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');

let firebaseAppInitialized = false;

function initFirebase() {
  if (firebaseAppInitialized) return;

  // The user must set FIREBASE_ADMIN_SDK_JSON as a Netlify env var.
  // It should be the JSON content of the service account key file.
  const serviceAccountJson = process.env.FIREBASE_ADMIN_SDK_JSON;

  if (!serviceAccountJson) {
    throw new Error(
      'FIREBASE_ADMIN_SDK_JSON environment variable is not set. ' +
      'Please add your Firebase Admin SDK service account JSON to Netlify environment variables.'
    );
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch (e) {
    throw new Error('FIREBASE_ADMIN_SDK_JSON is not valid JSON: ' + e.message);
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  firebaseAppInitialized = true;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed. Use POST.' }),
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    // ── Validate required fields ──
    if (!body.title || !body.body) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields: title and body are required.' }),
      };
    }

    if (!body.fcm_token && !body.topic) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing target: provide either fcm_token or topic.' }),
      };
    }

    // ── Initialize Firebase Admin ──
    initFirebase();

    // ── Build the message payload ──
    const notificationPayload = {
      notification: {
        title: String(body.title),
        body: String(body.body),
      },
      data: {
        ...flattenData(body.data || {}),
        click_action: body.click_action || '/',
      },
    };

    // Optional image
    if (body.image) {
      notificationPayload.notification.image = String(body.image);
    }

    // Optional Android config
    notificationPayload.android = {
      priority: 'high',
      notification: {
        channelId: 'coyote-default',
        sound: 'default',
        icon: 'notification_icon',
        color: '#1a3a5c',
      },
    };

    // Optional APNS config for iOS
    notificationPayload.apns = {
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
        },
      },
    };

    // Optional webpush config
    notificationPayload.webpush = {
      headers: {
        Urgency: 'high',
      },
      notification: {
        requireInteraction: body.require_interaction === true,
        actions: body.actions || [],
      },
    };

    // ── Send the message ──
    let response;
    if (body.topic) {
      // Send to topic
      notificationPayload.topic = String(body.topic);
      response = await admin.messaging().send(notificationPayload);
    } else {
      // Send to specific token
      notificationPayload.token = String(body.fcm_token);
      response = await admin.messaging().send(notificationPayload);
    }

    // ── Log the push in Supabase (if configured) ──
    try {
      if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
        const supabase = createClient(
          process.env.SUPABASE_URL,
          process.env.SUPABASE_SERVICE_KEY
        );
        await supabase.from('push_notification_logs').insert([
          {
            fcm_token: body.fcm_token || null,
            topic: body.topic || null,
            title: body.title,
            body: body.body,
            data_payload: body.data || {},
            message_id: response,
            status: 'sent',
          },
        ]);
      }
    } catch (logErr) {
      console.warn('[send-push-notification] Failed to log to Supabase:', logErr.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        messageId: response,
        sentTo: body.topic ? `topic:${body.topic}` : `token:${body.fcm_token.substring(0, 20)}...`,
      }),
    };
  } catch (err) {
    console.error('[send-push-notification] Error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to send push notification',
        message: err.message,
      }),
    };
  }
};

/**
 * Flatten a nested data object into string key-value pairs
 * (FCM data payloads must be strings).
 */
function flattenData(obj, prefix = '') {
  const result = {};
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (value === null || value === undefined) {
      result[fullKey] = '';
    } else if (typeof value === 'object') {
      Object.assign(result, flattenData(value, fullKey));
    } else {
      result[fullKey] = String(value);
    }
  }
  return result;
}
