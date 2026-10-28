/**
 * Firebase Cloud Messaging (FCM) — Frontend Integration
 * Coyote's Dune Delivery
 *
 * Initializes Firebase, requests notification permission,
 * gets FCM token, registers a service worker for background
 * notifications, and handles incoming foreground messages.
 *
 * Usage:
 *   import { initMessaging, getFCMToken } from './firebase-messaging.js';
 *   await initMessaging();
 *   const token = await getFCMToken();
 */

(function () {
  'use strict';

  // ── Firebase Config (placeholder — user must replace with real values) ──
  const FIREBASE_CONFIG = {
    apiKey:            window.__FIREBASE_API_KEY__            || 'YOUR_FIREBASE_API_KEY',
    authDomain:        window.__FIREBASE_AUTH_DOMAIN__      || 'YOUR_PROJECT_ID.firebaseapp.com',
    projectId:         window.__FIREBASE_PROJECT_ID__         || 'YOUR_PROJECT_ID',
    storageBucket:     window.__FIREBASE_STORAGE_BUCKET__     || 'YOUR_PROJECT_ID.appspot.com',
    messagingSenderId: window.__FIREBASE_MESSAGING_SENDER_ID__ || 'YOUR_MESSAGING_SENDER_ID',
    appId:             window.__FIREBASE_APP_ID__             || 'YOUR_FIREBASE_APP_ID',
  };

  const VAPID_KEY = window.__FIREBASE_VAPID_KEY__ || 'YOUR_VAPID_KEY';
  // Placeholder config: skip init (and the service-worker registration).
  const CONFIGURED = !/^(YOUR_|$)/.test(String(FIREBASE_CONFIG.apiKey || '')) &&
    !/^(YOUR_|$)/.test(String(FIREBASE_CONFIG.projectId || '')) && !/^(YOUR_|$)/.test(String(VAPID_KEY || ''));
  window.__CDD_FIREBASE_MESSAGING_CONFIGURED__ = CONFIGURED;

  // ── Internal state ──
  let messaging = null;
  let firebaseApp = null;
  let currentToken = null;
  let swRegistration = null;

  // ── Toast / In-App Notification UI ──
  function showToast(title, body, icon) {
    const toast = document.createElement('div');
    toast.className = 'fcm-toast';
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      max-width: 360px;
      background: #fff;
      border-left: 4px solid #1a3a5c;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.15);
      padding: 16px 20px;
      display: flex;
      align-items: flex-start;
      gap: 12px;
      z-index: 9999;
      animation: slideInRight 0.3s ease-out;
      font-family: 'Inter', sans-serif;
    `;

    const iconHtml = icon
      ? `<img src="${icon}" alt="" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;">`
      : `<div style="width:40px;height:40px;border-radius:50%;background:#1a3a5c;color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🐺</div>`;

    toast.innerHTML = `
      ${iconHtml}
      <div style="flex:1;">
        <div style="font-weight:700;font-size:0.95rem;color:#1a3a5c;margin-bottom:4px;">${escapeHtml(title)}</div>
        <div style="font-size:0.85rem;color:#555;line-height:1.4;">${escapeHtml(body)}</div>
      </div>
      <button style="background:none;border:none;font-size:1.2rem;color:#999;cursor:pointer;padding:0 4px;line-height:1;" onclick="this.parentElement.remove()">×</button>
    `;

    document.body.appendChild(toast);

    // Auto-dismiss after 6 seconds
    setTimeout(() => {
      if (toast.parentElement) {
        toast.style.animation = 'slideOutRight 0.3s ease-in forwards';
        setTimeout(() => toast.remove(), 300);
      }
    }, 6000);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str || '');
    return div.innerHTML;
  }

  // ── Inject toast animations if not present ──
  function injectStyles() {
    if (document.getElementById('fcm-toast-styles')) return;
    const style = document.createElement('style');
    style.id = 'fcm-toast-styles';
    style.textContent = `
      @keyframes slideInRight {
        from { transform: translateX(120%); opacity: 0; }
        to   { transform: translateX(0);     opacity: 1; }
      }
      @keyframes slideOutRight {
        from { transform: translateX(0);     opacity: 1; }
        to   { transform: translateX(120%); opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  // ── Register Service Worker ──
  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      console.warn('[FCM] Service workers not supported in this browser.');
      return null;
    }

    try {
      const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
      console.log('[FCM] Service Worker registered:', registration.scope);
      return registration;
    } catch (err) {
      console.error('[FCM] Service Worker registration failed:', err);
      return null;
    }
  }

  // Load Firebase app + messaging SDK only when config is real (avoids ~CDN hit + API_KEY_INVALID on placeholders).
  function loadFirebaseSdk() {
    return new Promise((resolve, reject) => {
      if (typeof firebase !== 'undefined' && firebase.messaging) {
        resolve();
        return;
      }
      const appScript = document.createElement('script');
      appScript.src = 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js';
      appScript.onload = function () {
        const msgScript = document.createElement('script');
        msgScript.src = 'https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js';
        msgScript.onload = () => resolve();
        msgScript.onerror = () => reject(new Error('firebase-messaging-compat failed to load'));
        document.head.appendChild(msgScript);
      };
      appScript.onerror = () => reject(new Error('firebase-app-compat failed to load'));
      document.head.appendChild(appScript);
    });
  }

  // ── Initialize Firebase Messaging ──
  async function initMessaging() {
    if (!CONFIGURED) return false;
    injectStyles();

    try {
      await loadFirebaseSdk();
      if (typeof firebase === 'undefined') {
        console.warn('[FCM] Firebase SDK not loaded. Skipping messaging initialization.');
        return false;
      }

      firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
      messaging = firebase.messaging();
      console.log('[FCM] Firebase Messaging initialized.');

      // Register service worker for background messages
      // SDK v9+ (compat 10.x) removed messaging.useServiceWorker(); the
      // registration is passed to getToken() instead.
      swRegistration = await registerServiceWorker();
      if (swRegistration && typeof messaging.useServiceWorker === 'function') {
        messaging.useServiceWorker(swRegistration);
      }

      // Handle foreground messages
      messaging.onMessage((payload) => {
        console.log('[FCM] Foreground message received:', payload);
        const { notification = {}, data = {} } = payload;
        showToast(
          notification.title || data.title || 'Coyote\'s Dune Delivery',
          notification.body || data.body || 'You have a new notification.',
          notification.icon || data.icon || '/assets/icon-192.png'
        );
      });

      return true;
    } catch (err) {
      console.error('[FCM] Failed to initialize Firebase Messaging:', err);
      return false;
    }
  }

  // ── Request Permission & Get Token ──
  async function getFCMToken() {
    if (!messaging) {
      console.warn('[FCM] Messaging not initialized. Call initMessaging() first.');
      return null;
    }

    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        console.warn('[FCM] Notification permission denied.');
        return null;
      }

      const opts = { vapidKey: VAPID_KEY };
      if (swRegistration) opts.serviceWorkerRegistration = swRegistration;
      currentToken = await messaging.getToken(opts);

      if (currentToken) {
        console.log('[FCM] FCM Token obtained:', currentToken.substring(0, 20) + '...');
        // Store token locally
        localStorage.setItem('fcm_token', currentToken);
        return currentToken;
      } else {
        console.warn('[FCM] No registration token available.');
        return null;
      }
    } catch (err) {
      console.error('[FCM] Error getting token:', err);
      return null;
    }
  }

  // ── Delete Token (e.g., on logout) ──
  async function deleteFCMToken() {
    if (!messaging) return false;
    try {
      await messaging.deleteToken();
      localStorage.removeItem('fcm_token');
      currentToken = null;
      console.log('[FCM] Token deleted.');
      return true;
    } catch (err) {
      console.error('[FCM] Error deleting token:', err);
      return false;
    }
  }

  // ── Subscribe to topic (server-side via function) ──
  async function subscribeToTopic(topic) {
    const token = currentToken || localStorage.getItem('fcm_token');
    if (!token) {
      console.warn('[FCM] No token available to subscribe to topic:', topic);
      return false;
    }
    try {
      const res = await fetch('/api/send-push-notification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'subscribe_topic',
          fcm_token: token,
          topic: topic,
        }),
      });
      return res.ok;
    } catch (err) {
      console.error('[FCM] Topic subscription failed:', err);
      return false;
    }
  }

  // ── Expose to global scope ──
  window.CoyoteFCM = {
    init: initMessaging,
    getToken: getFCMToken,
    deleteToken: deleteFCMToken,
    subscribeToTopic: subscribeToTopic,
    getCurrentToken: () => currentToken || localStorage.getItem('fcm_token'),
  };

  // Auto-init on DOM ready only when configured (SDK is loaded by initMessaging).
  const autoInit = () => { if (CONFIGURED) initMessaging(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoInit);
  else autoInit();
})();
