const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// The service account key (downloaded from Firebase Console → Project Settings →
// Service Accounts → Generate new private key) needs to be provided as an
// environment variable containing the full JSON content, so it works the same
// way locally (via a .env file) and on Render (via an Environment Variable) —
// no file to keep track of or accidentally commit to git.
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.warn(
    'WARNING: FIREBASE_SERVICE_ACCOUNT is not set. Paste the full JSON content of your ' +
    'Firebase service account key into this environment variable.'
  );
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
} catch (err) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON — paste the key file content exactly as downloaded.');
}

const app = initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore(app);

module.exports = { db, FieldValue };
