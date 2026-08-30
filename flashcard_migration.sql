-- Adds the Flashcard table.
--
-- You do NOT have to run this by hand: index.js runs the same
-- CREATE TABLE IF NOT EXISTS on boot, so deploying is enough.
-- This file exists so the schema history stays readable alongside
-- manual_migration.sql.

CREATE TABLE IF NOT EXISTS "Flashcard" (
  id SERIAL PRIMARY KEY,
  "sessionId" INTEGER NOT NULL REFERENCES "Session"(id),
  front TEXT NOT NULL,
  back TEXT NOT NULL
);
