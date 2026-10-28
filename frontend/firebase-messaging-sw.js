/**
 * Firebase Cloud Messaging — Service Worker
 * Coyote's Dune Delivery
 *
 * Handles background push notifications when the app is not
 * in the foreground. Must be at the root so it can control all pages.
 *
 * Placeholder YOUR_* config: do not importScripts Firebase or call Google.
 * Page JS only registers this SW when config is real; this guard covers
 * stale registrations and accidental loads.
 */

// ── Firebase Config (placeholder — must match frontend config) ──
const FIREBASE_CONFIG = {
  apiKey:            'YOUR_FIREBASE_API_KEY',
  authDomain:        'YOUR_PROJECT_ID.firebaseapp.com',
  projectId:         'YOUR_PROJECT_ID',
  storageBucket:     'YOUR_PROJECT_ID.appspot.com',
  messagingSenderId: 'YOUR_MESSAGING_SENDER_ID',
  appId:             'YOUR_FIREBASE_APP_ID',
};

const CONFIGURED = !/^(YOUR_|$)/.test(String(FIREBASE_CONFIG.apiKey || '')) &&
  !/^(YOUR_|$)/.test(String(FIREBASE_CONFIG.projectId || ''));

// Lifecycle always (safe no-op shell when placeholders remain).
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

if (!CONFIGURED) {
  // Leave placeholders alone — no gstatic downloads, no initializeApp.
} else {
  importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

  firebase.initializeApp(FIREBASE_CONFIG);

  const messaging = firebase.messaging();

  // ── Background Message Handler ──
  messaging.onBackgroundMessage((payload) => {
    const { notification = {}, data = {} } = payload;

    const title = notification.title || data.title || "Coyote's Dune Delivery";
    const body  = notification.body  || data.body  || 'You have a new notification.';
    const icon  = notification.icon  || data.icon  || '/assets/icon-192.png';
    const image = notification.image || data.image || null;

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

    if (data.actions) {
      try {
        notificationOptions.actions = JSON.parse(data.actions);
      } catch (e) {
        // ignore bad actions payload
      }
    }

    return self.registration.showNotification(title, notificationOptions);
  });

  // ── Notification Click Handler ──
  self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const clickAction = event.notification.data?.clickAction || '/';

    event.waitUntil(
      clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((clientList) => {
          for (const client of clientList) {
            if (client.url && client.focus) {
              client.focus();
              return client.navigate(clickAction);
            }
          }
          return clients.openWindow(clickAction);
        })
        .catch(() => clients.openWindow('/'))
    );
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
}
