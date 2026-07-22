const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const { db, FieldValue } = require('../db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Normalize a phone number: keep digits only (strip spaces, dashes, +972 etc. left as-is for now)
function normalizePhone(raw) {
  return String(raw).trim().replace(/[^\d]/g, '');
}

// Firestore Timestamps don't serialize to plain JSON nicely — convert to ISO
// strings (matching what the frontend already expects) wherever we send one out.
function tsToIso(ts) {
  return ts && typeof ts.toDate === 'function' ? ts.toDate().toISOString() : null;
}

// Deletes every document in a top-level collection (no subcollections),
// in batches of 500 (Firestore's per-batch write limit).
async function deleteAllDocs(collectionRef) {
  const snap = await collectionRef.get();
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 500) {
    const batch = db.batch();
    docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
}

// ---------- USERS ----------

// POST /admin/users/upload  (multipart/form-data, field name "file")
// Expects an Excel file with columns: phone, name (header names are case-insensitive)
router.post('/users/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא הועלה קובץ (שדה "file")' });

  let rows;
  try {
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
  } catch (err) {
    return res.status(400).json({ error: 'קובץ אקסל לא תקין', details: err.message });
  }

  const users = rows
    .map(r => {
      const keys = Object.keys(r);
      const phoneKey = keys.find(k => k.toLowerCase().trim() === 'phone' || k.trim() === 'טלפון');
      const nameKey = keys.find(k => k.toLowerCase().trim() === 'name' || k.trim() === 'שם');
      const phone = phoneKey ? normalizePhone(r[phoneKey]) : '';
      const name = nameKey ? String(r[nameKey]).trim() : '';
      return { phone, name };
    })
    .filter(u => u.phone.length > 0);

  if (users.length === 0) {
    return res.status(400).json({ error: 'לא נמצאו שורות תקינות. ודא שיש עמודה בשם "phone" או "טלפון".' });
  }

  try {
    // Replacing the user list wipes any responses tied to the old users too —
    // same cascade behavior as before (a response with no valid user makes no sense).
    await deleteAllDocs(db.collection('users'));
    await deleteAllDocs(db.collection('responses'));

    for (let i = 0; i < users.length; i += 500) {
      const batch = db.batch();
      users.slice(i, i + 500).forEach(u => {
        // Document ID = phone number itself. This both gives us free O(1) lookup
        // by phone (exactly what the IVR endpoint needs on every call) and makes
        // "phone" naturally unique — two rows with the same number simply overwrite
        // each other instead of creating duplicates.
        const ref = db.collection('users').doc(u.phone);
        batch.set(ref, {
          phone: u.phone,
          name: u.name || null,
          createdAt: FieldValue.serverTimestamp()
        });
      });
      await batch.commit();
    }
  } catch (err) {
    return res.status(500).json({ error: 'שגיאה בשמירת המשתמשים', details: err.message });
  }

  res.json({ ok: true, imported: users.length });
});

router.get('/users', async (req, res) => {
  const snap = await db.collection('users').orderBy('phone').get();
  const users = snap.docs.map(d => {
    const data = d.data();
    return { id: d.id, phone: data.phone, name: data.name, created_at: tsToIso(data.createdAt) };
  });
  res.json(users);
});

// ---------- SURVEYS ----------

// Fetches a survey's questions (ordered) with each question's options (ordered) nested in.
async function getQuestionsWithOptions(surveyId) {
  const qSnap = await db.collection('surveys').doc(surveyId).collection('questions')
    .orderBy('sortOrder').get();

  const questions = [];
  for (const qDoc of qSnap.docs) {
    const qData = qDoc.data();
    const oSnap = await qDoc.ref.collection('options').orderBy('sortOrder').get();
    const options = oSnap.docs.map(oDoc => {
      const oData = oDoc.data();
      return { id: oDoc.id, text: oData.text, digit: oData.digit };
    });
    questions.push({ id: qDoc.id, survey_id: surveyId, text: qData.text, sort_order: qData.sortOrder, options });
  }
  return questions;
}

// Writes a full set of questions+options under a survey (used by both create and edit).
async function writeQuestions(surveyId, questions) {
  const surveyRef = db.collection('surveys').doc(surveyId);
  const batch = db.batch();
  questions.forEach((q, qIdx) => {
    const qRef = surveyRef.collection('questions').doc();
    batch.set(qRef, { text: q.text, sortOrder: qIdx });
    q.options.forEach((optText, oIdx) => {
      const oRef = qRef.collection('options').doc();
      batch.set(oRef, { text: optText, digit: oIdx + 1, sortOrder: oIdx }); // digit = 1-based position
    });
  });
  await batch.commit();
}

// POST /admin/surveys  { title, description, questions: [{ text, options: [text, text, ...] }] }
router.post('/surveys', async (req, res) => {
  const { title, description, questions } = req.body;
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'נדרש title ולפחות שאלה אחת (questions)' });
  }
  for (const q of questions) {
    if (!q.text || !Array.isArray(q.options) || q.options.length === 0) {
      return res.status(400).json({ error: 'לכל שאלה נדרש text ולפחות אופציה אחת' });
    }
    if (q.options.length > 9) {
      return res.status(400).json({ error: `לשאלה "${q.text}" יש יותר מ-9 אופציות (מקסימום נתמך: 9)` });
    }
  }

  let surveyId;
  try {
    const surveyRef = db.collection('surveys').doc();
    surveyId = surveyRef.id;
    await surveyRef.set({
      title,
      description: description || null,
      status: 'draft',
      createdAt: FieldValue.serverTimestamp(),
      activatedAt: null,
      closedAt: null
    });
    await writeQuestions(surveyId, questions);
  } catch (err) {
    return res.status(500).json({ error: 'שגיאה ביצירת הסקר', details: err.message });
  }

  res.status(201).json(await getFullSurvey(surveyId));
});

// PUT /admin/surveys/:id  - only allowed while status = draft. Same body shape as POST.
router.put('/surveys/:id', async (req, res) => {
  const surveyRef = db.collection('surveys').doc(req.params.id);
  const surveyDoc = await surveyRef.get();
  if (!surveyDoc.exists) return res.status(404).json({ error: 'סקר לא נמצא' });
  const survey = surveyDoc.data();
  if (survey.status !== 'draft') {
    return res.status(400).json({ error: 'ניתן לערוך רק סקר במצב draft' });
  }

  const { title, description, questions } = req.body;
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'נדרש title ולפחות שאלה אחת (questions)' });
  }
  for (const q of questions) {
    if (q.options && q.options.length > 9) {
      return res.status(400).json({ error: `לשאלה "${q.text}" יש יותר מ-9 אופציות (מקסימום נתמך: 9)` });
    }
  }

  try {
    await surveyRef.update({ title, description: description || null });
    // Simplest correct approach: wipe and recreate questions/options for this survey.
    await db.recursiveDelete(surveyRef.collection('questions'));
    await writeQuestions(req.params.id, questions);
  } catch (err) {
    return res.status(500).json({ error: 'שגיאה בעריכת הסקר', details: err.message });
  }

  res.json(await getFullSurvey(req.params.id));
});

router.get('/surveys', async (req, res) => {
  const snap = await db.collection('surveys').orderBy('createdAt', 'desc').get();
  const surveys = snap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      title: data.title,
      description: data.description,
      status: data.status,
      created_at: tsToIso(data.createdAt),
      activated_at: tsToIso(data.activatedAt),
      closed_at: tsToIso(data.closedAt)
    };
  });
  res.json(surveys);
});

router.get('/surveys/:id', async (req, res) => {
  const survey = await getFullSurvey(req.params.id);
  if (!survey) return res.status(404).json({ error: 'סקר לא נמצא' });
  res.json(survey);
});

// POST /admin/surveys/:id/activate  - closes any other active survey first
router.post('/surveys/:id/activate', async (req, res) => {
  const surveyRef = db.collection('surveys').doc(req.params.id);
  const surveyDoc = await surveyRef.get();
  if (!surveyDoc.exists) return res.status(404).json({ error: 'סקר לא נמצא' });
  const survey = surveyDoc.data();
  if (survey.status === 'closed') {
    return res.status(400).json({ error: 'לא ניתן להפעיל מחדש סקר שנסגר' });
  }

  try {
    const activeSnap = await db.collection('surveys').where('status', '==', 'active').get();
    const batch = db.batch();
    activeSnap.docs.forEach(d => {
      if (d.id !== req.params.id) {
        batch.update(d.ref, { status: 'closed', closedAt: FieldValue.serverTimestamp() });
      }
    });
    batch.update(surveyRef, { status: 'active', activatedAt: FieldValue.serverTimestamp() });
    await batch.commit();
  } catch (err) {
    return res.status(500).json({ error: 'שגיאה בהפעלת הסקר', details: err.message });
  }

  res.json(await getFullSurvey(req.params.id));
});

// POST /admin/surveys/:id/close
router.post('/surveys/:id/close', async (req, res) => {
  const surveyRef = db.collection('surveys').doc(req.params.id);
  const surveyDoc = await surveyRef.get();
  if (!surveyDoc.exists) return res.status(404).json({ error: 'סקר לא נמצא' });

  await surveyRef.update({ status: 'closed', closedAt: FieldValue.serverTimestamp() });

  res.json(await getFullSurvey(req.params.id));
});

// ---------- DISPLAY SCREEN ----------

// POST /admin/display/clear
// The display screen shows the most recently closed survey's results by default,
// indefinitely, until a new survey is activated. This lets an admin manually send
// it back to the idle "waiting" screen without needing to touch survey state.
// Implemented as a timestamp rather than a delete: display.js only shows a closed
// survey's results if that survey closed *after* the last clear — so results from
// a survey closed later (even accidentally, e.g. re-closing) still surface normally.
router.post('/display/clear', async (req, res) => {
  await db.collection('meta').doc('display').set({
    clearedAt: FieldValue.serverTimestamp()
  });
  res.json({ ok: true });
});

// GET /admin/surveys/:id/results  - counts/percentages only
router.get('/surveys/:id/results', async (req, res) => {
  const surveyDoc = await db.collection('surveys').doc(req.params.id).get();
  if (!surveyDoc.exists) return res.status(404).json({ error: 'סקר לא נמצא' });
  const survey = surveyDoc.data();

  res.json({
    survey_id: req.params.id,
    title: survey.title,
    status: survey.status,
    questions: await buildResults(req.params.id)
  });
});

// ---------- helpers (also used by ivr.js / display.js) ----------

async function getFullSurvey(surveyId) {
  const surveyDoc = await db.collection('surveys').doc(surveyId).get();
  if (!surveyDoc.exists) return null;
  const data = surveyDoc.data();
  const questions = await getQuestionsWithOptions(surveyId);
  return {
    id: surveyId,
    title: data.title,
    description: data.description,
    status: data.status,
    created_at: tsToIso(data.createdAt),
    activated_at: tsToIso(data.activatedAt),
    closed_at: tsToIso(data.closedAt),
    questions
  };
}

async function buildResults(surveyId) {
  const questions = await getQuestionsWithOptions(surveyId);

  // Small-scale app (single active survey, modest response counts) — reading every
  // response doc for this survey and tallying in memory is simpler and safer than
  // maintaining running counters, and avoids any Firestore composite-index concerns.
  const responsesSnap = await db.collection('responses').where('surveyId', '==', surveyId).get();
  const totalResponses = responsesSnap.size;

  const countByOption = {};
  responsesSnap.docs.forEach(d => {
    const answers = d.data().answers || [];
    answers.forEach(a => {
      countByOption[a.optionId] = (countByOption[a.optionId] || 0) + 1;
    });
  });

  return questions.map(q => ({
    question: q.text,
    options: q.options.map(o => {
      const count = countByOption[o.id] || 0;
      const percent = totalResponses > 0 ? Math.round((count / totalResponses) * 100) : 0;
      return { text: o.text, count, percent };
    })
  }));
}

module.exports = { router, getFullSurvey, buildResults, getQuestionsWithOptions, normalizePhone };
