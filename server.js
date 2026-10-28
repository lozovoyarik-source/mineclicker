
const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

if (!BOT_TOKEN || !DATABASE_URL) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or DATABASE_URL");
}

const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

const mines = [
  { unlock: 0, mult: 1 },
  { unlock: 500, mult: 2 },
  { unlock: 2500, mult: 5 },
  { unlock: 10000, mult: 12 }
];

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

  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const expected = crypto
    .createHmac("sha256", secret)
    .update(checkString)
    .digest();

  const received = Buffer.from(hash, "hex");

  if (!crypto.timingSafeEqual(expected, received)) return null;

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

    ALTER TABLE players
      ADD COLUMN IF NOT EXISTS power INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS upgrade_cost BIGINT NOT NULL DEFAULT 25,
      ADD COLUMN IF NOT EXISTS workers INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS worker_cost BIGINT NOT NULL DEFAULT 50,
      ADD COLUMN IF NOT EXISTS selected_mine INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS guest_token_hash TEXT UNIQUE,
      ADD COLUMN IF NOT EXISTS last_tick_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);
}

function publicPlayer(row) {
  return {
    id: row.id,
    username: row.username,
    coins: Number(row.coins),
    power: row.power,
    upgradeCost: Number(row.upgrade_cost),
    workers: row.workers,
    workerCost: Number(row.worker_cost),
    selected: row.selected_mine
  };
}

async function loadPlayer(req, res, next) {
  try {
    const initData = req.body?.initData;
    const guestToken = req.body?.guestToken;

    if (initData) {
      const user = verifyTelegram(initData);

      if (!user) {
        return res.status(401).json({ error: "Invalid Telegram session" });
      }

      const username = String(
        user.username || user.first_name || "Miner"
      ).slice(0, 64);

      const result = await db.query(
        `INSERT INTO players (telegram_id, username)
         VALUES ($1, $2)
         ON CONFLICT (telegram_id)
         DO UPDATE SET username = EXCLUDED.username
         RETURNING *`,
        [String(user.id), username]
      );

      req.player = result.rows[0];
    } else if (typeof guestToken === "string" &&
               /^[a-f0-9]{64}$/.test(guestToken)) {
      const tokenHash = crypto
        .createHash("sha256")
        .update(guestToken)
        .digest("hex");

      const result = await db.query(
        `SELECT * FROM players WHERE guest_token_hash = $1`,
        [tokenHash]
      );

      if (!result.rowCount) {
        return res.status(401).json({ error: "Invalid guest session" });
      }

      req.player = result.rows[0];
    } else {
      return res.status(401).json({ error: "Authentication required" });
    }

    next();
  } catch (error) {
    next(error);
  }
}

async function applyPassiveIncome(player) {
  const result = await db.query(
    `UPDATE players
     SET coins = coins + (
       workers::BIGINT *
       $2::BIGINT *
       LEAST(
         28800,
         GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - last_tick_at))))
       )
     ),
     last_tick_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [player.id, mines[player.selected_mine].mult]
  );

  return result.rows[0];
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

app.post("/api/guest-session", async (req, res, next) => {
  try {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    await db.query(
      `INSERT INTO players (username, guest_token_hash)
       VALUES ('Гість', $1)`,
      [tokenHash]
    );

    res.json({ guestToken: token });
  } catch (error) {
    next(error);
  }
});

app.post("/api/player", loadPlayer, async (req, res, next) => {
  try {
    const player = await applyPassiveIncome(req.player);
    res.json({ player: publicPlayer(player) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/action", loadPlayer, async (req, res, next) => {
  const { action } = req.body;

  if (!["mine", "upgrade", "hire", "select"].includes(action)) {
    return res.status(400).json({ error: "Unknown action" });
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const locked = await client.query(
      "SELECT * FROM players WHERE id = $1 FOR UPDATE",
      [req.player.id]
    );

    let player = await applyPassiveIncome(locked.rows[0]);

    if (action === "mine") {
      await client.query(
        "UPDATE players SET coins = coins + $1 WHERE id = $2",
        [player.power * mines[player.selected_mine].mult, player.id]
      );
    }

    if (action === "upgrade") {
      if (Number(player.coins) < Number(player.upgrade_cost)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Not enough coins" });
      }

      await client.query(
        `UPDATE players
         SET coins = coins - upgrade_cost,
             power = power + 1,
             upgrade_cost = FLOOR(upgrade_cost * 1.7)
         WHERE id = $1`,
        [player.id]
      );
    }

    if (action === "hire") {
      if (Number(player.coins) < Number(player.worker_cost)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Not enough coins" });
      }

      await client.query(
        `UPDATE players
         SET coins = coins - worker_cost,
             workers = workers + 1,
             worker_cost = FLOOR(worker_cost * 1.8)
         WHERE id = $1`,
        [player.id]
      );
    }

    if (action === "select") {
      const selected = Number(req.body.selected);

      if (!Number.isInteger(selected) ||
          selected < 0 || selected >= mines.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Invalid mine" });
      }

      if (Number(player.coins) < mines[selected].unlock) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Mine is locked" });
      }

      await client.query(
        "UPDATE players SET selected_mine = $1 WHERE id = $2",
        [selected, player.id]
      );
    }

    const updated = await client.query(
      "SELECT * FROM players WHERE id = $1",
      [player.id]
    );

    await client.query("COMMIT");
    res.json({ player: publicPlayer(updated.rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
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
