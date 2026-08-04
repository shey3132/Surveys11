const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const { db, newId } = require('../db');
const { ServerValue } = require('firebase-admin/database');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Normalize a phone number: keep digits only (strip spaces, dashes, +972 etc. left as-is for now)
function normalizePhone(raw) {
  const digits = String(raw).trim().replace(/[^\d]/g, '');
  // Spreadsheet tools (especially CSV, which has no per-cell text formatting)
  // often treat a phone number like "0527673132" as a plain number and silently
  // drop the leading zero. That single missing digit means real callers — whose
  // caller ID always arrives with the leading 0 — would never match anyone in an
  // uploaded list. Restoring it here fixes the problem at the source, regardless
  // of whether it came from a .csv, a .xlsx with unformatted cells, or elsewhere.
  // Covers both cases this produces:
  //   10-digit mobile (05X-XXXXXXX) → stripped to 9 digits, e.g. 527673132
  //   9-digit landline (0X-XXXXXXX) → stripped to 8 digits, e.g. 29998481
  if ((digits.length === 9 || digits.length === 8) && !digits.startsWith('0')) {
    return '0' + digits;
  }
  return digits;
}

// RTDB timestamps (ServerValue.TIMESTAMP) come back as plain millisecond numbers.
function tsToIso(ts) {
  return ts ? new Date(ts).toISOString() : null;
}

// ---------- Active survey cache ----------
// A survey's questions/options never change once it's active (editing is only
// allowed in 'draft'), so re-fetching them on every single IVR call is pure
// waste. Cached in memory, invalidated only when a survey is activated or closed.
let activeSurveyCache = null; // { id, type, questions } | null

function invalidateActiveSurveyCache() {
  activeSurveyCache = null;
}

async function getActiveSurveyCached() {
  if (activeSurveyCache) return activeSurveyCache;
  const idSnap = await db.ref('meta/activeSurveyId').get();
  const activeId = idSnap.val();
  if (!activeId) return null;
  const snap = await db.ref(`surveys/${activeId}`).get();
  if (!snap.exists()) return null;
  const data = snap.val();
  if (data.status !== 'active') return null; // stale pointer safety check
  activeSurveyCache = {
    id: activeId,
    type: data.type === 'contest' ? 'contest' : 'regular',
    questions: parseQuestions(data.questions, activeId)
  };
  return activeSurveyCache;
}

// ---------- Closed-survey results cache ----------
// Once a survey is closed, its responses are frozen forever, so it's safe to
// compute results exactly once and reuse them, instead of re-reading every
// response on every single display-screen poll (every 2 seconds).
const closedResultsCache = {};

// ---------- USERS ----------

// POST /admin/users/upload  (multipart/form-data, field name "file")
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
    // same cascade behavior as before.
    await db.ref('users').remove();
    await db.ref('responses').remove();

    const updates = {};
    users.forEach(u => {
      updates[`users/${u.phone}/phone`] = u.phone;
      updates[`users/${u.phone}/name`] = u.name || null;
      updates[`users/${u.phone}/createdAt`] = ServerValue.TIMESTAMP;
    });
    await db.ref().update(updates);
  } catch (err) {
    return res.status(500).json({ error: 'שגיאה בשמירת המשתמשים', details: err.message });
  }

  res.json({ ok: true, imported: users.length });
});

router.get('/users', async (req, res) => {
  const snap = await db.ref('users').get();
  const val = snap.val() || {};
  const users = Object.values(val)
    .map(u => ({ phone: u.phone, name: u.name, created_at: tsToIso(u.createdAt) }))
    .sort((a, b) => a.phone.localeCompare(b.phone));
  res.json(users);
});

// ---------- SURVEYS ----------

// Converts the raw nested `questions` object stored under a survey into the
// same sorted-array shape the rest of the app (and the frontend) expects.
function parseQuestions(rawQuestions, surveyId) {
  if (!rawQuestions) return [];
  return Object.entries(rawQuestions)
    .map(([qid, q]) => {
      const options = q.options
        ? Object.entries(q.options)
            .map(([oid, o]) => ({ id: oid, text: o.text, digit: o.digit, sortOrder: o.sortOrder }))
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map(({ sortOrder, ...rest }) => rest)
        : [];
      return { id: qid, survey_id: surveyId, text: q.text, sort_order: q.sortOrder, options, sortOrder: q.sortOrder };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(({ sortOrder, ...rest }) => rest);
}

async function getQuestionsWithOptions(surveyId) {
  const snap = await db.ref(`surveys/${surveyId}/questions`).get();
  return parseQuestions(snap.val(), surveyId);
}

// Writes a full set of questions+options under a survey as one atomic
// multi-path update (used by both create and edit).
async function writeQuestions(surveyId, questions) {
  const updates = {};
  questions.forEach((q, qIdx) => {
    const qid = newId(`surveys/${surveyId}/questions`);
    updates[`surveys/${surveyId}/questions/${qid}/text`] = q.text;
    updates[`surveys/${surveyId}/questions/${qid}/sortOrder`] = qIdx;
    q.options.forEach((optText, oIdx) => {
      const oid = newId(`surveys/${surveyId}/questions/${qid}/options`);
      updates[`surveys/${surveyId}/questions/${qid}/options/${oid}/text`] = optText;
      updates[`surveys/${surveyId}/questions/${qid}/options/${oid}/digit`] = oIdx + 1; // digit = 1-based position
      updates[`surveys/${surveyId}/questions/${qid}/options/${oid}/sortOrder`] = oIdx;
    });
  });
  await db.ref().update(updates);
}

// POST /admin/surveys  { title, description, type, questions: [{ text, options: [text, text, ...] }] }
router.post('/surveys', async (req, res) => {
  const { title, description, questions } = req.body;
  const type = req.body.type === 'contest' ? 'contest' : 'regular';
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
    surveyId = newId('surveys');
    await db.ref(`surveys/${surveyId}`).set({
      title,
      description: description || null,
      type,
      status: 'draft',
      createdAt: ServerValue.TIMESTAMP,
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
  const snap = await db.ref(`surveys/${req.params.id}`).get();
  if (!snap.exists()) return res.status(404).json({ error: 'סקר לא נמצא' });
  const survey = snap.val();
  if (survey.status !== 'draft') {
    return res.status(400).json({ error: 'ניתן לערוך רק סקר במצב draft' });
  }

  const { title, description, questions } = req.body;
  const type = req.body.type === 'contest' ? 'contest' : 'regular';
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'נדרש title ולפחות שאלה אחת (questions)' });
  }
  for (const q of questions) {
    if (q.options && q.options.length > 9) {
      return res.status(400).json({ error: `לשאלה "${q.text}" יש יותר מ-9 אופציות (מקסימום נתמך: 9)` });
    }
  }

  try {
    await db.ref(`surveys/${req.params.id}/title`).set(title);
    await db.ref(`surveys/${req.params.id}/description`).set(description || null);
    await db.ref(`surveys/${req.params.id}/type`).set(type);
    // Simplest correct approach: wipe and recreate questions/options for this survey.
    await db.ref(`surveys/${req.params.id}/questions`).remove();
    await writeQuestions(req.params.id, questions);
  } catch (err) {
    return res.status(500).json({ error: 'שגיאה בעריכת הסקר', details: err.message });
  }

  res.json(await getFullSurvey(req.params.id));
});

router.get('/surveys', async (req, res) => {
  const snap = await db.ref('surveys').get();
  const val = snap.val() || {};
  const surveys = Object.entries(val)
    .map(([id, data]) => ({ id, data }))
    .sort((a, b) => (b.data.createdAt || 0) - (a.data.createdAt || 0))
    .map(({ id, data }) => ({
      id,
      title: data.title,
      description: data.description,
      type: data.type || 'regular',
      status: data.status,
      created_at: tsToIso(data.createdAt),
      activated_at: tsToIso(data.activatedAt),
      closed_at: tsToIso(data.closedAt)
    }));
  res.json(surveys);
});

router.get('/surveys/:id', async (req, res) => {
  const survey = await getFullSurvey(req.params.id);
  if (!survey) return res.status(404).json({ error: 'סקר לא נמצא' });
  res.json(survey);
});

// POST /admin/surveys/:id/activate  - closes any other active survey first
router.post('/surveys/:id/activate', async (req, res) => {
  const snap = await db.ref(`surveys/${req.params.id}`).get();
  if (!snap.exists()) return res.status(404).json({ error: 'סקר לא נמצא' });
  const survey = snap.val();
  if (survey.status === 'closed') {
    return res.status(400).json({ error: 'לא ניתן להפעיל מחדש סקר שנסגר' });
  }

  try {
    const activeIdSnap = await db.ref('meta/activeSurveyId').get();
    const prevActiveId = activeIdSnap.val();
    const updates = {};
    if (prevActiveId && prevActiveId !== req.params.id) {
      updates[`surveys/${prevActiveId}/status`] = 'closed';
      updates[`surveys/${prevActiveId}/closedAt`] = ServerValue.TIMESTAMP;
    }
    updates[`surveys/${req.params.id}/status`] = 'active';
    updates[`surveys/${req.params.id}/activatedAt`] = ServerValue.TIMESTAMP;
    updates['meta/activeSurveyId'] = req.params.id;
    await db.ref().update(updates);
    invalidateActiveSurveyCache();
  } catch (err) {
    return res.status(500).json({ error: 'שגיאה בהפעלת הסקר', details: err.message });
  }

  res.json(await getFullSurvey(req.params.id));
});

// POST /admin/surveys/:id/close
router.post('/surveys/:id/close', async (req, res) => {
  const snap = await db.ref(`surveys/${req.params.id}`).get();
  if (!snap.exists()) return res.status(404).json({ error: 'סקר לא נמצא' });

  try {
    const updates = {
      [`surveys/${req.params.id}/status`]: 'closed',
      [`surveys/${req.params.id}/closedAt`]: ServerValue.TIMESTAMP
    };
    const activeIdSnap = await db.ref('meta/activeSurveyId').get();
    if (activeIdSnap.val() === req.params.id) {
      updates['meta/activeSurveyId'] = null;
    }
    await db.ref().update(updates);
    invalidateActiveSurveyCache();
  } catch (err) {
    return res.status(500).json({ error: 'שגיאה בסגירת הסקר', details: err.message });
  }

  res.json(await getFullSurvey(req.params.id));
});

// ---------- DISPLAY SCREEN ----------

// POST /admin/display/clear
router.post('/display/clear', async (req, res) => {
  await db.ref('meta/display/clearedAt').set(ServerValue.TIMESTAMP);
  res.json({ ok: true });
});

// GET /admin/surveys/:id/results  - counts/percentages only
router.get('/surveys/:id/results', async (req, res) => {
  const snap = await db.ref(`surveys/${req.params.id}`).get();
  if (!snap.exists()) return res.status(404).json({ error: 'סקר לא נמצא' });
  const survey = snap.val();

  res.json({
    survey_id: req.params.id,
    title: survey.title,
    status: survey.status,
    questions: await buildResults(req.params.id, { cacheable: survey.status === 'closed' })
  });
});

// ---------- helpers (also used by ivr.js / display.js) ----------

async function getFullSurvey(surveyId) {
  const snap = await db.ref(`surveys/${surveyId}`).get();
  if (!snap.exists()) return null;
  const data = snap.val();
  return {
    id: surveyId,
    title: data.title,
    description: data.description,
    type: data.type || 'regular',
    status: data.status,
    created_at: tsToIso(data.createdAt),
    activated_at: tsToIso(data.activatedAt),
    closed_at: tsToIso(data.closedAt),
    questions: parseQuestions(data.questions, surveyId)
  };
}

async function buildResults(surveyId, options = {}) {
  const { cacheable = false } = options;
  if (cacheable && closedResultsCache[surveyId]) {
    return closedResultsCache[surveyId];
  }

  const [questionsSnap, responsesSnap] = await Promise.all([
    db.ref(`surveys/${surveyId}/questions`).get(),
    db.ref(`responses/${surveyId}`).get()
  ]);
  const questions = parseQuestions(questionsSnap.val(), surveyId);
  const responsesVal = responsesSnap.val() || {};
  const totalResponses = Object.keys(responsesVal).length;

  const countByOption = {};
  Object.values(responsesVal).forEach(r => {
    (r.answers || []).forEach(a => {
      countByOption[a.optionId] = (countByOption[a.optionId] || 0) + 1;
    });
  });

  const results = questions.map(q => ({
    question: q.text,
    options: q.options.map(o => {
      const count = countByOption[o.id] || 0;
      const percent = totalResponses > 0 ? Math.round((count / totalResponses) * 100) : 0;
      return { text: o.text, count, percent };
    })
  }));

  if (cacheable) closedResultsCache[surveyId] = results;
  return results;
}

module.exports = { router, getFullSurvey, buildResults, getQuestionsWithOptions, normalizePhone, getActiveSurveyCached };
