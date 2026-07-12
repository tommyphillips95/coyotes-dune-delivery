/**
 * Firebase Cloud Messaging — Service Worker
 * Coyote's Dune Delivery
 *
 * Handles background push notifications when the app is not
 * in the foreground. Must be at the root so it can control all pages.
 */

importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// ── Firebase Config (placeholder — must match frontend config) ──
const FIREBASE_CONFIG = {
  apiKey:            'YOUR_FIREBASE_API_KEY',
  authDomain:        'YOUR_PROJECT_ID.firebaseapp.com',
  projectId:         'YOUR_PROJECT_ID',
  storageBucket:     'YOUR_PROJECT_ID.appspot.com',
  messagingSenderId: 'YOUR_MESSAGING_SENDER_ID',
  appId:             'YOUR_FIREBASE_APP_ID',
};

firebase.initializeApp(FIREBASE_CONFIG);

const messaging = firebase.messaging();

// ── Background Message Handler ──
messaging.onBackgroundMessage((payload) => {
  console.log('[FCM SW] Background message received:', payload);

  const { notification = {}, data = {} } = payload;

  const title = notification.title || data.title || "Coyote's Dune Delivery";
  const body  = notification.body  || data.body  || 'You have a new notification.';
  const icon  = notification.icon  || data.icon  || '/assets/icon-192.png';
  const image = notification.image || data.image || null;

  // Build click action URL
  let clickAction = data.click_action || data.url || '/';
  if (data.order_id) {
    clickAction = `/track/?order=${data.order_id}`;
  } else if (data.driver_id) {
    clickAction = '/driver/';
  }

  const notificationOptions = {
    body: body,
    icon: icon,
    badge: '/assets/icon-72.png',
    tag: data.tag || 'coyote-default',
    requireInteraction: data.require_interaction === 'true',
    data: {
      clickAction: clickAction,
      orderId: data.order_id || null,
      driverId: data.driver_id || null,
      ...data,
    },
  };

  if (image) {
    notificationOptions.image = image;
  }

  // Add action buttons if specified
  if (data.actions) {
    try {
      notificationOptions.actions = JSON.parse(data.actions);
    } catch (e) {
      console.warn('[FCM SW] Failed to parse actions:', e);
    }
  }

  return self.registration.showNotification(title, notificationOptions);
});

// ── Notification Click Handler ──
self.addEventListener('notificationclick', (event) => {
  console.log('[FCM SW] Notification clicked:', event);

  event.notification.close();

  const clickAction = event.notification.data?.clickAction || '/';

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // If an existing tab is open, focus it and navigate
        for (const client of clientList) {
          if (client.url && client.focus) {
            client.focus();
            return client.navigate(clickAction);
          }
        }
        // Otherwise open a new window
        return clients.openWindow(clickAction);
      })
      .catch((err) => {
        console.error('[FCM SW] Error handling notification click:', err);
        return clients.openWindow('/');
      })
  );
});

// ── Service Worker Lifecycle ──
self.addEventListener('install', (event) => {
  console.log('[FCM SW] Service Worker installing...');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[FCM SW] Service Worker activated.');
  event.waitUntil(self.clients.claim());
});

// ── Push Event (fallback for non-FCM push) ──
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch (e) {
    payload = { title: "Coyote's Dune Delivery", body: event.data.text() };
  }

  const title = payload.title || payload.notification?.title || "Coyote's Dune Delivery";
  const body = payload.body || payload.notification?.body || 'New notification';
  const icon = payload.icon || payload.notification?.icon || '/assets/icon-192.png';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: icon,
      badge: '/assets/icon-72.png',
      tag: payload.tag || 'coyote-push',
      data: { clickAction: payload.url || '/' },
    })
  );
});
