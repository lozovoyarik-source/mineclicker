
const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const db = new Database("mineclicker.db");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT UNIQUE,
    username TEXT DEFAULT '',
    coins INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    reward INTEGER NOT NULL DEFAULT 0
  );
`);

app.get("/api/status", (req, res) => {
  res.json({
    game: "MineClicker",
    status: "online",
    database: "connected"
  });
});

app.get("/api/leaderboard", (req, res) => {
  const players = db.prepare(`
    SELECT username, coins, level
    FROM players
    ORDER BY coins DESC
    LIMIT 10
  `).all();

  res.json(players);
});

app.get("/api/tasks", (req, res) => {
  const tasks = db.prepare(`
    SELECT id, title, reward FROM tasks
  `).all();

  res.json(tasks);
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MineClicker server running on port ${PORT}`);
});

