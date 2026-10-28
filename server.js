
const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN || !process.env.DATABASE_URL) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or DATABASE_URL");
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

function verifyTelegram(initData) {
  if (typeof initData !== "string" || !initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;

  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);

  if (!Number.isFinite(authDate) ||
      authDate > now + 60 ||
      now - authDate > 86400) return null;

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const expectedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest();

  const receivedHash = Buffer.from(hash, "hex");

  if (!crypto.timingSafeEqual(expectedHash, receivedHash)) {
    return null;
  }

  try {
    const user = JSON.parse(params.get("user") || "{}");
    if (!Number.isSafeInteger(user.id) || user.id <= 0) return null;
    return user;
  } catch {
    return null;
  }
}

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

async function telegramPlayer(req, res, next) {
  const user = verifyTelegram(req.body?.initData);

  if (!user) {
    return res.status(401).json({
      error: "Invalid or expired Telegram session"
    });
  }

  try {
    const username = String(
      user.username || user.first_name || "Miner"
    ).slice(0, 64);

    const result = await db.query(
      `INSERT INTO players (telegram_id, username)
       VALUES ($1, $2)
       ON CONFLICT (telegram_id)
       DO UPDATE SET username = EXCLUDED.username
       RETURNING id, telegram_id, username, coins, level`,
      [String(user.id), username]
    );

    req.player = result.rows[0];
    next();
  } catch (error) {
    next(error);
  }
}

app.get("/api/status", async (req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({
      game: "MineClicker",
      status: "online",
      database: "connected"
    });
  } catch {
    res.status(503).json({
      game: "MineClicker",
      status: "error",
      database: "disconnected"
    });
  }
});

app.post("/api/player", telegramPlayer, (req, res) => {
  res.json({ player: req.player });
});

app.post("/api/mine", telegramPlayer, async (req, res, next) => {
  try {
    const result = await db.query(
      `UPDATE players
       SET coins = coins + 1
       WHERE id = $1
       RETURNING id, telegram_id, username, coins, level`,
      [req.player.id]
    );

    res.json({ player: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.get("/api/leaderboard", async (req, res, next) => {
  try {
    const result = await db.query(`
      SELECT username, coins, level
      FROM players
      ORDER BY coins DESC, id ASC
      LIMIT 10
    `);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks", async (req, res, next) => {
  try {
    const result = await db.query(
      "SELECT id, title, reward FROM tasks ORDER BY id"
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, req, res, next) => {
  console.error("Request failed:", error.message);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Internal server error" });
});

async function start() {
  await initDatabase();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`MineClicker running on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error("Startup failed:", error.message);
  process.exit(1);
});
