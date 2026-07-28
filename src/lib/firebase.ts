import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import {
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  type Firestore,
} from "firebase/firestore";
import { getAnalytics, isSupported, type Analytics } from "firebase/analytics";

export const firebaseConfig = {
  apiKey:
    (import.meta.env.VITE_FIREBASE_API_KEY as string | undefined) ||
    "AIzaSyB9AGWeDsY3qEzFQaoZvIK9vDAkExpIXpY",
  authDomain:
    (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined) ||
    "runner-man-634be.firebaseapp.com",
  projectId: (import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined) || "runner-man-634be",
  storageBucket:
    (import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined) ||
    "runner-man-634be.firebasestorage.app",
  messagingSenderId:
    (import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined) || "774588838877",
  appId:
    (import.meta.env.VITE_FIREBASE_APP_ID as string | undefined) ||
    "1:774588838877:web:88e120fb3fc6a54be47c34",
  measurementId:
    (import.meta.env.VITE_FIREBASE_MEASUREMENT_ID as string | undefined) || "G-3YBRHT0S8J",
};

export const firebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.authDomain &&
  firebaseConfig.projectId &&
  firebaseConfig.appId,
);

let app: FirebaseApp | null = null;
let _auth: Auth | null = null;
let _db: Firestore | null = null;
let _analytics: Analytics | null = null;

export function getApp(): FirebaseApp {
  if (!firebaseConfigured) {
    throw new Error("Firebase is not configured. Add VITE_FIREBASE_* env vars.");
  }
  if (!app) {
    app = getApps()[0] ?? initializeApp(firebaseConfig);
  }
  return app;
}

export function auth(): Auth {
  if (!_auth) _auth = getAuth(getApp());
  return _auth;
}

export function db(): Firestore {
  if (!_db) {
    const firebaseApp = getApp();
    try {
      _db = initializeFirestore(firebaseApp, {
        localCache: memoryLocalCache(),
      });
    } catch {
      _db = getFirestore(firebaseApp);
    }
  }
  return _db;
}

export async function analytics(): Promise<Analytics | null> {
  if (typeof window === "undefined") return null;
  if (!_analytics && (await isSupported())) {
    _analytics = getAnalytics(getApp());
  }
  return _analytics;
}

// Safely initialize analytics in browser environment if supported
if (typeof window !== "undefined" && firebaseConfigured) {
  isSupported()
    .then((supported) => {
      if (supported && !_analytics) {
        _analytics = getAnalytics(getApp());
      }
    })
    .catch(() => {
      // Ignore error if analytics is not supported in environment
    });
}
