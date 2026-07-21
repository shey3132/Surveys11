const express = require('express');
const db = require('../db');
const { normalizePhone } = require('./admin');

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
  // Plays a message (TTS) with no further input expected, then ends the call.
  // Confirmed against Yemot's own API docs — id_list_message=t-<text> is a valid,
  // documented "speak and finish" command.
  return `id_list_message=t-${sanitizeForSpeech(text)}`;
}

function answerVarName(questionId) {
  return `ans_${questionId}`;
}

// Builds a clear, first-time-caller-friendly prompt for a question:
// states the question, then reads each option as "לבחירת X הקישו Y" —
// easier to follow on a phone than "הקישו Y לבחירה ב X", especially for
// someone who's never used this system before.
function buildQuestionPrompt(question) {
  const optionsText = question.options
    .map(o => `לבחירת ${o.text} הקישו ${o.digit}`)
    .join(' ');
  return `${question.text} האפשרויות הן ${optionsText}`;
}

router.all('/survey', (req, res) => {
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

    const survey = db.prepare("SELECT * FROM surveys WHERE status = 'active' LIMIT 1").get();
    if (!survey) {
      return res.send(buildMessage('אין כרגע סקר פעיל תודה'));
    }

    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user) {
      return res.send(buildMessage('אינך רשום למענה לסקר זה'));
    }

    const alreadyAnswered = db.prepare(
      'SELECT 1 FROM responses WHERE survey_id = ? AND user_id = ?'
    ).get(survey.id, user.id);
    if (alreadyAnswered) {
      return res.send(buildMessage('כבר ענית על סקר זה תודה'));
    }

    const questions = db.prepare(
      'SELECT * FROM questions WHERE survey_id = ? ORDER BY sort_order'
    ).all(survey.id);
    for (const q of questions) {
      q.options = db.prepare(
        'SELECT id, text, digit FROM options WHERE question_id = ? ORDER BY sort_order'
      ).all(q.id);
    }

    // Find the first question that doesn't yet have an answer in the accumulated params.
    const nextQuestion = questions.find(q => {
      const val = params[answerVarName(q.id)];
      return val === undefined || val === '' || val === null;
    });

    if (nextQuestion) {
      return res.send(buildReadCommand(buildQuestionPrompt(nextQuestion), answerVarName(nextQuestion.id)));
    }

    // All questions answered -> validate digits, save, and finish.
    const answerPairs = [];
    for (const q of questions) {
      const digit = parseInt(params[answerVarName(q.id)], 10);
      const option = q.options.find(o => o.digit === digit);
      if (!option) {
        // Invalid/garbled input somewhere — safest is to ask the question again.
        return res.send(buildReadCommand(buildQuestionPrompt(q), answerVarName(q.id)));
      }
      answerPairs.push({ questionId: q.id, optionId: option.id });
    }

    try {
      const save = db.transaction(() => {
        const info = db.prepare(
          'INSERT INTO responses (survey_id, user_id) VALUES (?, ?)'
        ).run(survey.id, user.id);
        const responseId = info.lastInsertRowid;
        const insertAnswer = db.prepare(
          'INSERT INTO answers (response_id, question_id, option_id) VALUES (?, ?, ?)'
        );
        for (const a of answerPairs) insertAnswer.run(responseId, a.questionId, a.optionId);
      });
      save();
    } catch (err) {
      // UNIQUE(survey_id, user_id) collision = duplicate submission race — treat as already answered.
      return res.send(buildMessage('כבר ענית על סקר זה תודה'));
    }

    return res.send(buildMessage('תודה תשובתך נקלטה ונשמרה במערכת בהצלחה'));
  } catch (err) {
    console.error('IVR /survey unexpected error:', err);
    return res.send(buildMessage('אירעה שגיאה טכנית נסו שוב מאוחר יותר'));
  }
});

module.exports = router;
