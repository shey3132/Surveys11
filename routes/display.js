const express = require('express');
const { db } = require('../db');
const { buildResults, getQuestionsWithOptions } = require('./admin');

const router = express.Router();

// GET /display/status
// Poll this every ~2s from the main screen.
router.get('/status', async (req, res) => {
  const activeIdSnap = await db.ref('meta/activeSurveyId').get();
  const activeId = activeIdSnap.val();

  let survey = null;
  if (activeId) {
    const snap = await db.ref(`surveys/${activeId}`).get();
    if (snap.exists()) survey = { id: activeId, ...snap.val() };
  } else {
    // No active survey — show the most recently closed one, if any.
    const allSnap = await db.ref('surveys').get();
    const val = allSnap.val() || {};
    const closed = Object.entries(val)
      .map(([id, data]) => ({ id, ...data }))
      .filter(s => s.status === 'closed')
      .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
    survey = closed[0] || null;
  }

  // If the admin hit "נקה מסך" after this survey closed, show idle instead of
  // its results — but a survey closed *after* that clear still shows normally.
  if (survey && survey.status === 'closed') {
    const clearedSnap = await db.ref('meta/display/clearedAt').get();
    const clearedAt = clearedSnap.val() || 0;
    if (clearedAt >= (survey.closedAt || 0)) {
      survey = null;
    }
  }

  if (!survey) {
    return res.json({ status: 'idle' });
  }

  if (survey.status === 'active') {
    const surveyType = survey.type === 'contest' ? 'contest' : 'regular';
    const questions = await getQuestionsWithOptions(survey.id);
    const firstQuestion = questions[0];
    const respSnap = await db.ref(`responses/${survey.id}`).get();
    const responseCount = respSnap.exists() ? Object.keys(respSnap.val()).length : 0;

    return res.json({
      status: 'active',
      survey_type: surveyType,
      survey_title: survey.title,
      question: firstQuestion ? firstQuestion.text : null,
      options: firstQuestion ? firstQuestion.options : [],
      response_count: responseCount
    });
  }

  // closed
  const results = await buildResults(survey.id, { cacheable: true });
  const surveyType = survey.type === 'contest' ? 'contest' : 'regular';

  return res.json({
    status: 'closed',
    survey_type: surveyType,
    survey_title: survey.title,
    results
  });
});

module.exports = router;
