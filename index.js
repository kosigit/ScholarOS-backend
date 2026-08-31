require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();

// Photos of notes arrive as base64 inside a JSON body, and Express's
// default limit is 100kb — a phone photo is far bigger than that.
app.use(express.json({ limit: '25mb' }));

// Which model reads images. Kept in an env var so it can be swapped
// without a code change when Groq's line-up moves on.
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b';

// This "pool" is our connection to the real Postgres database.
// Every query below goes through this — this is the one thing that changed
// fundamentally: data now lives in Postgres, not in a JS array that resets.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/* ------------------------------------------------------------------
   Make sure the Flashcard table exists.
   Runs once on boot. IF NOT EXISTS means it is safe to run every time
   and does nothing if the table is already there — so nobody has to
   open a database console to add this feature.
   ------------------------------------------------------------------ */
async function ensureTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "Flashcard" (
        id SERIAL PRIMARY KEY,
        "sessionId" INTEGER NOT NULL REFERENCES "Session"(id),
        front TEXT NOT NULL,
        back TEXT NOT NULL
      )
    `);
    // How many questions the student asked for. Existing sessions get 5,
    // which is what they were generated with.
    await pool.query(`
      ALTER TABLE "Session"
      ADD COLUMN IF NOT EXISTS "questionCount" INTEGER NOT NULL DEFAULT 5
    `);
    console.log('Schema ready');
  } catch (err) {
    console.error('Could not prepare schema:', err.message);
  }
}

// Students can ask for more or fewer questions, within reason. Below 3
// a single lucky guess passes you; above 15 the AI starts inventing
// questions the notes cannot actually answer.
const MIN_QUESTIONS = 3;
const MAX_QUESTIONS = 15;
const DEFAULT_QUESTIONS = 5;

function clampQuestionCount(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_QUESTIONS;
  return Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, n));
}

app.get('/', (req, res) => {
  res.send('ScholarOS server is running!');
});

/* ------------------------------------------------------------------
   Shared helper: ask Groq for something and get JSON back.

   Every AI call can fail in the same four ways — no key, network
   error, non-200 response, or a reply that isn't valid JSON. Handling
   that once here means neither route can forget it and leave the
   desktop app hanging forever on a spinner.
   ------------------------------------------------------------------ */
async function callGroq(model, messages) {
  if (!process.env.GROQ_API_KEY) {
    return { ok: false, reason: 'no-key' };
  }

  let response;
  try {
    response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model, messages })
    });
  } catch (err) {
    return { ok: false, reason: 'network', detail: err.message };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { ok: false, reason: 'ai-error', detail: `${response.status} ${body.slice(0, 300)}` };
  }

  const data = await response.json().catch(() => null);
  const raw = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;

  if (!raw) return { ok: false, reason: 'empty' };
  return { ok: true, raw };
}

async function askGroqForJson(prompt) {
  const res = await callGroq(TEXT_MODEL, [{ role: 'user', content: prompt }]);
  if (!res.ok) return res;

  try {
    // Models often wrap JSON in ```json fences even when told not to.
    return { ok: true, value: JSON.parse(res.raw.replace(/```json|```/g, '').trim()) };
  } catch {
    return { ok: false, reason: 'bad-json', detail: res.raw.slice(0, 200) };
  }
}

// Small helper so every route can look a session up the same way.
async function getSession(sessionId) {
  const result = await pool.query(`SELECT * FROM "Session" WHERE id = $1`, [sessionId]);
  return result.rows[0] || null;
}

/* ==================================================================
   Sessions
   ================================================================== */

// Create a new study session.
app.post('/sessions', async (req, res) => {
  try {
    const { subject, notes, durationMin, questionCount } = req.body;

    if (!subject || !notes) {
      return res.status(400).json({ error: 'subject and notes are required' });
    }

    const result = await pool.query(
      `INSERT INTO "Session" (subject, notes, "durationMin", "questionCount", status)
       VALUES ($1, $2, $3, $4, 'ACTIVE')
       RETURNING *`,
      [subject, notes, durationMin || 25, clampQuestionCount(questionCount)]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('POST /sessions failed:', err);
    res.status(500).json({ error: 'Could not create the session' });
  }
});

// List sessions.
app.get('/sessions', async (req, res) => {
  try {
    // Deliberately does NOT return the notes column. Notes are the
    // student's own study material and there is no login yet, so
    // anyone who found this URL could read everybody's work.
    const result = await pool.query(
      `SELECT id, subject, "durationMin", status, "startedAt"
       FROM "Session" ORDER BY id DESC LIMIT 100`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /sessions failed:', err);
    res.status(500).json({ error: 'Could not list sessions' });
  }
});

/* ==================================================================
   Reading notes out of a photo

   A student snaps their handwritten page, or a lecture slide, and we
   turn it into text they can then edit and be quizzed on. The picture
   itself is never stored — only the text comes back, and the student
   sees it before anything else happens with it.
   ================================================================== */

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];

app.post('/extract-image', async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body || {};

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ ok: false, reason: 'no-image' });
    }
    if (!ALLOWED_IMAGE_TYPES.includes(String(mimeType).toLowerCase())) {
      return res.status(400).json({ ok: false, reason: 'bad-type' });
    }
    // Base64 is about 4/3 the size of the raw bytes. Groq rejects
    // anything over 20MB, so stop well short and say why.
    if (imageBase64.length > 14_000_000) {
      return res.status(413).json({ ok: false, reason: 'too-big' });
    }

    const ai = await callGroq(VISION_MODEL, [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Transcribe the study notes in this image into plain text.

Rules:
- Write out everything readable: headings, body text, bullet points, labelled diagrams, equations.
- Keep the original wording. Do not summarise, correct, explain or add anything.
- Keep the structure: headings on their own line, bullets as "- ".
- If a word is genuinely unreadable, write [?] in its place rather than guessing.
- Return only the transcription. No preamble, no commentary.

If the image contains no readable text at all, reply with exactly: NO_TEXT_FOUND`
        },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
      ]
    }]);

    if (!ai.ok) {
      console.error('vision failed:', ai.reason, ai.detail || '');
      return res.status(502).json({ ok: false, reason: ai.reason, detail: ai.detail });
    }

    const text = ai.raw.trim();

    if (text === 'NO_TEXT_FOUND' || text.replace(/\s/g, '').length < 15) {
      return res.json({ ok: false, reason: 'no-text' });
    }

    res.json({ ok: true, text });

  } catch (err) {
    console.error('POST /extract-image failed:', err);
    res.status(500).json({ ok: false, reason: 'server-error' });
  }
});

/* ==================================================================
   Flashcards — study material, shown DURING the session
   ================================================================== */

app.post('/sessions/:id/flashcards', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // If we already built cards for this session, hand back the same
    // ones instead of paying for a second AI call and producing a
    // different deck halfway through someone's studying.
    const existing = await pool.query(
      `SELECT front, back FROM "Flashcard" WHERE "sessionId" = $1 ORDER BY id`,
      [sessionId]
    );
    if (existing.rows.length) {
      return res.json({ flashcards: existing.rows });
    }

    const prompt = `You are making revision flashcards from a student's own study notes on "${session.subject}".

Generate between 6 and 12 flashcards.

Rules:
- Every card must be answerable purely from the notes below. Do not use outside knowledge.
- "front" is a short question or a term. "back" is the answer, one or two sentences.
- Cover the whole set of notes, not just the opening lines.
- Do not repeat the same fact on two different cards.

Return ONLY valid JSON, nothing else: [{"front":"...","back":"..."}]

Notes:
${session.notes}`;

    const ai = await askGroqForJson(prompt);

    if (!ai.ok) {
      console.error('flashcards AI failed:', ai.reason, ai.detail || '');
      // An empty list is a valid answer the app already handles calmly:
      // it says "flashcards not available" and the session carries on.
      return res.json({ flashcards: [], reason: ai.reason });
    }

    const clean = (Array.isArray(ai.value) ? ai.value : [])
      .filter(c => c && typeof c.front === 'string' && typeof c.back === 'string')
      .filter(c => c.front.trim() && c.back.trim())
      .slice(0, 12);

    for (const c of clean) {
      await pool.query(
        `INSERT INTO "Flashcard" ("sessionId", front, back) VALUES ($1, $2, $3)`,
        [sessionId, c.front.trim(), c.back.trim()]
      );
    }

    res.json({ flashcards: clean });

  } catch (err) {
    console.error('POST /sessions/:id/flashcards failed:', err);
    res.status(500).json({ error: 'Could not build flashcards' });
  }
});

/* ==================================================================
   Quiz
   ================================================================== */

app.post('/sessions/:id/generate-questions', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Only ever generate one set of questions per session. Generating a
    // second set used to leave the session with ten questions while the
    // app only held five, so grading compared answers to the wrong ones.
    const existing = await pool.query(
      `SELECT * FROM "Question" WHERE "sessionId" = $1 ORDER BY id`,
      [sessionId]
    );
    if (existing.rows.length) {
      return res.json({ demo: false, questions: forClient(existing.rows) });
    }

    const wanted = clampQuestionCount(session.questionCount);

    const prompt = `You are writing a comprehension quiz from a student's own study notes on "${session.subject}".

Generate exactly ${wanted} multiple-choice questions.

Rules:
- If the notes genuinely do not contain enough material for ${wanted} distinct questions, write fewer rather than padding with trivia or repeating the same fact twice.
- Every question and every correct answer must be fully answerable from the notes below. Do not test any fact that is not stated in the notes.
- Do not use outside knowledge, even if it is correct and related.
- Favour questions that require applying or connecting ideas in the notes over questions that just locate a phrase.
- Each question needs exactly 4 options with exactly one correct answer.
- Wrong options should be plausible, not obviously absurd.

Return ONLY valid JSON, nothing else: [{"question":"...","options":["...","...","...","..."],"correct_index":0}]

Notes:
${session.notes}`;

    let questions;
    let demo = false;

    const ai = await askGroqForJson(prompt);

    if (!ai.ok) {
      if (ai.reason === 'no-key') {
        demo = true;
        questions = [{
          question: `[DEMO — no API key set] What is the main topic of these notes on ${session.subject}?`,
          options: ['The correct topic', 'A wrong option', 'Another wrong option', 'Yet another wrong option'],
          correct_index: 0
        }];
      } else {
        console.error('quiz AI failed:', ai.reason, ai.detail || '');
        return res.status(502).json({ error: 'Could not write the quiz. Try again in a moment.' });
      }
    } else {
      questions = (Array.isArray(ai.value) ? ai.value : []).filter(q =>
        q && typeof q.question === 'string' &&
        Array.isArray(q.options) && q.options.length >= 2 &&
        Number.isInteger(q.correct_index) &&
        q.correct_index >= 0 && q.correct_index < q.options.length
      );
      if (!questions.length) {
        return res.status(502).json({ error: 'The quiz came back unusable. Try again.' });
      }
      // Models overshoot more often than they undershoot. Never give the
      // student more than they asked for.
      questions = questions.slice(0, wanted);
    }

    const savedQuestions = [];
    for (const q of questions) {
      const inserted = await pool.query(
        `INSERT INTO "Question" ("sessionId", "questionText", options, "correctIndex")
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [sessionId, q.question, q.options, q.correct_index]
      );
      savedQuestions.push(inserted.rows[0]);
    }

    res.json({ demo, questions: forClient(savedQuestions) });

  } catch (err) {
    console.error('POST /sessions/:id/generate-questions failed:', err);
    res.status(500).json({ error: 'Could not generate questions' });
  }
});

/* Strips "correctIndex" before anything goes to the desktop app.

   This matters more than it looks. Electron ships Chrome DevTools, so
   a student can press F12, open the Network tab and read the response.
   If the right answer is in there, they unlock their apps in seconds
   without studying and the whole product is pointless. Marking happens
   on this server, where the student cannot see or change it. */
function forClient(rows) {
  return rows.map(q => ({
    id: q.id,
    questionText: q.questionText,
    options: q.options
  }));
}

// Grade a quiz submission and unlock the session if it passes.
app.post('/sessions/:id/submit-quiz', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const { answers } = req.body;

    if (!Array.isArray(answers)) {
      return res.status(400).json({ error: 'answers must be an array' });
    }

    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const questionsResult = await pool.query(
      `SELECT * FROM "Question" WHERE "sessionId" = $1 ORDER BY id`,
      [sessionId]
    );
    const questions = questionsResult.rows;
    if (questions.length === 0) {
      return res.status(400).json({ error: 'No questions generated for this session yet' });
    }

    let correctCount = 0;
    questions.forEach((q, i) => {
      if (q.correctIndex === answers[i]) correctCount++;
    });

    const score = correctCount / questions.length;
    const PASS_THRESHOLD = 0.6;
    const passed = score >= PASS_THRESHOLD;

    await pool.query(
      `INSERT INTO "QuizAttempt" ("sessionId", answers, score, passed)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, answers, score, passed]
    );

    if (passed) {
      await pool.query(`UPDATE "Session" SET status = 'UNLOCKED' WHERE id = $1`, [sessionId]);
    }

    const updatedSession = await getSession(sessionId);

    /* What the student is allowed to see afterwards.

       On a PASS we hand back everything, including which option was
       right — they've already unlocked, so there is nothing left to
       game, and seeing the two they missed is the most useful moment
       for learning.

       On a FAIL we send which questions were wrong but NOT the right
       answers. They can retake the same quiz, so revealing the answers
       would turn the retry into a walkthrough and the whole product
       would be pointless. Knowing *which* ones you missed is enough to
       send you back to the right part of your notes. */
    const review = questions.map((q, i) => {
      const chosen = Number.isInteger(answers[i]) ? answers[i] : null;
      const entry = {
        questionText: q.questionText,
        options: q.options,
        yourAnswer: chosen,
        correct: q.correctIndex === chosen
      };
      if (passed) entry.correctIndex = q.correctIndex;
      return entry;
    });

    res.json({
      correctCount,
      totalQuestions: questions.length,
      score,
      passed,
      sessionStatus: updatedSession.status,
      review
    });

  } catch (err) {
    console.error('POST /sessions/:id/submit-quiz failed:', err);
    res.status(500).json({ error: 'Could not mark the quiz' });
  }
});

const PORT = process.env.PORT || 3000;
ensureTables().then(() => {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
});
