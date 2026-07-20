const express = require('express');
const db = require('../db');
const { buildResults } = require('./admin');

const router = express.Router();

// GET /display/status
// Poll this every ~2s from the main screen.
router.get('/status', (req, res) => {
  const survey = db.prepare(
    "SELECT * FROM surveys WHERE status IN ('active','closed') ORDER BY activated_at DESC LIMIT 1"
  ).get();

  if (!survey) {
    return res.json({ status: 'idle' });
  }

  if (survey.status === 'active') {
    const questions = db.prepare(
      'SELECT * FROM questions WHERE survey_id = ? ORDER BY sort_order'
    ).all(survey.id);
    // For a single-screen live view we show the first question + live response count.
    // (Survey currently supports one screen state; extend here if you want per-question live view.)
    const firstQuestion = questions[0];
    const options = firstQuestion
      ? db.prepare('SELECT text, digit FROM options WHERE question_id = ? ORDER BY sort_order').all(firstQuestion.id)
      : [];
    const responseCount = db.prepare(
      'SELECT COUNT(*) AS c FROM responses WHERE survey_id = ?'
    ).get(survey.id).c;

    return res.json({
      status: 'active',
      survey_title: survey.title,
      question: firstQuestion ? firstQuestion.text : null,
      options,
      response_count: responseCount
    });
  }

  // closed
  return res.json({
    status: 'closed',
    survey_title: survey.title,
    results: buildResults(survey.id)
  });
});

module.exports = router;
