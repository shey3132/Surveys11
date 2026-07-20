const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const db = require('../db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Normalize a phone number: keep digits only (strip spaces, dashes, +972 etc. left as-is for now)
function normalizePhone(raw) {
  return String(raw).trim().replace(/[^\d]/g, '');
}

// ---------- USERS ----------

// POST /admin/users/upload  (multipart/form-data, field name "file")
// Expects an Excel file with columns: phone, name (header names are case-insensitive)
router.post('/users/upload', upload.single('file'), (req, res) => {
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

  const replaceAll = db.transaction((list) => {
    db.prepare('DELETE FROM users').run();
    const insert = db.prepare('INSERT INTO users (phone, name) VALUES (?, ?)');
    for (const u of list) insert.run(u.phone, u.name || null);
  });
  replaceAll(users);

  res.json({ ok: true, imported: users.length });
});

router.get('/users', (req, res) => {
  const users = db.prepare('SELECT id, phone, name, created_at FROM users ORDER BY id').all();
  res.json(users);
});

// ---------- SURVEYS ----------

// POST /admin/surveys  { title, description, questions: [{ text, options: [text, text, ...] }] }
router.post('/surveys', (req, res) => {
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

  const createSurvey = db.transaction(() => {
    const surveyInfo = db.prepare(
      'INSERT INTO surveys (title, description, status) VALUES (?, ?, \'draft\')'
    ).run(title, description || null);
    const surveyId = surveyInfo.lastInsertRowid;

    const insertQuestion = db.prepare(
      'INSERT INTO questions (survey_id, text, sort_order) VALUES (?, ?, ?)'
    );
    const insertOption = db.prepare(
      'INSERT INTO options (question_id, text, digit, sort_order) VALUES (?, ?, ?, ?)'
    );

    questions.forEach((q, qIdx) => {
      const qInfo = insertQuestion.run(surveyId, q.text, qIdx);
      const questionId = qInfo.lastInsertRowid;
      q.options.forEach((optText, oIdx) => {
        insertOption.run(questionId, optText, oIdx + 1, oIdx); // digit = 1-based position
      });
    });

    return surveyId;
  });

  const surveyId = createSurvey();
  res.status(201).json(getFullSurvey(surveyId));
});

// PUT /admin/surveys/:id  - only allowed while status = draft. Same body shape as POST.
router.put('/surveys/:id', (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'סקר לא נמצא' });
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

  const updateSurvey = db.transaction(() => {
    db.prepare('UPDATE surveys SET title = ?, description = ? WHERE id = ?')
      .run(title, description || null, survey.id);

    // Simplest correct approach: wipe and recreate questions/options for this survey.
    db.prepare('DELETE FROM questions WHERE survey_id = ?').run(survey.id); // cascades to options

    const insertQuestion = db.prepare(
      'INSERT INTO questions (survey_id, text, sort_order) VALUES (?, ?, ?)'
    );
    const insertOption = db.prepare(
      'INSERT INTO options (question_id, text, digit, sort_order) VALUES (?, ?, ?, ?)'
    );
    questions.forEach((q, qIdx) => {
      const qInfo = insertQuestion.run(survey.id, q.text, qIdx);
      const questionId = qInfo.lastInsertRowid;
      q.options.forEach((optText, oIdx) => {
        insertOption.run(questionId, optText, oIdx + 1, oIdx);
      });
    });
  });
  updateSurvey();

  res.json(getFullSurvey(survey.id));
});

router.get('/surveys', (req, res) => {
  const surveys = db.prepare('SELECT * FROM surveys ORDER BY id DESC').all();
  res.json(surveys);
});

router.get('/surveys/:id', (req, res) => {
  const survey = getFullSurvey(req.params.id);
  if (!survey) return res.status(404).json({ error: 'סקר לא נמצא' });
  res.json(survey);
});

// POST /admin/surveys/:id/activate  - closes any other active survey first
router.post('/surveys/:id/activate', (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'סקר לא נמצא' });
  if (survey.status === 'closed') {
    return res.status(400).json({ error: 'לא ניתן להפעיל מחדש סקר שנסגר' });
  }

  const activate = db.transaction(() => {
    db.prepare(
      "UPDATE surveys SET status = 'closed', closed_at = datetime('now') WHERE status = 'active' AND id != ?"
    ).run(survey.id);
    db.prepare(
      "UPDATE surveys SET status = 'active', activated_at = datetime('now') WHERE id = ?"
    ).run(survey.id);
  });
  activate();

  res.json(getFullSurvey(survey.id));
});

// POST /admin/surveys/:id/close
router.post('/surveys/:id/close', (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'סקר לא נמצא' });

  db.prepare("UPDATE surveys SET status = 'closed', closed_at = datetime('now') WHERE id = ?")
    .run(survey.id);

  res.json(getFullSurvey(survey.id));
});

// GET /admin/surveys/:id/results  - counts/percentages only
router.get('/surveys/:id/results', (req, res) => {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'סקר לא נמצא' });

  res.json({ survey_id: survey.id, title: survey.title, status: survey.status, questions: buildResults(survey.id) });
});

// ---------- helpers (also used by ivr.js / display.js) ----------

function getFullSurvey(surveyId) {
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(surveyId);
  if (!survey) return null;
  const questions = db.prepare('SELECT * FROM questions WHERE survey_id = ? ORDER BY sort_order').all(surveyId);
  for (const q of questions) {
    q.options = db.prepare('SELECT id, text, digit FROM options WHERE question_id = ? ORDER BY sort_order').all(q.id);
  }
  survey.questions = questions;
  return survey;
}

function buildResults(surveyId) {
  const questions = db.prepare('SELECT * FROM questions WHERE survey_id = ? ORDER BY sort_order').all(surveyId);
  const totalResponses = db.prepare('SELECT COUNT(*) AS c FROM responses WHERE survey_id = ?').get(surveyId).c;

  return questions.map(q => {
    const options = db.prepare('SELECT id, text FROM options WHERE question_id = ? ORDER BY sort_order').all(q.id);
    const counts = db.prepare(
      `SELECT option_id, COUNT(*) AS c FROM answers WHERE question_id = ? GROUP BY option_id`
    ).all(q.id);
    const countMap = Object.fromEntries(counts.map(c => [c.option_id, c.c]));

    return {
      question: q.text,
      options: options.map(o => {
        const count = countMap[o.id] || 0;
        const percent = totalResponses > 0 ? Math.round((count / totalResponses) * 100) : 0;
        return { text: o.text, count, percent };
      })
    };
  });
}

module.exports = { router, getFullSurvey, buildResults, normalizePhone };
