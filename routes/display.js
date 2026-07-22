const express = require('express');
const { db } = require('../db');
const { buildResults, getQuestionsWithOptions } = require('./admin');

const router = express.Router();

// GET /display/status
// Poll this every ~2s from the main screen.
router.get('/status', async (req, res) => {
  // Two separate simple equality queries (rather than one status-in query with an
  // orderBy) — this keeps every query here a single-field filter, which Firestore
  // always indexes automatically, so nothing here can ever hit a missing-composite-
  // index error in production.
  const activeSnap = await db.collection('surveys').where('status', '==', 'active').limit(1).get();

  let survey = null;
  if (!activeSnap.empty) {
    survey = { id: activeSnap.docs[0].id, ...activeSnap.docs[0].data() };
  } else {
    const closedSnap = await db.collection('surveys').where('status', '==', 'closed').get();
    if (!closedSnap.empty) {
      // Small number of surveys expected — sorting in memory avoids needing a
      // composite index for "where status == closed order by closedAt desc".
      const docs = closedSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => {
          const at = a.closedAt && a.closedAt.toMillis ? a.closedAt.toMillis() : 0;
          const bt = b.closedAt && b.closedAt.toMillis ? b.closedAt.toMillis() : 0;
          return bt - at;
        });
      survey = docs[0];
    }
  }

  // If the admin hit "נקה מסך" after this survey closed, show idle instead of
  // its results — but a survey closed *after* that clear still shows normally,
  // so this never masks a genuinely new result.
  if (survey && survey.status === 'closed') {
    const metaDoc = await db.collection('meta').doc('display').get();
    if (metaDoc.exists) {
      const clearedAt = metaDoc.data().clearedAt;
      const clearedMs = clearedAt && clearedAt.toMillis ? clearedAt.toMillis() : 0;
      const closedMs = survey.closedAt && survey.closedAt.toMillis ? survey.closedAt.toMillis() : 0;
      if (clearedMs >= closedMs) {
        survey = null;
      }
    }
  }

  if (!survey) {
    return res.json({ status: 'idle' });
  }

  if (survey.status === 'active') {
    const questions = await getQuestionsWithOptions(survey.id);
    // For a single-screen live view we show the first question + live response count.
    // (Survey currently supports one screen state; extend here if you want per-question live view.)
    const firstQuestion = questions[0];
    const responsesSnap = await db.collection('responses').where('surveyId', '==', survey.id).get();

    return res.json({
      status: 'active',
      survey_title: survey.title,
      question: firstQuestion ? firstQuestion.text : null,
      options: firstQuestion ? firstQuestion.options : [],
      response_count: responsesSnap.size
    });
  }

  // closed
  return res.json({
    status: 'closed',
    survey_title: survey.title,
    results: await buildResults(survey.id)
  });
});

module.exports = router;
