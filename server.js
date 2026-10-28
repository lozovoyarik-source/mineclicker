
const express = require("express");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not configured");
  process.exit(1);
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS players (
      id BIGSERIAL PRIMARY KEY,
      telegram_id TEXT UNIQUE,
      username TEXT NOT NULL DEFAULT '',
      coins BIGINT NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      reward INTEGER NOT NULL DEFAULT 0
    );
  `);
}

app.get("/api/status", async (req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({
      game: "MineClicker",
      status: "online",
      database: "connected"
    });
  } catch (error) {
    console.error("Database check failed:", error.message);
    res.status(503).json({
      game: "MineClicker",
      status: "error",
      database: "disconnected"
    });
  }
});

app.get("/api/leaderboard", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT username, coins, level
      FROM players
      ORDER BY coins DESC
      LIMIT 10
    `);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load leaderboard" });
  }
});

app.get("/api/tasks", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, title, reward FROM tasks ORDER BY id"
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load tasks" });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function start() {
  await initDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`MineClicker server running on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error("Server startup failed:", error.message);
  process.exit(1);
});
