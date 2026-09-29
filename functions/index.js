/* The team-key gate. Verifies the shared passphrase and mints a Firebase
   custom token — so Firestore/Storage rules can simply require auth.
   Set the key once with:  firebase functions:secrets:set TEAM_KEY  */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('node:crypto');

admin.initializeApp();
const TEAM_KEY = defineSecret('TEAM_KEY');

exports.unlock = onCall({ secrets: [TEAM_KEY], cors: true }, async (req) => {
  const expect = TEAM_KEY.value() || '';
  const got = String(req.data && req.data.key || '');
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(expect).digest();
  if (!expect || !crypto.timingSafeEqual(a, b)) {
    throw new HttpsError('permission-denied', 'wrong key');
  }
  // One shared identity for the whole team — auth == "knows the key".
  const uid = 'team-' + crypto.createHash('sha256').update(expect).digest('hex').slice(0, 16);
  const token = await admin.auth().createCustomToken(uid);
  return { token };
});
