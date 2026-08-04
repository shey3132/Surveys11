const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

// Same service account JSON as before, provided via env var.
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.warn(
    'WARNING: FIREBASE_SERVICE_ACCOUNT is not set. Paste the full JSON content of your ' +
    'Firebase service account key into this environment variable.'
  );
}

// Realtime Database (unlike Firestore) needs to know exactly which database URL
// to talk to — set this to your project's RTDB URL (Firebase Console → Build →
// Realtime Database → shown at the top, looks like
// https://YOUR-PROJECT-default-rtdb.REGION.firebasedatabase.app).
if (!process.env.FIREBASE_DATABASE_URL) {
  console.warn(
    'WARNING: FIREBASE_DATABASE_URL is not set. Copy it from Firebase Console → ' +
    'Realtime Database, and set it as an environment variable.'
  );
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
} catch (err) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON — paste the key file content exactly as downloaded.');
}

const app = initializeApp({
  credential: cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = getDatabase(app);

// Realtime Database push IDs (db.ref('x').push().key) are Firebase's own
// chronologically-sortable unique ID generator — the direct equivalent of
// Firestore's db.collection('x').doc().id used throughout the old code.
function newId(refPath) {
  return db.ref(refPath).push().key;
}

module.exports = { db, newId };
