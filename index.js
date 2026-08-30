require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// This "pool" is our connection to the real Postgres database.
// Every query below goes through this — this is the one thing that changed
// fundamentally: data now lives in Postgres, not in a JS array that resets.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.get('/', (req, res) => {
  res.send('ScholarOS server is running!');
});

// Create a new study session — now INSERTs a real row into Postgres.
app.post('/sessions', async (req, res) => {
  const { subject, notes, durationMin } = req.body;

  const result = await pool.query(
    `INSERT INTO "Session" (subject, notes, "durationMin", status)
     VALUES ($1, $2, $3, 'ACTIVE')
     RETURNING *`,
    [subject, notes, durationMin]
  );

  res.json(result.rows[0]);
});

// List all sessions — now a real SELECT from Postgres.
app.get('/sessions', async (req, res) => {
  const result = await pool.query(`SELECT * FROM "Session" ORDER BY id`);
  res.json(result.rows);
});

// Generate quiz questions from a session's notes, and save them for real.
app.post('/sessions/:id/generate-questions', async (req, res) => {
  const sessionId = parseInt(req.params.id);

  const sessionResult = await pool.query(`SELECT * FROM "Session" WHERE id = $1`, [sessionId]);
  const session = sessionResult.rows[0];
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

    const prompt = `You are writing a comprehension quiz from a student's own study notes on "${session.subject}".

Generate exactly 5 multiple-choice questions.

Rules:
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

      if (!process.env.GROQ_API_KEY) {
    demo = true;
    questions = [
      {
        question: `[DEMO — no API key set] What is the main topic of these notes on ${session.subject}?`,
        options: ['The correct topic', 'A wrong option', 'Another wrong option', 'Yet another wrong option'],
        correct_index: 0
      }
    ];
  } else {
            const aiResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await aiResponse.json();
    console.log('GROQ RESPONSE:', JSON.stringify(data));
    const raw = data.choices[0].message.content.replace(/```json|```/g, '').trim();
    questions = JSON.parse(raw);
  }

  // Save each generated question as a real row in Postgres.
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

  res.json({ demo, questions: savedQuestions });
});

// Grade a quiz submission and unlock the session if it passes.
app.post('/sessions/:id/submit-quiz', async (req, res) => {
  const sessionId = parseInt(req.params.id);
  const { answers } = req.body;

  const sessionResult = await pool.query(`SELECT * FROM "Session" WHERE id = $1`, [sessionId]);
  const session = sessionResult.rows[0];
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

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
    if (q.correctIndex === answers[i]) {
      correctCount++;
    }
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

  const updatedSession = await pool.query(`SELECT * FROM "Session" WHERE id = $1`, [sessionId]);

  res.json({
    correctCount,
    totalQuestions: questions.length,
    score,
    passed,
    sessionStatus: updatedSession.rows[0].status
  });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
