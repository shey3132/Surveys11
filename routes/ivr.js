const express = require('express');
const { db, FieldValue } = require('../db');
const { normalizePhone, getActiveSurveyCached } = require('./admin');

const router = express.Router();

// Yemot's read=/id_list_message= commands are parsed by splitting on '.', '-', '=', ',', '&'.
// Any of those characters inside the spoken text corrupts the command:
//  - '.' / '-' / '=' break the `t-...=` segment itself (confirmed cause of "שגיאה").
//  - ',' shifts the comma-delimited parameter list of `read=` (max/min digits, timeout, etc.)
//    out of position — a survey question or option typed with a comma in it will break every
//    call that reaches that question.
//  - '&' is Yemot's command-chaining separator (e.g. `id_list_message=t-...&routing_yemot=...`),
//    so a stray '&' in admin-entered text could be misread as the start of a second command.
// Strip all of them so anything an admin types into the survey builder is always safe to speak.
function sanitizeForSpeech(text) {
  return String(text)
    .replace(/[.\-=,&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildReadCommand(text, varName) {
  const safeText = sanitizeForSpeech(text);
  // read=t-<text>=<var>,yes,<max>,<min>,<timeout>,Number,<readback>,<confirm>
  // confirm=yes: after the caller presses a digit, Yemot automatically asks
  // "לאישור הקישו 1, לשינוי הקישו 2" before moving on — built-in confirmation,
  // no extra code needed on our side.
  return `read=t-${safeText}=${varName},yes,1,1,7,Number,yes,yes`;
}

function buildMessage(text) {
  // Plays a message (TTS), then sends the caller back to the main menu.
  // id_list_message=t-<text> alone leaves Yemot waiting for a next instruction
  // that never arrives, which is what caused the audible "שגיאה" bug — chaining
  // a second instruction with & (Yemot's command-chaining syntax, confirmed via
  // a working real-world example) fixes that. go_to_folder=/ sends the caller to
  // the root of the phone tree (the main menu) instead of just ending the call.
  return `id_list_message=t-${sanitizeForSpeech(text)}&go_to_folder=/`;
}

function answerVarName(questionId) {
  return `ans_${questionId}`;
}

// Builds a clear, first-time-caller-friendly prompt for a question:
// states the question, then reads each option as "לבחירת X הקישו Y" —
// easier to follow on a phone than "הקישו Y לבחירה ב X", especially for
// someone who's never used this system before.
// Contest-type surveys ("who wins") get a livelier, vote-flavored phrasing instead.
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
  // Everything below is wrapped in one try/catch. If ANYTHING throws unexpectedly here
  // (a bad param shape, a DB hiccup, etc.) and we don't catch it, Express falls back to its
  // default error handler — which returns an HTML stack-trace page. Yemot doesn't recognize
  // that as a valid command ("תגובה לא מזוהה") and plays "שגיאה". Catching everything and
  // always responding with a valid id_list_message= keeps every call ending gracefully.
  res.set('Content-Type', 'text/plain; charset=utf-8');

  try {
    const params = { ...req.query, ...req.body };
    const callId = params.ApiCallId;
    const rawPhone = params.ApiPhone;

    if (!callId || !rawPhone) {
      return res.send(buildMessage('אירעה שגיאה טכנית נסו שוב מאוחר יותר'));
    }

    const phone = normalizePhone(rawPhone);

    // Active survey + its questions/options come from an in-memory cache (see
    // admin.js) instead of Firestore — that data can't change while a survey is
    // active, so re-fetching it on every call would just waste the free server's
    // very limited CPU. Only the user lookup genuinely needs a fresh read every time.
    const [activeSurvey, userDoc] = await Promise.all([
      getActiveSurveyCached(),
      db.collection('users').doc(phone).get()
    ]);

    if (!activeSurvey) {
      return res.send(buildMessage('אין כרגע סקר פעיל תודה'));
    }
    const { id: surveyId, type: surveyType, questions } = activeSurvey;

    if (!userDoc.exists) {
      return res.send(buildMessage('אינך רשום למענה לסקר זה'));
    }

    // Document ID = `${surveyId}_${phone}`, so "has this user already answered this
    // survey" is a single direct lookup — no query needed, and it doubles as the
    // exact key we'll atomically create()-guard against below.
    const responseRef = db.collection('responses').doc(`${surveyId}_${phone}`);
    const existingResponse = await responseRef.get();
    if (existingResponse.exists) {
      return res.send(buildMessage('כבר ענית על סקר זה תודה'));
    }

    // Find the first question that doesn't yet have an answer in the accumulated params.
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
        // Invalid/garbled input somewhere — safest is to ask the question again.
        return res.send(buildReadCommand(buildQuestionPrompt(q, surveyType), answerVarName(q.id)));
      }
      answerPairs.push({ questionId: q.id, optionId: option.id });
    }

    try {
      // .create() (as opposed to .set()) fails if the document already exists —
      // this is what actually guarantees "one submission per user per survey" even
      // if two requests for the same call race each other, exactly like the SQL
      // UNIQUE(survey_id, user_id) constraint did in the previous version.
      await responseRef.create({
        surveyId,
        userPhone: phone,
        submittedAt: FieldValue.serverTimestamp(),
        answers: answerPairs
      });
    } catch (err) {
      // ALREADY_EXISTS (duplicate submission race) — treat as already answered.
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
