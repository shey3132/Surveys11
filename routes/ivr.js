const express = require('express');
const { db } = require('../db');
const { ServerValue } = require('firebase-admin/database');
const { normalizePhone, getActiveSurveyCached } = require('./admin');

const router = express.Router();

// Yemot's read=/id_list_message= commands are parsed by splitting on '.', '-', '=', ',', '&'.
// Any of those characters inside the spoken text corrupts the command — strip
// them all so anything an admin types into the survey builder is safe to speak.
function sanitizeForSpeech(text) {
  return String(text)
    .replace(/[.\-=,&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildReadCommand(text, varName) {
  const safeText = sanitizeForSpeech(text);
  // read=t-<text>=<var>,yes,<max>,<min>,<timeout>,Number,<readback>,<confirm>
  return `read=t-${safeText}=${varName},yes,1,1,7,Number,yes,yes`;
}

function buildMessage(text) {
  // Plays a message (TTS), then sends the caller back to the main menu.
  return `id_list_message=t-${sanitizeForSpeech(text)}&go_to_folder=/`;
}

function answerVarName(questionId) {
  return `ans_${questionId}`;
}

function buildQuestionPrompt(question, surveyType) {
  if (surveyType === 'contest') {
    const optionsText = question.options
      .map(o => `להצבעה ל${o.text} הקישו ${o.digit}`)
      .join(' ');
    return `${question.text} מי המנצח לדעתכם ${optionsText}`;
  }
  const optionsText = question.options
    .map(o => `לבחירת ${o.text} הקישו ${o.digit}`)
    .join(' ');
  return `${question.text} האפשרויות הן ${optionsText}`;
}

router.all('/survey', async (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');

  try {
    const params = { ...req.query, ...req.body };
    const callId = params.ApiCallId;
    const rawPhone = params.ApiPhone;

    if (!callId || !rawPhone) {
      return res.send(buildMessage('אירעה שגיאה טכנית נסו שוב מאוחר יותר'));
    }

    const phone = normalizePhone(rawPhone);

    // Active survey (structure) comes from an in-memory cache — it can't change
    // while a survey is active. Only the user lookup genuinely needs a fresh read.
    const [activeSurvey, userSnap] = await Promise.all([
      getActiveSurveyCached(),
      db.ref(`users/${phone}`).get()
    ]);

    if (!activeSurvey) {
      return res.send(buildMessage('אין כרגע סקר פעיל תודה'));
    }
    const { id: surveyId, type: surveyType, questions } = activeSurvey;

    if (!userSnap.exists()) {
      return res.send(buildMessage('אינך רשום למענה לסקר זה'));
    }

    const responseRef = db.ref(`responses/${surveyId}/${phone}`);
    const existingSnap = await responseRef.get();
    if (existingSnap.exists()) {
      return res.send(buildMessage('כבר ענית על סקר זה תודה'));
    }

    const nextQuestion = questions.find(q => {
      const val = params[answerVarName(q.id)];
      return val === undefined || val === '' || val === null;
    });

    if (nextQuestion) {
      return res.send(buildReadCommand(buildQuestionPrompt(nextQuestion, surveyType), answerVarName(nextQuestion.id)));
    }

    // All questions answered -> validate digits, save, and finish.
    const answerPairs = [];
    for (const q of questions) {
      const digit = parseInt(params[answerVarName(q.id)], 10);
      const option = q.options.find(o => o.digit === digit);
      if (!option) {
        return res.send(buildReadCommand(buildQuestionPrompt(q, surveyType), answerVarName(q.id)));
      }
      answerPairs.push({ questionId: q.id, optionId: option.id });
    }

    // RTDB transaction: the update callback only "wins" if the value is still
    // null at commit time. If two requests for the same call race each other,
    // only one commits — the exact same guarantee Firestore's .create() gave us,
    // just via RTDB's native mechanism for it.
    let committed = false;
    try {
      const txResult = await responseRef.transaction(current => {
        if (current !== null) return; // abort — someone already wrote this
        return {
          surveyId,
          userPhone: phone,
          submittedAt: ServerValue.TIMESTAMP,
          answers: answerPairs
        };
      });
      committed = txResult.committed;
    } catch (err) {
      committed = false;
    }

    if (!committed) {
      // Duplicate submission race — treat as already answered.
      return res.send(buildMessage('כבר ענית על סקר זה תודה'));
    }

    return res.send(buildMessage(
      surveyType === 'contest'
        ? 'תודה ההצבעה שלך נספרה בהצלחה'
        : 'תודה תשובתך נקלטה ונשמרה במערכת בהצלחה'
    ));
  } catch (err) {
    console.error('IVR /survey unexpected error:', err);
    return res.send(buildMessage('אירעה שגיאה טכנית נסו שוב מאוחר יותר'));
  }
});

module.exports = router;
