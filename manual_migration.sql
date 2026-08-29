CREATE TABLE "Session" (
  id SERIAL PRIMARY KEY,
  subject TEXT NOT NULL,
  notes TEXT NOT NULL,
  "durationMin" INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  "startedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE "Question" (
  id SERIAL PRIMARY KEY,
  "sessionId" INTEGER NOT NULL REFERENCES "Session"(id),
  "questionText" TEXT NOT NULL,
  options TEXT[] NOT NULL,
  "correctIndex" INTEGER NOT NULL
);

CREATE TABLE "QuizAttempt" (
  id SERIAL PRIMARY KEY,
  "sessionId" INTEGER NOT NULL REFERENCES "Session"(id),
  answers INTEGER[] NOT NULL,
  score FLOAT NOT NULL,
  passed BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);
