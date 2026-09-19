const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Stripe = require("stripe");
const { v2: cloudinary } = require("cloudinary");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 5050);
const ROOT = __dirname;

// Render supplies DATABASE_URL when a PostgreSQL database is attached.
// Local JSON remains available for running D50 on a personal computer.
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const DATABASE_PROVIDER = process.env.D50_DATABASE_PROVIDER ||
  (DATABASE_URL ? "postgres" : "local-json");
const DATABASE_CONFIG = Object.freeze({
  provider: DATABASE_PROVIDER,
  directory: process.env.D50_DATA_DIR || path.join(ROOT, "data"),
});
if (!["local-json", "postgres"].includes(DATABASE_CONFIG.provider)) {
  throw new Error(
    `Unsupported database provider: ${DATABASE_CONFIG.provider}. Add its adapter in the database setup block.`,
  );
}
if (DATABASE_CONFIG.provider === "postgres" && !DATABASE_URL) {
  throw new Error("DATABASE_URL is required when D50_DATABASE_PROVIDER=postgres.");
}
const postgres = DATABASE_PROVIDER === "postgres"
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
    })
  : null;
const databaseState = new Map();
const MUSIC_DIR = path.join(ROOT, "music");
const COVERS_DIR = path.join(ROOT, "public", "covers");
const CATEGORY_COVERS_DIR = path.join(ROOT, "public", "category-covers");
const DATA_DIR = DATABASE_CONFIG.directory;
const SONGS_FILE = path.join(DATA_DIR, "songs.json");
const CATEGORIES_FILE = path.join(DATA_DIR, "categories.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");
const CODES_FILE = path.join(DATA_DIR, "codes.json");
const allowedAudioExtensions = new Set([".mp3", ".wav", ".m4a"]);
const allowedCoverExtensions = new Set([".jpg", ".jpeg", ".png"]);
const AUDIO_LIMIT = 15 * 1024 * 1024;
const COVER_LIMIT = 2 * 1024 * 1024;
const TRIAL_DAYS = 30;
const FREE_LISTEN_LIMIT = 5;
const FREE_APPROVED_UPLOAD_LIMIT = 100;
const FREE_PENDING_UPLOAD_LIMIT = 5;
const PREMIUM_PERIOD_DAYS = 30;
const PREMIUM_PERIOD_MS = PREMIUM_PERIOD_DAYS * 24 * 60 * 60 * 1000;
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || "").trim();
const STRIPE_PUBLISHABLE_KEY = String(
  process.env.STRIPE_PUBLISHABLE_KEY || "",
).trim();
const STRIPE_PREMIUM_PRICE_CENTS = Number(
  process.env.STRIPE_PREMIUM_PRICE_CENTS || 999,
);
const STRIPE_CURRENCY = String(process.env.STRIPE_CURRENCY || "usd")
  .trim()
  .toLowerCase();
const STRIPE_WEBHOOK_SECRET = String(
  process.env.STRIPE_WEBHOOK_SECRET || "",
).trim();
const APP_BASE_URL = String(process.env.APP_BASE_URL || "")
  .trim()
  .replace(/\/$/, "");
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const CLOUDINARY_URL = String(process.env.CLOUDINARY_URL || "").trim();
const CLOUDINARY_CLOUD_NAME = String(
  process.env.CLOUDINARY_CLOUD_NAME || "",
).trim();
const CLOUDINARY_API_KEY = String(
  process.env.CLOUDINARY_API_KEY || "",
).trim();
const CLOUDINARY_API_SECRET = String(
  process.env.CLOUDINARY_API_SECRET || "",
).trim();
const CLOUDINARY_CONFIGURED = Boolean(
  CLOUDINARY_URL ||
    (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET),
);
if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
} else if (CLOUDINARY_URL) {
  // The Cloudinary SDK reads CLOUDINARY_URL directly from the environment.
  cloudinary.config({ secure: true });
}
const PREMIUM_CATEGORY_LIMIT = 5;
const CATEGORY_SONG_LIMIT = 50;
const ADMIN_FREEZE_MS = 15 * 60 * 1000;
const ADMIN_FREEZE_STRIKES = 3;
const ADMIN_BAN_STRIKES = 6;
const pendingUploadReservations = new Map();
const approvalReservations = new Map();
// Change these environment variables before exposing D50 outside your PC.
const ADMIN_MASTER_PIN = String(
  process.env.D50_ADMIN_MASTER_PIN || "12D50B22_DD_#12_Tisten",
);

fs.mkdirSync(MUSIC_DIR, { recursive: true });
fs.mkdirSync(COVERS_DIR, { recursive: true });
fs.mkdirSync(CATEGORY_COVERS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file) {
  if (DATABASE_PROVIDER === "postgres" && databaseState.has(file)) {
    return structuredClone(databaseState.get(file));
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}
const writeQueues = new Map();
const WINDOWS_REPLACE_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
async function replaceFileWithRetry(temporary, file) {
  let lastError;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    try {
      await fs.promises.rename(temporary, file);
      return;
    } catch (error) {
      lastError = error;
      if (!WINDOWS_REPLACE_ERRORS.has(error.code)) throw error;
      await wait(40 * 2 ** attempt);
    }
  }

  // Windows security/indexing software can briefly lock an existing JSON file.
  // The complete validated temp file is copied only after atomic rename retries
  // are exhausted, then flushed before the temp file is removed.
  try {
    await fs.promises.copyFile(temporary, file);
    const handle = await fs.promises.open(file, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (fallbackError) {
    fallbackError.cause = lastError;
    throw fallbackError;
  }
}
async function atomicWrite(file, contents) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
    });
    await replaceFileWithRetry(temporary, file);
    await fs.promises.unlink(temporary).catch(() => {});
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function persistRelationalRows(file, value) {
  const client = await postgres.connect();
  const rows = Array.isArray(value) ? value : [];
  const ids = rows.map((item) => String(item.id || "")).filter(Boolean);
  try {
    await client.query("BEGIN");
    if (file === USERS_FILE) {
      await client.query(
        `INSERT INTO users (
           id, email, password_hash, password_salt, session_token_hash,
           role, data, created_at, updated_at
         )
         SELECT
           item->>'id', LOWER(item->>'email'), item->>'passwordHash',
           item->>'passwordSalt', item->>'sessionTokenHash',
           COALESCE(item->>'role', 'user'), item,
           COALESCE((item->>'createdAt')::bigint, 0), NOW()
         FROM jsonb_array_elements($1::jsonb) AS item
         WHERE COALESCE(item->>'id', '') <> ''
           AND COALESCE(item->>'email', '') <> ''
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           password_hash = EXCLUDED.password_hash,
           password_salt = EXCLUDED.password_salt,
           session_token_hash = EXCLUDED.session_token_hash,
           role = EXCLUDED.role,
           data = EXCLUDED.data,
           created_at = EXCLUDED.created_at,
           updated_at = NOW()`,
        [JSON.stringify(rows)],
      );
      await client.query("DELETE FROM users WHERE NOT (id = ANY($1::text[]))", [ids]);
    } else if (file === SONGS_FILE) {
      await client.query(
        `INSERT INTO songs (
           id, title, url, owner_id, status, data, created_at, updated_at
         )
         SELECT
           item->>'id', COALESCE(item->>'title', 'Untitled track'),
           item->>'url', COALESCE(item->>'ownerId', item->>'uploadedBy'),
           COALESCE(item->>'status', 'approved'), item,
           COALESCE((item->>'createdAt')::bigint, 0), NOW()
         FROM jsonb_array_elements($1::jsonb) AS item
         WHERE COALESCE(item->>'id', '') <> ''
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           url = EXCLUDED.url,
           owner_id = EXCLUDED.owner_id,
           status = EXCLUDED.status,
           data = EXCLUDED.data,
           created_at = EXCLUDED.created_at,
           updated_at = NOW()`,
        [JSON.stringify(rows)],
      );
      await client.query("DELETE FROM songs WHERE NOT (id = ANY($1::text[]))", [ids]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function writeJson(file, value) {
  if (DATABASE_PROVIDER === "postgres") {
    databaseState.set(file, structuredClone(value));
    const documentName = path.basename(file, ".json");
    const previous = writeQueues.get(file) || Promise.resolve();
    const current = previous.catch(() => {}).then(() =>
      file === USERS_FILE || file === SONGS_FILE
        ? persistRelationalRows(file, value)
        : postgres.query(
            `INSERT INTO d50_documents (name, value, updated_at)
             VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (name) DO UPDATE
             SET value = EXCLUDED.value, updated_at = NOW()`,
            [documentName, JSON.stringify(value)],
          ),
    );
    writeQueues.set(file, current);
    const clearQueue = () => {
      if (writeQueues.get(file) === current) writeQueues.delete(file);
    };
    current.then(clearQueue, clearQueue);
    return current;
  }
  const previous = writeQueues.get(file) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`));
  writeQueues.set(file, current);
  const clearQueue = () => {
    if (writeQueues.get(file) === current) writeQueues.delete(file);
  };
  current.then(clearQueue, clearQueue);
  return current;
}
const readSongs = () => readJson(SONGS_FILE);
const writeSongs = (value) => writeJson(SONGS_FILE, value);
const readCategories = () => readJson(CATEGORIES_FILE);
const writeCategories = (value) => writeJson(CATEGORIES_FILE, value);
const readUsers = () => readJson(USERS_FILE);
const writeUsers = (value) => writeJson(USERS_FILE, value);
const readReports = () => readJson(REPORTS_FILE);
const writeReports = (value) => writeJson(REPORTS_FILE, value);
const readCodes = () => readJson(CODES_FILE);
const writeCodes = (value) => writeJson(CODES_FILE, value);
const DATA_FILES = [SONGS_FILE, CATEGORIES_FILE, USERS_FILE, REPORTS_FILE, CODES_FILE];

async function initializePostgresSchema() {
  await postgres.query(`CREATE TABLE IF NOT EXISTS d50_documents (
    name TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await postgres.query(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    password_hash TEXT,
    password_salt TEXT,
    session_token_hash TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await postgres.query(`CREATE TABLE IF NOT EXISTS songs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'Untitled track',
    url TEXT,
    owner_id TEXT,
    status TEXT NOT NULL DEFAULT 'approved',
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await postgres.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email))",
  );
  await postgres.query(
    "CREATE INDEX IF NOT EXISTS songs_status_created_idx ON songs (status, created_at DESC)",
  );
  await postgres.query(
    "CREATE INDEX IF NOT EXISTS songs_owner_idx ON songs (owner_id)",
  );
}

const storageReady = DATABASE_PROVIDER === "postgres"
  ? (async () => {
      await initializePostgresSchema();
      console.log("PostgreSQL schema ready: users and songs tables initialized");
      for (const file of DATA_FILES) {
        const name = path.basename(file, ".json");
        if (file === USERS_FILE || file === SONGS_FILE) {
          const table = file === USERS_FILE ? "users" : "songs";
          const relational = await postgres.query(
            `SELECT data FROM ${table} ORDER BY created_at ASC`,
          );
          if (relational.rowCount) {
            databaseState.set(file, relational.rows.map((row) => row.data));
            continue;
          }
        }
        const existing = await postgres.query(
          "SELECT value FROM d50_documents WHERE name = $1",
          [name],
        );
        const seed = existing.rowCount ? existing.rows[0].value : readJson(file);
        if (file === USERS_FILE || file === SONGS_FILE) {
          await persistRelationalRows(file, seed);
          databaseState.set(file, seed);
          continue;
        }
        if (existing.rowCount) {
          databaseState.set(file, existing.rows[0].value);
          continue;
        }
        await postgres.query(
          "INSERT INTO d50_documents (name, value) VALUES ($1, $2::jsonb)",
          [name, JSON.stringify(seed)],
        );
        databaseState.set(file, seed);
      }
    })()
  : Promise.all(DATA_FILES.map(async (file) => {
      if (!fs.existsSync(file)) await atomicWrite(file, "[]\n");
    }));
async function migrateLegacyOwnership(ownerId) {
  if (!ownerId) return;
  const songs = readSongs();
  const categories = readCategories();
  let songsChanged = false;
  let categoriesChanged = false;
  songs.forEach((song) => {
    if (!song.ownerId) {
      song.ownerId = song.uploadedBy || ownerId;
      songsChanged = true;
    }
  });
  categories.forEach((category) => {
    if (!category.ownerId) {
      category.ownerId = ownerId;
      categoriesChanged = true;
    }
  });
  if (songsChanged) await writeSongs(songs);
  if (categoriesChanged) await writeCategories(categories);
}
async function migrateSongLikes() {
  const songs = readSongs();
  const users = readUsers();
  let changed = false;
  songs.forEach((song) => {
    const likedBy = new Set(Array.isArray(song.likedBy) ? song.likedBy : []);
    users.forEach((user) => {
      if ((user.likedSongIds || []).includes(song.id)) likedBy.add(user.id);
    });
    if (
      !Array.isArray(song.likedBy) ||
      song.likedBy.length !== likedBy.size ||
      song.likedBy.some((id) => !likedBy.has(id))
    ) {
      song.likedBy = [...likedBy];
      changed = true;
    }
  });
  if (changed) await writeSongs(songs);
  const usersWithLegacyLikes = users.some(
    (user) => Array.isArray(user.likedSongIds) && user.likedSongIds.length,
  );
  if (usersWithLegacyLikes) {
    users.forEach((user) => (user.likedSongIds = []));
    await writeUsers(users);
  }
}
async function migrateUserProfileFlags() {
  const users = readUsers();
  let changed = false;
  users.forEach((user) => {
    if (typeof user.hasSeenUploadWarning !== "boolean") {
      user.hasSeenUploadWarning = false;
      changed = true;
    }
    if (!Number.isFinite(Number(user.adminFailedAttempts))) {
      user.adminFailedAttempts = 0;
      changed = true;
    }
    if (typeof user.isAdminBanned !== "boolean") {
      user.isAdminBanned = false;
      changed = true;
    }
    if (user.adminLockedUntil === undefined) {
      user.adminLockedUntil = null;
      changed = true;
    }
  });
  if (changed) await writeUsers(users);
}
function sanitizeText(value, maximumLength) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>&"'`]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
}
async function removeUploadedFiles(files) {
  await Promise.all(
    Object.values(files || {})
      .flat()
      .map((file) => file.path
        ? fs.promises.unlink(file.path).catch(() => {})
        : Promise.resolve()),
  );
}
async function hasValidSignature(file, kind) {
  if (file.buffer) return hasValidBufferSignature(file.buffer, file.originalname, kind);
  const handle = await fs.promises.open(file.path, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (kind === "cover") {
      const png =
        bytesRead >= 8 &&
        buffer
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg =
        bytesRead >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff;
      return png || jpeg;
    }
    const extension = path.extname(file.originalname).toLowerCase();
    if (extension === ".wav")
      return (
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WAVE"
      );
    if (extension === ".m4a")
      return bytesRead >= 12 && buffer.toString("ascii", 4, 8) === "ftyp";
    return (
      buffer.toString("ascii", 0, 3) === "ID3" ||
      (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
    );
  } finally {
    await handle.close();
  }
}

function hasValidBufferSignature(buffer, originalName, kind) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return false;
  if (kind === "cover") {
    const png = buffer.length >= 8 && buffer.subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    return png || jpeg;
  }
  const extension = path.extname(originalName).toLowerCase();
  if (extension === ".wav")
    return buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WAVE";
  if (extension === ".m4a")
    return buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp";
  return buffer.toString("ascii", 0, 3) === "ID3" ||
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}
function passwordMatches(password, user) {
  if (!user.passwordSalt || !user.passwordHash) return false;
  const candidate = Buffer.from(
    hashPassword(password, user.passwordSalt).hash,
    "hex",
  );
  const stored = Buffer.from(user.passwordHash, "hex");
  return (
    candidate.length === stored.length &&
    crypto.timingSafeEqual(candidate, stored)
  );
}
function cookie(request, name) {
  const item = String(request.headers.cookie || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : null;
}
function sessionToken(request) {
  const authorization = String(request.headers.authorization || "");
  if (authorization.startsWith("Bearer ")) return authorization.slice(7);
  return cookie(request, "d50_session");
}
function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}
function hasRedeemedFreeAdminCode(user) {
  if (!user?.freeAdminCodeId) return false;
  return readCodes().some(
    (entry) =>
      entry.id === user.freeAdminCodeId &&
      entry.status === "redeemed" &&
      entry.redeemedByUserId === user.id,
  );
}
function premiumExpiryFor(user, now = Date.now()) {
  const stored = Number(user?.premiumExpiresAt);
  if (Number.isFinite(stored) && stored > 0) return stored;
  if (!user?.paid) return 0;
  const paidAt = Number(user.paidAt);
  return (Number.isFinite(paidAt) && paidAt > 0 ? paidAt : now) + PREMIUM_PERIOD_MS;
}
function normalizePremiumExpiration(user, now = Date.now()) {
  if (!user?.paid) return false;
  let changed = false;
  let expiresAt = Number(user.premiumExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    expiresAt = premiumExpiryFor(user, now);
    user.premiumExpiresAt = expiresAt;
    changed = true;
  }
  if (expiresAt <= now) {
    user.paid = false;
    user.paidAt = null;
    user.premiumExpiresAt = null;
    user.premiumExpiredAt = now;
    user.autoRenew = false;
    changed = true;
  }
  return changed;
}
function accessFor(user) {
  const now = Date.now();
  const trialEndsAt = user.createdAt + TRIAL_DAYS * 86400000;
  const trialActive = false;
  const premiumExpiresAt = premiumExpiryFor(user, now);
  const paid = Boolean(user.paid && premiumExpiresAt > now);
  const adminMode = user.isAdminBanned
    ? null
    : user.adminMode === "free" && hasRedeemedFreeAdminCode(user)
      ? "free"
      : user.adminMode === "master" || user.adminMode === true
        ? "master"
        : null;
  return {
    paid,
    trialActive,
    premium: Boolean(paid || adminMode),
    canManage: Boolean(!user.banned && (paid || adminMode === "master")),
    canCreateCategories: Boolean(paid || adminMode === "master"),
    adminMode,
    premiumExpiresAt: paid ? premiumExpiresAt : null,
    premiumDaysRemaining: paid
      ? Math.max(0, Math.ceil((premiumExpiresAt - now) / 86400000))
      : 0,
    autoRenew: paid ? user.autoRenew !== false : false,
    trialEndsAt,
    daysLeft: 0,
    listenCount: Number(user.listenCount || 0),
    freeListenLimit: FREE_LISTEN_LIMIT,
  };
}
function uploadCapacityFor(user, songs = readSongs()) {
  const ownedSongs = songs.filter(
    (song) => song.ownerId === user.id || song.uploadedBy === user.id,
  );
  const approvedCount = ownedSongs.filter(
    (song) => !song.status || song.status === "approved",
  ).length;
  const pendingCount = ownedSongs.filter(
    (song) => song.status === "pending",
  ).length;
  return {
    freeApprovedUploadCount: approvedCount,
    freePendingUploadCount: pendingCount,
    freeApprovedUploadLimit: FREE_APPROVED_UPLOAD_LIMIT,
    freePendingUploadLimit: FREE_PENDING_UPLOAD_LIMIT,
  };
}
function reservationCount(map, userId) {
  return Number(map.get(userId) || 0);
}
function reserveCapacity(map, userId) {
  map.set(userId, reservationCount(map, userId) + 1);
  return () => {
    const remaining = reservationCount(map, userId) - 1;
    if (remaining > 0) map.set(userId, remaining);
    else map.delete(userId);
  };
}
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    banned: Boolean(user.banned),
    hasSeenUploadWarning: Boolean(user.hasSeenUploadWarning),
    adminFailedAttempts: Number(user.adminFailedAttempts || 0),
    adminLockedUntil: Number(user.adminLockedUntil || 0) || null,
    isAdminBanned: Boolean(user.isAdminBanned),
    createdAt: user.createdAt,
    likedSongIds: user.likedSongIds || [],
    adminFeatures: Number(user.adminFeatures || 0),
    adminSilverFeatures: Number(user.adminSilverFeatures || 0),
    warnings: (user.warnings || []).map((warning) => ({
      id: warning.id,
      message: warning.message,
      contentTitle: warning.contentTitle,
      createdAt: warning.createdAt,
    })),
    ...uploadCapacityFor(user),
    ...accessFor(user),
  };
}
function publicCategory(category, user = null) {
  const likedBy = Array.isArray(category.likedBy) ? category.likedBy : [];
  const countedLikes = new Set(
    likedBy.filter((userId) => userId !== category.ownerId),
  );
  const { likedBy: _privateLikes, ...safeCategory } = category;
  const ownerIsBanned = readUsers().some(
    (account) => account.id === category.ownerId && account.banned,
  );
  const hideOwnerName =
    ownerIsBanned &&
    user?.id !== category.ownerId &&
    !(user && isMasterAdmin(user));
  const ownerEmail =
    user && isMasterAdmin(user)
      ? readUsers().find((account) => account.id === category.ownerId)?.email || null
      : null;
  return {
    ...safeCategory,
    name: hideOwnerName ? "Hidden Category" : safeCategory.name,
    ...(ownerEmail ? { ownerEmail } : {}),
    hasGold:
      Boolean(category.hasGold || Number(category.goldBoostUntil) > Date.now()) &&
      (!category.goldBoostUntil || Number(category.goldBoostUntil) > Date.now()),
    hasSilver:
      Boolean(category.hasSilver || Number(category.silverBoostUntil) > Date.now()) &&
      (!category.silverBoostUntil ||
        Number(category.silverBoostUntil) > Date.now()),
    goldBoosted:
      Boolean(category.hasGold || Number(category.goldBoostUntil) > Date.now()) &&
      (!category.goldBoostUntil || Number(category.goldBoostUntil) > Date.now()),
    silverBoosted:
      Boolean(category.hasSilver || Number(category.silverBoostUntil) > Date.now()) &&
      (!category.silverBoostUntil ||
        Number(category.silverBoostUntil) > Date.now()),
    likedCount: countedLikes.size,
    liked: Boolean(user && likedBy.includes(user.id)),
    selfLikeExcluded: Boolean(user && category.ownerId === user.id),
  };
}
function categoryVisibleTo(category, user = null, users = readUsers()) {
  if (user && (user.id === category.ownerId || isMasterAdmin(user))) return true;
  return !users.some(
    (account) => account.id === category.ownerId && account.banned,
  );
}
function publicSong(song, user = null) {
  const likedBy = Array.isArray(song.likedBy) ? song.likedBy : [];
  const countedLikes = new Set(
    likedBy.filter((userId) => userId !== song.ownerId),
  );
  const { likedBy: _privateLikes, ...safeSong } = song;
  const contentOwnerId = song.ownerId || song.uploadedBy;
  const ownerEmail =
    user && isMasterAdmin(user)
      ? readUsers().find((account) => account.id === contentOwnerId)?.email || null
      : null;
  return {
    ...safeSong,
    ...(ownerEmail ? { ownerEmail } : {}),
    hasGold:
      Boolean(song.hasGold || Number(song.goldBoostUntil) > Date.now()) &&
      (!song.goldBoostUntil || Number(song.goldBoostUntil) > Date.now()),
    hasSilver:
      Boolean(song.hasSilver || Number(song.silverBoostUntil) > Date.now()) &&
      (!song.silverBoostUntil || Number(song.silverBoostUntil) > Date.now()),
    goldBoosted:
      Boolean(song.hasGold || Number(song.goldBoostUntil) > Date.now()) &&
      (!song.goldBoostUntil || Number(song.goldBoostUntil) > Date.now()),
    silverBoosted:
      Boolean(song.hasSilver || Number(song.silverBoostUntil) > Date.now()) &&
      (!song.silverBoostUntil || Number(song.silverBoostUntil) > Date.now()),
    likedCount: countedLikes.size,
    liked: Boolean(user && likedBy.includes(user.id)),
    selfLikeExcluded: Boolean(user && song.ownerId === user.id),
  };
}
async function auth(request, response, next) {
  const token = sessionToken(request);
  const digest = token ? tokenHash(token) : "";
  const users = readUsers();
  const user = users.find(
    (item) => item.sessionTokenHash && item.sessionTokenHash === digest,
  );
  if (!user) return response.status(401).json({ error: "Please log in." });
  if (normalizePremiumExpiration(user)) await writeUsers(users);
  request.user = user;
  next();
}
function optionalAuth(request, _response, next) {
  const token = sessionToken(request);
  const digest = token ? tokenHash(token) : "";
  request.user =
    readUsers().find(
      (item) => item.sessionTokenHash && item.sessionTokenHash === digest,
    ) || null;
  next();
}
function owns(record, user) {
  return record?.ownerId === user.id;
}
function isMasterAdmin(user) {
  return accessFor(user).adminMode === "master";
}
function categoriesUserCanManage(user, categories = readCategories()) {
  return isMasterAdmin(user)
    ? categories
    : categories.filter((category) => owns(category, user));
}
function categorySongCount(categoryId, songs = readSongs()) {
  return songs.filter((song) => (song.categoryIds || []).includes(categoryId))
    .length;
}
function validateCategoryAssignment(
  categoryIds,
  user,
  songs,
  currentSong = null,
) {
  const uniqueIds = [...new Set(categoryIds.map(String))];
  const categories = readCategories();
  const manageableIds = new Set(
    categoriesUserCanManage(user, categories).map((category) => category.id),
  );
  const forbidden = uniqueIds.find((id) => !manageableIds.has(id));
  if (forbidden) {
    const exists = categories.some((category) => category.id === forbidden);
    return {
      error: exists
        ? "You can only add songs to categories that you created."
        : "One of the selected categories no longer exists.",
      code: exists ? "CATEGORY_NOT_OWNED" : "CATEGORY_NOT_FOUND",
      status: exists ? 403 : 400,
    };
  }
  const currentIds = new Set(currentSong?.categoryIds || []);
  const fullId = uniqueIds.find(
    (id) =>
      !currentIds.has(id) &&
      categorySongCount(id, songs) >= CATEGORY_SONG_LIMIT,
  );
  if (fullId) {
    return {
      error:
        "This category is full. A category can contain a maximum of 50 songs.",
      code: "CATEGORY_FULL",
      status: 409,
    };
  }
  return { categoryIds: uniqueIds };
}
function premium(request, response, next) {
  if (!accessFor(request.user).premium)
    return response
      .status(403)
      .json({ code: "PREMIUM_REQUIRED", error: "Premium is required." });
  next();
}
function manage(request, response, next) {
  if (!accessFor(request.user).canManage)
    return response.status(403).json({
      code: "MANAGEMENT_REQUIRED",
      error: "Upload and management access is required.",
    });
  next();
}
function categoryCreator(request, response, next) {
  if (!accessFor(request.user).canCreateCategories)
    return response.status(403).json({
      code: "PREMIUM_REQUIRED",
      error: "Premium is required to create custom categories.",
    });
  next();
}
function masterOnly(request, response, next) {
  if (accessFor(request.user).adminMode !== "master")
    return response.status(403).json({
      code: "MASTER_ADMIN_REQUIRED",
      error: "Master Admin access is required.",
    });
  next();
}
function paidOnly(request, response, next) {
  if (!request.user.paid)
    return response.status(403).json({
      code: "PAID_REQUIRED",
      error: "A paid Premium account is required for this action.",
    });
  next();
}
function reporterOnly(request, response, next) {
  if (accessFor(request.user).adminMode === "master")
    return response.status(403).json({
      code: "MASTER_ADMIN_CANNOT_REPORT",
      error: "Master Admin reviews reports and cannot submit them.",
    });
  return paidOnly(request, response, next);
}

const diskStorage = multer.diskStorage({
  destination: (_request, file, done) =>
    done(
      null,
      file.fieldname === "cover"
        ? COVERS_DIR
        : file.fieldname === "categoryCover"
          ? CATEGORY_COVERS_DIR
          : MUSIC_DIR,
    ),
  filename: (_request, file, done) =>
    done(
      null,
      `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`,
    ),
});
// Audio is kept in memory only long enough to send it to Cloudinary. Covers
// continue using the existing disk workflow so the current UI stays compatible.
const storage = {
  _handleFile(request, file, done) {
    if (CLOUDINARY_CONFIGURED && file.fieldname === "song") {
      const chunks = [];
      let size = 0;
      file.stream.on("data", (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
      });
      file.stream.on("error", done);
      file.stream.on("end", () => done(null, { buffer: Buffer.concat(chunks), size }));
      return;
    }
    diskStorage._handleFile(request, file, done);
  },
  _removeFile(request, file, done) {
    if (file.buffer && !file.path) return done(null);
    diskStorage._removeFile(request, file, done);
  },
};
const upload = multer({
  storage,
  limits: { fileSize: AUDIO_LIMIT, files: 2, fields: 20, parts: 22 },
  fileFilter: (_request, file, done) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const valid =
      file.fieldname === "song"
        ? allowedAudioExtensions.has(extension)
        : file.fieldname === "cover" || file.fieldname === "categoryCover"
          ? allowedCoverExtensions.has(extension)
          : false;
    done(
      valid
        ? null
        : new Error(
            file.fieldname === "cover" || file.fieldname === "categoryCover"
              ? "Cover images must be JPG or PNG files."
              : "Only MP3, WAV, and M4A audio files are allowed.",
          ),
      valid,
    );
  },
});
const cloudinaryAudioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AUDIO_LIMIT, files: 1, fields: 5, parts: 6 },
  fileFilter: (_request, file, done) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const validMimeTypes = new Set(["audio/mpeg", "audio/mp3", "audio/x-mpeg"]);
    const valid = extension === ".mp3" && validMimeTypes.has(file.mimetype);
    done(valid ? null : new Error("Only MP3 audio files are allowed."), valid);
  },
});

function isValidMp3Buffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 3 &&
    (buffer.toString("ascii", 0, 3) === "ID3" ||
      (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0))
  );
}

function uploadAudioBufferToCloudinary(file, userId) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: "video",
        folder: "d50/audio",
        public_id: `${Date.now()}-${userId}-${crypto.randomUUID()}`,
        overwrite: false,
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
    uploadStream.end(file.buffer);
  });
}

app.post(
  "/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (request, response) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      return response.status(503).send("Stripe webhook is not configured.");
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        request.body,
        request.headers["stripe-signature"],
        STRIPE_WEBHOOK_SECRET,
      );
    } catch (error) {
      console.error("Stripe webhook signature verification failed:", error.message);
      return response.status(400).send("Invalid Stripe webhook signature.");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const customerEmail = String(
        session.customer_details?.email || session.customer_email || "",
      )
        .trim()
        .toLowerCase();

      if (session.payment_status !== "paid" || !customerEmail) {
        return response.status(200).json({ received: true });
      }

      const users = readUsers();
      const user = users.find(
        (item) => String(item.email || "").toLowerCase() === customerEmail,
      );
      if (!user) {
        console.error(`Stripe payment received for unknown email: ${customerEmail}`);
        return response.status(200).json({ received: true });
      }

      const processedSessions = Array.isArray(user.stripeCheckoutSessionIds)
        ? user.stripeCheckoutSessionIds
        : [];
      if (!processedSessions.includes(session.id)) {
        const paidAt = Date.now();
        user.paid = true;
        user.paidAt = paidAt;
        user.premiumExpiresAt = paidAt + PREMIUM_PERIOD_MS;
        user.autoRenew = false;
        user.subscriptionCancelledAt = null;
        user.subscriptionAccessEndsAt = null;
        user.stripeCheckoutSessionIds = [...processedSessions, session.id];
        await writeUsers(users);
      }
    }

    response.status(200).json({ received: true });
  },
);

app.use(express.json({ limit: "32kb", strict: true }));
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://js.stripe.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.stripe.com; media-src 'self' https://res.cloudinary.com; connect-src 'self' https://api.stripe.com; frame-src https://js.stripe.com https://hooks.stripe.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  if (
    request.path === "/" ||
    request.path.startsWith("/api/") ||
    /\.(?:html|css|js)$/.test(request.path)
  ) {
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("Expires", "0");
  }
  next();
});
app.use(express.static(path.join(ROOT, "public")));
app.get("/music/:filename", (request, response) => {
  const filename = path.basename(request.params.filename);
  if (filename !== request.params.filename)
    return response.status(400).json({ error: "Invalid filename." });
  const song = readSongs().find((item) => item.filename === filename);
  if (!song) return response.status(404).json({ error: "Song not found." });
  const file = path.join(MUSIC_DIR, filename);
  if (!fs.existsSync(file))
    return response.status(404).json({ error: "Audio file not found." });
  const size = fs.statSync(file).size;
  const type =
    path.extname(filename) === ".wav"
      ? "audio/wav"
      : path.extname(filename) === ".m4a"
        ? "audio/mp4"
        : "audio/mpeg";
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", type);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "private, max-age=3600");
  const requestedRange = request.headers.range;
  if (!requestedRange) {
    response.setHeader("Content-Length", size);
    return fs.createReadStream(file).pipe(response);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(requestedRange);
  if (!match) {
    response.setHeader("Content-Range", `bytes */${size}`);
    return response.status(416).end();
  }
  let start;
  let end;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    response.setHeader("Content-Range", `bytes */${size}`);
    return response.status(416).end();
  }
  end = Math.min(end, size - 1);
  response.status(206);
  response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  response.setHeader("Content-Length", end - start + 1);
  return fs.createReadStream(file, { start, end }).pipe(response);
});

app.post(
  "/api/cloudinary/audio",
  auth,
  cloudinaryAudioUpload.single("song"),
  async (request, response) => {
    if (!CLOUDINARY_CONFIGURED) {
      return response.status(503).json({
        code: "CLOUDINARY_NOT_CONFIGURED",
        error: "Cloudinary audio storage is not configured on this server.",
      });
    }
    if (request.user.banned) {
      return response.status(403).json({
        code: "UPLOAD_RESTRICTED",
        error: "This account cannot upload new music.",
      });
    }
    if (!request.file) {
      return response.status(400).json({ error: "Choose an MP3 file." });
    }
    if (!isValidMp3Buffer(request.file.buffer)) {
      return response.status(400).json({
        code: "INVALID_MP3",
        error: "The selected file is not a valid MP3 audio file.",
      });
    }

    try {
      const uploaded = await uploadAudioBufferToCloudinary(
        request.file,
        request.user.id,
      );
      return response.status(201).json({
        url: uploaded.secure_url,
        publicId: uploaded.public_id,
        resourceType: uploaded.resource_type,
        format: uploaded.format,
        bytes: uploaded.bytes,
        duration: Number(uploaded.duration || 0),
        originalName: sanitizeText(request.file.originalname, 255),
      });
    } catch (error) {
      console.error("Cloudinary MP3 upload failed:", error.message);
      return response.status(502).json({
        code: "CLOUDINARY_UPLOAD_FAILED",
        error: "The MP3 could not be uploaded. Please try again.",
      });
    }
  },
);

app.post("/api/auth/signup", async (request, response) => {
  const email = String(request.body.email || "")
    .trim()
    .toLowerCase();
  const password = String(request.body.password || "");
  if (!/^\S+@\S+\.\S+$/.test(email))
    return response.status(400).json({ error: "Enter a valid email address." });
  if (password.length < 8)
    return response
      .status(400)
      .json({ error: "Password must be at least 8 characters." });
  const users = readUsers();
  if (users.some((item) => item.email === email))
    return response
      .status(409)
      .json({ error: "An account with that email already exists." });
  const secured = hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    email,
    passwordSalt: secured.salt,
    passwordHash: secured.hash,
    role: users.length ? "user" : "owner",
    createdAt: Date.now(),
    paid: false,
    paidAt: null,
    listenCount: 0,
    likedSongIds: [],
    warnings: [],
    adminMode: false,
    hasSeenUploadWarning: false,
    adminFailedAttempts: 0,
    adminLockedUntil: null,
    isAdminBanned: false,
  };
  const token = crypto.randomBytes(32).toString("hex");
  user.sessionTokenHash = tokenHash(token);
  users.push(user);
  await writeUsers(users);
  if (user.role === "owner") await migrateLegacyOwnership(user.id);
  response.setHeader(
    "Set-Cookie",
    `d50_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
  );
  response.status(201).json({ token, user: publicUser(user) });
});
app.post("/api/auth/login", async (request, response) => {
  const email = String(request.body.email || "")
    .trim()
    .toLowerCase();
  const user = readUsers().find((item) => item.email === email);
  if (!user || !passwordMatches(String(request.body.password || ""), user))
    return response.status(401).json({ error: "Incorrect email or password." });
  const token = crypto.randomBytes(32).toString("hex");
  normalizePremiumExpiration(user);
  user.adminMode = hasRedeemedFreeAdminCode(user) ? "free" : false;
  user.sessionTokenHash = tokenHash(token);
  await writeUsers(
    readUsers().map((item) => (item.id === user.id ? user : item)),
  );
  response.setHeader(
    "Set-Cookie",
    `d50_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
  );
  response.json({ token, user: publicUser(user) });
});
app.post("/api/auth/subscribe", (_request, response) => {
  response.status(410).json({
    code: "LEGACY_CHECKOUT_REMOVED",
    error: "This checkout route was removed. Use the verified Stripe checkout.",
  });
});
async function createCheckoutSession(request, response) {
  if (!stripe || !STRIPE_SECRET_KEY.startsWith("sk_live_")) {
    return response.status(503).json({
      code: "STRIPE_NOT_CONFIGURED",
      error: "Live Stripe checkout is not configured on this server.",
    });
  }

  const requestOrigin = `${request.protocol}://${request.get("host")}`;
  const baseUrl = APP_BASE_URL || requestOrigin;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      managed_payments: { enabled: false },
      customer_email: request.user.email,
      client_reference_id: request.user.id,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 999,
            product_data: {
              name: "D50 Premium - 30 Day Pass",
              description: "Thirty days of D50 Premium access",
            },
          },
        },
      ],
      metadata: {
        purpose: "d50_premium_30_days",
        userId: request.user.id,
        email: request.user.email,
      },
      success_url: `${baseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?checkout=cancelled`,
    });
    response.status(201).json({ id: session.id, url: session.url });
  } catch (error) {
    console.error("Stripe Checkout Session creation failed:", error.message);
    response.status(502).json({
      code: "STRIPE_UNAVAILABLE",
      error: "Stripe checkout is temporarily unavailable. Please try again.",
    });
  }
}
app.post("/create-checkout-session", auth, createCheckoutSession);
app.post("/api/create-checkout-session", auth, createCheckoutSession);
app.post("/api/auth/logout", auth, async (request, response) => {
  const users = readUsers();
  const user = users.find((item) => item.id === request.user.id);
  if (user) {
    user.sessionTokenHash = null;
    user.adminMode = false;
  }
  await writeUsers(users);
  response.setHeader(
    "Set-Cookie",
    "d50_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
  );
  response.status(204).end();
});
app.get("/api/auth/me", auth, (request, response) =>
  response.json(publicUser(request.user)),
);
app.post("/api/auth/upload-warning/acknowledge", auth, async (request, response) => {
  const users = readUsers();
  const user = users.find((item) => item.id === request.user.id);
  user.hasSeenUploadWarning = true;
  await writeUsers(users);
  response.json(publicUser(user));
});
app.post("/api/warnings/:id/acknowledge", auth, async (request, response) => {
  const users = readUsers();
  const user = users.find((item) => item.id === request.user.id);
  const warningExists = (user.warnings || []).some(
    (warning) => warning.id === request.params.id,
  );
  if (!warningExists)
    return response.status(404).json({ error: "Warning not found." });
  user.warnings = (user.warnings || []).filter(
    (warning) => warning.id !== request.params.id,
  );
  await writeUsers(users);
  response.json(publicUser(user));
});
app.post("/api/auth/upgrade", auth, async (request, response) => {
  const paymentIntentId = String(request.body?.paymentIntentId || "").trim();
  if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) {
    return response.status(403).json({
      code: "STRIPE_PAYMENT_REQUIRED",
      error: "Unauthorized: a completed live Stripe payment is required.",
    });
  }
  if (!stripe || !STRIPE_SECRET_KEY.startsWith("sk_live_")) {
    return response.status(503).json({
      code: "STRIPE_NOT_CONFIGURED",
      error: "Live Stripe checkout is not configured on this server.",
    });
  }

  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch (error) {
    console.error("Stripe PaymentIntent verification failed:", error.message);
    return response.status(403).json({
      code: "STRIPE_PAYMENT_REQUIRED",
      error: "Unauthorized: Stripe could not verify this payment.",
    });
  }

  const paymentIsValid =
    paymentIntent.status === "succeeded" &&
    paymentIntent.livemode === true &&
    paymentIntent.amount === STRIPE_PREMIUM_PRICE_CENTS &&
    paymentIntent.amount_received >= STRIPE_PREMIUM_PRICE_CENTS &&
    paymentIntent.currency === STRIPE_CURRENCY &&
    paymentIntent.metadata?.purpose === "d50_premium_30_days" &&
    paymentIntent.metadata?.userId === request.user.id;
  if (!paymentIsValid) {
    return response.status(403).json({
      code: "STRIPE_PAYMENT_REQUIRED",
      error: "Unauthorized: Stripe has not completed and verified this payment.",
    });
  }

  const users = readUsers();
  const user = users.find((item) => item.id === request.user.id);
  const redeemedBy = users.find((item) =>
    (item.stripePaymentIntentIds || []).includes(paymentIntent.id),
  );
  if (redeemedBy) {
    if (redeemedBy.id === user.id && user.paid) {
      return response.json(publicUser(user));
    }
    return response.status(409).json({
      code: "PAYMENT_ALREADY_REDEEMED",
      error: "This Stripe payment has already been redeemed.",
    });
  }

  user.paid = true;
  user.paidAt = Date.now();
  user.premiumExpiresAt = user.paidAt + PREMIUM_PERIOD_MS;
  user.autoRenew = true;
  user.subscriptionCancelledAt = null;
  user.subscriptionAccessEndsAt = null;
  user.stripePaymentIntentIds = [
    ...(user.stripePaymentIntentIds || []),
    paymentIntent.id,
  ];
  await writeUsers(users);
  response.json(publicUser(user));
});

app.post("/api/billing/create-payment-intent", auth, async (request, response) => {
  if (
    !stripe ||
    !STRIPE_SECRET_KEY.startsWith("sk_live_") ||
    !STRIPE_PUBLISHABLE_KEY.startsWith("pk_live_")
  ) {
    return response.status(503).json({
      code: "STRIPE_NOT_CONFIGURED",
      error: "Live Stripe checkout is not configured on this server.",
    });
  }
  if (
    !Number.isSafeInteger(STRIPE_PREMIUM_PRICE_CENTS) ||
    STRIPE_PREMIUM_PRICE_CENTS < 50 ||
    !/^[a-z]{3}$/.test(STRIPE_CURRENCY)
  ) {
    return response.status(503).json({
      code: "STRIPE_PRICE_NOT_CONFIGURED",
      error: "The Premium price is not configured correctly.",
    });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: STRIPE_PREMIUM_PRICE_CENTS,
      currency: STRIPE_CURRENCY,
      automatic_payment_methods: { enabled: true },
      receipt_email: request.user.email,
      description: "D50 Premium - 30 days",
      metadata: {
        purpose: "d50_premium_30_days",
        userId: request.user.id,
      },
    });
    response.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      publishableKey: STRIPE_PUBLISHABLE_KEY,
    });
  } catch (error) {
    console.error("Stripe PaymentIntent creation failed:", error.message);
    response.status(502).json({
      code: "STRIPE_UNAVAILABLE",
      error: "Stripe checkout is temporarily unavailable. Please try again.",
    });
  }
});
app.post("/api/auth/cancel-subscription", auth, async (request, response) => {
  const users = readUsers();
  const user = users.find((item) => item.id === request.user.id);
  if (!user?.paid)
    return response.status(409).json({
      error: "This account does not have an active Premium subscription.",
    });
  user.autoRenew = false;
  user.subscriptionCancelledAt = Date.now();
  user.subscriptionAccessEndsAt = user.premiumExpiresAt;
  await writeUsers(users);
  response.json(publicUser(user));
});
app.post("/api/admin/unlock", auth, async (request, response) => {
  const now = Date.now();
  const users = readUsers();
  const user = users.find((item) => item.id === request.user.id);
  if (!user || !/@gmail\.com$/i.test(String(user.email || "")))
    return response.status(403).json({
      code: "AUTHENTICATED_GMAIL_REQUIRED",
      error: "Access Denied: You must be logged in to access this feature.",
    });
  if (user.isAdminBanned)
    return response.status(403).json({
      code: "ADMIN_ACCESS_BANNED",
      error: "Admin access is permanently blocked for this account.",
    });
  const lockedUntil = Number(user.adminLockedUntil || 0);
  if (lockedUntil > now)
    return response.status(429).json({
      code: "ADMIN_ACCESS_FROZEN",
      error: "Admin access is temporarily frozen for this account.",
      lockedUntil,
      remainingMs: lockedUntil - now,
      failedAttempts: Number(user.adminFailedAttempts || 0),
    });
  if (lockedUntil) user.adminLockedUntil = null;

  const submitted = String(request.body.pin || "");
  const submittedDigest = crypto
    .createHash("sha256")
    .update(submitted)
    .digest();
  const masterDigest = crypto
    .createHash("sha256")
    .update(ADMIN_MASTER_PIN)
    .digest();
  const masterMatch = crypto.timingSafeEqual(submittedDigest, masterDigest);
  const codes = readCodes();
  const invite = masterMatch
    ? null
    : codes.find(
        (entry) =>
          entry.status === "active" &&
          String(entry.code || "").length === submitted.length &&
          crypto.timingSafeEqual(
            Buffer.from(String(entry.code || "")),
            Buffer.from(submitted),
          ),
      );
  const requestedMode = masterMatch ? "master" : invite ? "free" : null;
  if (!requestedMode) {
    user.adminFailedAttempts = Number(user.adminFailedAttempts || 0) + 1;
    user.adminMode = false;
    if (user.adminFailedAttempts >= ADMIN_BAN_STRIKES) {
      user.isAdminBanned = true;
      user.adminBannedAt = now;
      user.adminLockedUntil = null;
      await writeUsers(users);
      return response.status(403).json({
        code: "ADMIN_ACCESS_BANNED",
        error: "Admin access is permanently blocked for this account after 6 failed attempts.",
        failedAttempts: user.adminFailedAttempts,
      });
    }
    if (user.adminFailedAttempts === ADMIN_FREEZE_STRIKES) {
      user.adminLockedUntil = now + ADMIN_FREEZE_MS;
      await writeUsers(users);
      return response.status(429).json({
        code: "ADMIN_ACCESS_FROZEN",
        error: "Three failed attempts. Admin access is frozen for 15 minutes.",
        lockedUntil: user.adminLockedUntil,
        remainingMs: ADMIN_FREEZE_MS,
        failedAttempts: user.adminFailedAttempts,
      });
    }
    await writeUsers(users);
    return response.status(401).json({
      code: "INCORRECT_ADMIN_CODE",
      error: `Incorrect Admin code. ${ADMIN_BAN_STRIKES - user.adminFailedAttempts} attempts remain before a permanent Admin-access ban.`,
      failedAttempts: user.adminFailedAttempts,
    });
  }

  user.adminLockedUntil = null;
  user.adminMode = requestedMode;
  if (invite) {
    invite.status = "redeemed";
    invite.redeemedByUserId = user.id;
    invite.redeemedByEmail = user.email;
    invite.redeemedAt = Date.now();
    user.freeAdminCodeId = invite.id;
  }
  await Promise.all([writeUsers(users), invite ? writeCodes(codes) : null]);
  response.json(publicUser(user));
});

const MASTER_ADMIN_UI_FRAGMENT = `
<div id="adminHubModal" class="modal" hidden>
  <div class="modal-card admin-hub-card">
    <button class="modal-close" type="button" aria-label="Close">×</button>
    <p class="eye">MASTER ADMIN CONTROL</p>
    <h1>Reports &amp; Bans</h1>
    <div class="admin-hub-board">
      <section class="admin-hub-column reports-column">
        <div class="admin-queue-section">
          <h2>Active Report Queue</h2>
          <div id="activeReportsPanel" class="admin-hub-panel"></div>
        </div>
        <div class="admin-queue-section saved-archive-section">
          <h2>Saved Reports Archive</h2>
          <div id="savedReportsPanel" class="admin-hub-panel"></div>
        </div>
      </section>
      <section class="admin-hub-column bans-column">
        <div class="bans-column-heading">
          <h2>Active Platform Bans</h2>
          <button id="manualBanButton" class="ban-account-button" type="button">+ Ban an email</button>
        </div>
        <div id="bansPanel" class="admin-hub-panel"></div>
        <div class="admin-queue-section admin-access-blocks-section">
          <h2>Admin Access Blocks</h2>
          <div id="adminBlockedPanel" class="admin-hub-panel"></div>
        </div>
      </section>
    </div>
    <section class="admin-code-generator">
      <p class="eye">SECURE ROLE MANAGEMENT</p>
      <h2>ADMIN ACCESS CODES GENERATOR</h2>
      <form id="adminCodeForm" class="admin-code-form">
        <label>Custom invite code<input id="adminCodeInput" maxlength="64" autocomplete="off" required /></label>
        <button class="primary-button" type="submit">Create Invite Code</button>
      </form>
      <p id="adminCodeMessage" class="form-message"></p>
      <div id="adminCodesPanel" class="admin-codes-panel"></div>
    </section>
    <p id="adminHubMessage" class="form-message"></p>
  </div>
</div>
<div id="freeUploadsModal" class="modal" hidden>
  <div class="modal-card free-uploads-card">
    <button class="modal-close" type="button" aria-label="Close">×</button>
    <p class="eye">MASTER ADMIN REVIEW</p>
    <h1>Free Uploads</h1>
    <p>Preview pending tracks before publishing or denying them.</p>
    <div id="freeUploadsList" class="free-uploads-list"></div>
    <p id="freeUploadsMessage" class="form-message"></p>
    <audio id="pendingPreviewAudio" preload="metadata"></audio>
  </div>
</div>
<div id="banAccountModal" class="modal" hidden>
  <div class="modal-card ban-account-card">
    <button class="modal-close" type="button" aria-label="Close">×</button>
    <p class="eye">MASTER ADMIN MODERATION</p>
    <h1>Ban Account</h1>
    <p id="banAccountTargetText">Choose the account and record the moderation decision.</p>
    <form id="banAccountForm">
      <label id="banAccountEmailLabel">Account email<input id="banAccountEmail" type="email" autocomplete="off" required /></label>
      <label>Ban Identifier / Reference Name<input id="banAccountReference" maxlength="80" placeholder="For example: Spammer" required /></label>
      <label>Official Ban Reason<textarea id="banAccountReason" maxlength="500" placeholder="Describe the rule violation" required></textarea></label>
      <button class="primary-button">Ban this account</button>
    </form>
    <p id="banAccountMessage" class="form-message"></p>
  </div>
</div>`;

app.get("/api/admin/ui", auth, masterOnly, (_request, response) => {
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.type("html").send(MASTER_ADMIN_UI_FRAGMENT);
});

app.get("/api/admin/access-codes", auth, masterOnly, (_request, response) => {
  response.json(
    readCodes()
      .slice()
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)),
  );
});

app.post("/api/admin/access-codes", auth, masterOnly, async (request, response) => {
  const code = sanitizeText(request.body.code, 64);
  if (code.length < 4)
    return response.status(400).json({
      error: "Invite codes must contain at least 4 characters.",
    });
  if (code === ADMIN_MASTER_PIN)
    return response.status(409).json({
      error: "That code is reserved for Master Admin access.",
    });
  const codes = readCodes();
  if (codes.some((entry) => entry.code === code))
    return response.status(409).json({ error: "That invite code already exists." });
  const entry = {
    id: crypto.randomUUID(),
    code,
    status: "active",
    createdAt: Date.now(),
    createdByUserId: request.user.id,
  };
  codes.push(entry);
  await writeCodes(codes);
  response.status(201).json(entry);
});

app.delete("/api/admin/access-codes/:id", auth, masterOnly, async (request, response) => {
  const codes = readCodes();
  const code = codes.find((entry) => entry.id === request.params.id);
  if (!code)
    return response.status(404).json({ error: "Invite code not found." });
  const users = readUsers();
  users.forEach((account) => {
    if (account.freeAdminCodeId !== code.id) return;
    account.adminMode = false;
    delete account.freeAdminCodeId;
  });
  await Promise.all([
    writeCodes(codes.filter((entry) => entry.id !== code.id)),
    writeUsers(users),
  ]);
  response.status(204).end();
});
app.post("/api/reports", auth, reporterOnly, async (request, response) => {
  const itemType = sanitizeText(request.body.itemType, 30);
  const itemId = sanitizeText(request.body.itemId, 80);
  const submittedItemName = sanitizeText(request.body.itemName, 120);
  const reason = sanitizeText(request.body.reason, 500);
  if (!itemId || !submittedItemName || !["song", "category"].includes(itemType))
    return response.status(400).json({
      error: "Choose a valid song or category to report.",
    });
  if (!reason)
    return response.status(400).json({
      error: "Tell us why you are reporting this content.",
    });
  const reportedItem =
    itemType === "song"
      ? readSongs().find((song) => song.id === itemId)
      : readCategories().find((category) => category.id === itemId);
  if (!reportedItem)
    return response.status(404).json({
      error: `That ${itemType} is no longer available.`,
    });
  const itemName = itemType === "song" ? reportedItem.title : reportedItem.name;
  const reportedUserId =
    reportedItem.ownerId || reportedItem.uploadedBy || null;
  const reportedUser = reportedUserId
    ? readUsers().find((item) => item.id === reportedUserId)
    : null;
  const type = itemType === "song" ? "broken-track" : "incorrect-category";
  const message = reason;
  const report = {
    id: crypto.randomUUID(),
    type: ["broken-track", "incorrect-category", "bad-behavior"].includes(type)
      ? type
      : "other",
    message,
    itemType,
    itemId,
    itemName,
    reason,
    songId: itemType === "song" ? itemId : null,
    reportedUserId,
    reportedUserEmail: reportedUser?.email || null,
    reporterId: request.user.id,
    reporterEmail: request.user.email,
    remembered: false,
    createdAt: Date.now(),
  };
  const reports = readReports();
  reports.push(report);
  await writeReports(reports);
  response.status(201).json(report);
});
app.get("/api/reports", auth, masterOnly, (request, response) => {
  const users = readUsers();
  const emailById = new Map(users.map((item) => [item.id, item.email]));
  response.json(
    readReports()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((report) => ({
        ...report,
        reportedUserEmail:
          report.reportedUserEmail ||
          emailById.get(report.reportedUserId) ||
          null,
      })),
  );
});
app.patch("/api/admin/boost", auth, masterOnly, async (request, response) => {
  const itemType = sanitizeText(request.body.itemType, 20);
  const itemId = sanitizeText(request.body.itemId, 80);
  const tier = sanitizeText(request.body.tier, 10);
  if (!itemId || !["song", "category"].includes(itemType))
    return response.status(400).json({ error: "Choose a valid item." });
  if (!['gold', 'silver'].includes(tier))
    return response.status(400).json({ error: "Choose Gold or Silver Boost." });
  const records = itemType === "song" ? readSongs() : readCategories();
  const item = records.find((record) => record.id === itemId);
  if (!item)
    return response.status(404).json({ error: "That item no longer exists." });
  const field = tier === "gold" ? "goldBoostUntil" : "silverBoostUntil";
  const flag = tier === "gold" ? "hasGold" : "hasSilver";
  const active =
    Boolean(item[flag] || Number(item[field]) > Date.now()) &&
    (!item[field] || Number(item[field]) > Date.now());
  item[flag] = !active;
  item[field] = active ? null : Date.now() + 5 * 60 * 60 * 1000;
  if (itemType === "song") await writeSongs(records);
  else await writeCategories(records);
  if (!active && item.ownerId) {
    const users = readUsers();
    const owner = users.find((candidate) => candidate.id === item.ownerId);
    if (owner) {
      const awardField =
        tier === "gold" ? "goldFeatureAwards" : "silverFeatureAwards";
      const countField =
        tier === "gold" ? "adminFeatures" : "adminSilverFeatures";
      const awardKey = `${itemType}:${item.id}`;
      const awards = new Set(
        Array.isArray(owner[awardField]) ? owner[awardField] : [],
      );
      if (!awards.has(awardKey)) {
        awards.add(awardKey);
        owner[awardField] = [...awards];
        owner[countField] = Number(owner[countField] || 0) + 1;
        await writeUsers(users);
      }
    }
  }
  response.json(
    itemType === "song"
      ? publicSong(item, request.user)
      : publicCategory(item, request.user),
  );
});
app.patch(
  "/api/reports/:id/remember",
  auth,
  masterOnly,
  async (request, response) => {
    const reports = readReports();
    const report = reports.find((item) => item.id === request.params.id);
    if (!report)
      return response.status(404).json({ error: "Report not found." });
    report.remembered = Boolean(request.body.remembered);
    report.updatedAt = Date.now();
    await writeReports(reports);
    response.json(report);
  },
);
app.delete("/api/reports/:id", auth, masterOnly, async (request, response) => {
  const reports = readReports();
  const index = reports.findIndex((item) => item.id === request.params.id);
  if (index === -1)
    return response.status(404).json({ error: "Report not found." });
  reports.splice(index, 1);
  await writeReports(reports);
  response.json({ deleted: true, id: request.params.id });
});
app.get("/api/admin/reports-bans", auth, masterOnly, (request, response) => {
  const users = readUsers();
  const bannedUsers = users
    .filter((user) => user.banned)
    .map((user) => ({
      id: user.id,
      email: user.email,
      bannedAt: user.bannedAt || null,
      banReference: user.banReference || "Banned account",
      banReason: user.banReason || "No reason recorded",
    }));
  const adminBlockedUsers = users
    .filter(
      (user) =>
        user.isAdminBanned || Number(user.adminLockedUntil || 0) > Date.now(),
    )
    .map((user) => ({
      id: user.id,
      email: user.email,
      failedAttempts: Number(user.adminFailedAttempts || 0),
      isAdminBanned: Boolean(user.isAdminBanned),
      adminLockedUntil: Number(user.adminLockedUntil || 0) || null,
      adminBannedAt: Number(user.adminBannedAt || 0) || null,
    }));
  response.json({
    reports: readReports().sort((a, b) => b.createdAt - a.createdAt),
    bannedUsers,
    adminBlockedUsers,
  });
});
app.post("/api/admin/users/ban", auth, masterOnly, async (request, response) => {
  const userId = sanitizeText(request.body.userId, 80);
  const email = String(request.body.email || "").trim().toLowerCase();
  const banReference = sanitizeText(request.body.banReference, 80);
  const banReason = sanitizeText(request.body.banReason, 500);
  if (!banReference || !banReason)
    return response.status(400).json({
      error: "Enter both a ban reference name and an official ban reason.",
    });
  const users = readUsers();
  const user = users.find(
    (item) => (userId && item.id === userId) || (email && item.email === email),
  );
  if (!user) return response.status(404).json({ error: "User not found." });
  if (user.id === request.user.id)
    return response.status(400).json({ error: "You cannot ban your own account." });
  user.banned = true;
  user.bannedAt = Date.now();
  user.banReference = banReference;
  user.banReason = banReason;
  user.adminMode = false;
  await writeUsers(users);
  response.json({
    id: user.id,
    email: user.email,
    banned: true,
    bannedAt: user.bannedAt,
    banReference: user.banReference,
    banReason: user.banReason,
  });
});
app.post(
  "/api/admin/users/:id/unban",
  auth,
  masterOnly,
  async (request, response) => {
    const users = readUsers();
    const user = users.find((item) => item.id === request.params.id);
    if (!user) return response.status(404).json({ error: "User not found." });
    user.banned = false;
    user.bannedAt = null;
    user.banReference = null;
    user.banReason = null;
    await writeUsers(users);
    response.json({ id: user.id, email: user.email, banned: false });
  },
);

app.get("/api/songs", optionalAuth, async (request, response) => {
  const requestedPage = Number.parseInt(request.query.page, 10);
  const requestedLimit = Number.parseInt(request.query.limit, 10);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0
    ? requestedPage
    : 1;
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 100)
    : 20;
  const offset = (page - 1) * limit;

  let pageSongs;
  let total;
  if (DATABASE_PROVIDER === "postgres") {
    const [songsResult, countResult] = await Promise.all([
      postgres.query(
        `SELECT data AS song
         FROM songs
         WHERE status = 'approved'
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      postgres.query(
        `SELECT COUNT(*)::integer AS total
         FROM songs
         WHERE status = 'approved'`,
      ),
    ]);
    pageSongs = songsResult.rows.map((row) => row.song);
    total = Number(countResult.rows[0]?.total || 0);
  } else {
    const approvedSongs = readSongs()
      .filter((song) => !song.status || song.status === "approved")
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    total = approvedSongs.length;
    pageSongs = approvedSongs.slice(offset, offset + limit);
  }

  response.setHeader("X-Page", String(page));
  response.setHeader("X-Limit", String(limit));
  response.setHeader("X-Total-Count", String(total));
  response.setHeader("X-Has-More", String(offset + pageSongs.length < total));
  response.json(pageSongs.map((song) => publicSong(song, request.user)));
});

app.get("/api/my-uploads", auth, (request, response) => {
  response.json(
    readSongs()
      .filter(
        (song) =>
          song.ownerId === request.user.id ||
          song.uploadedBy === request.user.id,
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((song) => publicSong(song, request.user)),
  );
});

app.get(
  "/api/admin/pending-uploads",
  auth,
  masterOnly,
  (request, response) => {
    const pending = readSongs()
      .filter((song) => song.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((song) => publicSong(song, request.user));
    response.json(pending);
  },
);

app.patch(
  "/api/admin/pending-uploads/:id/approve",
  auth,
  masterOnly,
  async (request, response) => {
    const songs = readSongs();
    const song = songs.find((item) => item.id === request.params.id);
    if (!song || song.status !== "pending")
      return response.status(404).json({ error: "Pending upload not found." });
    const owner = readUsers().find(
      (user) => user.id === (song.ownerId || song.uploadedBy),
    );
    if (owner && !accessFor(owner).paid && !isMasterAdmin(owner)) {
      const capacity = uploadCapacityFor(owner, songs);
      if (
        capacity.freeApprovedUploadCount +
          reservationCount(approvalReservations, owner.id) >=
        FREE_APPROVED_UPLOAD_LIMIT
      )
        return response.status(409).json({
          code: "FREE_APPROVED_CAPACITY_FULL",
          error:
            "This Free Account already has 100 live approved songs. It must delete an approved song before another pending track can be approved.",
        });
    }
    const releaseApproval = owner
      ? reserveCapacity(approvalReservations, owner.id)
      : () => {};
    song.status = "approved";
    song.approvedAt = Date.now();
    song.approvedBy = request.user.id;
    try {
      await writeSongs(songs);
    } finally {
      releaseApproval();
    }
    response.json(publicSong(song, request.user));
  },
);

app.delete(
  "/api/admin/pending-uploads/:id",
  auth,
  masterOnly,
  async (request, response) => {
    const songs = readSongs();
    const song = songs.find((item) => item.id === request.params.id);
    if (!song || song.status !== "pending")
      return response.status(404).json({ error: "Pending upload not found." });
    const audioPath = path.join(MUSIC_DIR, path.basename(song.filename || ""));
    if (song.filename) await fs.promises.unlink(audioPath).catch(() => {});
    if (song.coverFilename) {
      const coverPath = path.join(
        COVERS_DIR,
        path.basename(song.coverFilename),
      );
      await fs.promises.unlink(coverPath).catch(() => {});
    }
    await writeSongs(songs.filter((item) => item.id !== song.id));
    response.status(204).end();
  },
);
app.post("/api/listens/:id", auth, async (request, response) => {
  if (!readSongs().some((song) => song.id === request.params.id))
    return response.status(404).json({ error: "Song not found." });
  const users = readUsers();
  const user = users.find((item) => item.id === request.user.id);
  const access = accessFor(user);
  if (!access.premium && user.listenCount >= FREE_LISTEN_LIMIT)
    return response
      .status(403)
      .json({ code: "FREE_LIMIT", error: "Free listening limit reached." });
  if (!access.premium) user.listenCount = Number(user.listenCount || 0) + 1;
  await writeUsers(users);
  response.json(publicUser(user));
});
app.post(
  "/api/songs",
  auth,
  upload.fields([
    { name: "song", maxCount: 1 },
    { name: "cover", maxCount: 1 },
  ]),
  async (request, response) => {
    if (request.user.banned) {
      await removeUploadedFiles(request.files);
      return response.status(403).json({
        code: "UPLOAD_RESTRICTED",
        error: "This account cannot upload new music.",
      });
    }
    const audioFile = request.files?.song?.[0];
    const coverFile = request.files?.cover?.[0];
    if (!audioFile)
      return response.status(400).json({ error: "Choose an audio file." });
    let audioIsValid;
    let coverIsValid;
    try {
      audioIsValid = await hasValidSignature(audioFile, "audio");
      coverIsValid = coverFile
        ? await hasValidSignature(coverFile, "cover")
        : true;
    } catch (error) {
      await removeUploadedFiles(request.files);
      throw error;
    }
    if (!audioIsValid || !coverIsValid || coverFile?.size > COVER_LIMIT) {
      await removeUploadedFiles(request.files);
      return response.status(400).json({
        error:
          coverFile?.size > COVER_LIMIT
            ? "The cover image is larger than 2 MB."
            : !audioIsValid
              ? "The selected song is not a valid MP3, WAV, or M4A file."
              : "The selected cover is not a valid JPG or PNG image.",
      });
    }
    const canPublishImmediately = accessFor(request.user).canManage;
    const requestedCategoryIds = !canPublishImmediately
      ? []
      : Array.isArray(request.body.categoryIds)
      ? request.body.categoryIds
      : request.body.categoryIds
        ? [request.body.categoryIds]
        : [];
    const songs = readSongs();
    if (!canPublishImmediately) {
      const capacity = uploadCapacityFor(request.user, songs);
      if (capacity.freeApprovedUploadCount >= FREE_APPROVED_UPLOAD_LIMIT) {
        await removeUploadedFiles(request.files);
        return response.status(409).json({
          code: "FREE_APPROVED_CAPACITY_FULL",
          error:
            "Your live approved catalog is full (Max 100). Delete an approved song to unlock a new upload slot.",
        });
      }
      if (
        capacity.freePendingUploadCount +
          reservationCount(pendingUploadReservations, request.user.id) >=
        FREE_PENDING_UPLOAD_LIMIT
      ) {
        await removeUploadedFiles(request.files);
        return response.status(409).json({
          code: "FREE_PENDING_QUEUE_FULL",
          error:
            "Your pending review queue is full (Max 5). Wait for Admin approval.",
        });
      }
    }
    const categoryValidation = validateCategoryAssignment(
      requestedCategoryIds,
      request.user,
      songs,
    );
    if (categoryValidation.error) {
      await removeUploadedFiles(request.files);
      return response.status(categoryValidation.status).json({
        code: categoryValidation.code,
        error: categoryValidation.error,
      });
    }
    const releasePendingReservation = !canPublishImmediately
      ? reserveCapacity(pendingUploadReservations, request.user.id)
      : () => {};
    let cloudAudio = null;
    if (CLOUDINARY_CONFIGURED) {
      try {
        cloudAudio = await uploadAudioBufferToCloudinary(audioFile, request.user.id);
      } catch (error) {
        await removeUploadedFiles(request.files);
        releasePendingReservation();
        console.error("Cloudinary audio upload failed:", error.message);
        return response.status(502).json({
          code: "CLOUDINARY_UPLOAD_FAILED",
          error: "The audio file could not be stored. Please try again.",
        });
      }
    }
    const song = {
      id: crypto.randomUUID(),
      title:
        sanitizeText(
          request.body.title || path.parse(audioFile.originalname).name,
          120,
        ) || "Untitled track",
      originalName: sanitizeText(audioFile.originalname, 255),
      filename: audioFile.filename || null,
      mimeType: audioFile.mimetype,
      size: audioFile.size,
      createdAt: Date.now(),
      ownerId: request.user.id,
      uploadedBy: request.user.id,
      uploaderName: request.user.email,
      categoryIds: categoryValidation.categoryIds,
      likedBy: [],
      url: cloudAudio?.secure_url || `/music/${encodeURIComponent(audioFile.filename)}`,
      cloudinaryPublicId: cloudAudio?.public_id || null,
      coverFilename: coverFile?.filename || null,
      coverUrl: coverFile
        ? `/covers/${encodeURIComponent(coverFile.filename)}`
        : null,
      status: canPublishImmediately ? "approved" : "pending",
    };
    songs.push(song);
    try {
      await writeSongs(songs);
    } catch (error) {
      await removeUploadedFiles(request.files);
      if (cloudAudio?.public_id)
        await cloudinary.uploader.destroy(cloudAudio.public_id, {
          resource_type: "video",
        }).catch(() => {});
      throw error;
    } finally {
      releasePendingReservation();
    }
    response.status(201).json({
      ...publicSong(song, request.user),
      pendingReview: !canPublishImmediately,
      uploadCapacity: uploadCapacityFor(request.user, songs),
    });
  },
);
app.patch(
  "/api/songs/:id/cover",
  auth,
  manage,
  upload.single("cover"),
  async (request, response) => {
    const coverFile = request.file;
    if (!coverFile)
      return response.status(400).json({ error: "Choose a JPG or PNG cover." });
    const songs = readSongs();
    const song = songs.find((item) => item.id === request.params.id);
    const allowed =
      song &&
      (isMasterAdmin(request.user) ||
        song.ownerId === request.user.id ||
        song.uploadedBy === request.user.id);
    if (!allowed) {
      await fs.promises.unlink(coverFile.path).catch(() => {});
      return response.status(song ? 403 : 404).json({
        code: song ? "SONG_NOT_OWNED" : "SONG_NOT_FOUND",
        error: song
          ? "You can only change artwork on songs that you uploaded."
          : "Song not found.",
      });
    }
    let coverIsValid = false;
    try {
      coverIsValid = await hasValidSignature(coverFile, "cover");
    } catch (error) {
      await fs.promises.unlink(coverFile.path).catch(() => {});
      throw error;
    }
    if (!coverIsValid || coverFile.size > COVER_LIMIT) {
      await fs.promises.unlink(coverFile.path).catch(() => {});
      return response.status(400).json({
        error:
          coverFile.size > COVER_LIMIT
            ? "The cover image is larger than 2 MB."
            : "The selected cover is not a valid JPG or PNG image.",
      });
    }
    const previousCover = song.coverFilename
      ? path.join(COVERS_DIR, path.basename(song.coverFilename))
      : null;
    song.coverFilename = coverFile.filename;
    song.coverUrl = `/covers/${encodeURIComponent(coverFile.filename)}`;
    try {
      await writeSongs(songs);
    } catch (error) {
      await fs.promises.unlink(coverFile.path).catch(() => {});
      throw error;
    }
    if (previousCover && previousCover !== coverFile.path)
      await fs.promises.unlink(previousCover).catch(() => {});
    response.json(publicSong(song, request.user));
  },
);
app.delete("/api/songs/:id", auth, async (request, response) => {
  const songs = readSongs();
  const song = songs.find((item) => item.id === request.params.id);
  if (!song) return response.status(404).json({ error: "Song not found." });
  const isMasterAdmin = accessFor(request.user).adminMode === "master";
  const contentOwnerId = song.ownerId || song.uploadedBy;
  const deletingAnotherUsersSong = contentOwnerId !== request.user.id;
  if (
    !isMasterAdmin &&
    song.ownerId !== request.user.id &&
    song.uploadedBy !== request.user.id
  )
    return response
      .status(403)
      .json({ error: "Only the owner or uploader can delete this song." });
  const moderationReason = sanitizeText(request.body?.reason, 500);
  if (isMasterAdmin && deletingAnotherUsersSong && !moderationReason)
    return response.status(400).json({
      code: "MODERATION_REASON_REQUIRED",
      error: "Enter a reason for removing another user's content.",
    });
  const users = readUsers();
  if (isMasterAdmin && deletingAnotherUsersSong) {
    const contentOwner = users.find((user) => user.id === contentOwnerId);
    if (contentOwner) {
      contentOwner.warnings = Array.isArray(contentOwner.warnings)
        ? contentOwner.warnings
        : [];
      contentOwner.warnings.push({
        id: crypto.randomUUID(),
        message: moderationReason,
        contentTitle: song.title,
        createdAt: Date.now(),
        issuedBy: request.user.id,
      });
      await writeUsers(users);
    }
  }
  if (song.filename) {
    const safePath = path.join(MUSIC_DIR, path.basename(song.filename));
    if (fs.existsSync(safePath)) fs.unlinkSync(safePath);
  }
  if (song.cloudinaryPublicId && CLOUDINARY_CONFIGURED) {
    await cloudinary.uploader.destroy(song.cloudinaryPublicId, {
      resource_type: "video",
    }).catch((error) => console.error("Cloudinary delete failed:", error.message));
  }
  if (song.coverFilename) {
    const safeCoverPath = path.join(
      COVERS_DIR,
      path.basename(song.coverFilename),
    );
    if (fs.existsSync(safeCoverPath)) fs.unlinkSync(safeCoverPath);
  }
  await writeSongs(songs.filter((item) => item.id !== song.id));
  users.forEach(
    (user) =>
      (user.likedSongIds = (user.likedSongIds || []).filter(
        (id) => id !== song.id,
      )),
  );
  await writeUsers(users);
  response.status(204).end();
});
app.patch("/api/songs/:id/like", auth, premium, async (request, response) => {
  const songs = readSongs();
  const song = songs.find((item) => item.id === request.params.id);
  if (!song) return response.status(404).json({ error: "Song not found." });
  const likedBy = new Set(Array.isArray(song.likedBy) ? song.likedBy : []);
  request.body.liked
    ? likedBy.add(request.user.id)
    : likedBy.delete(request.user.id);
  song.likedBy = [...likedBy];
  await writeSongs(songs);
  response.json(publicSong(song, request.user));
});
app.get("/api/categories", optionalAuth, (request, response) => {
  const users = readUsers();
  response.json(
    readCategories()
      .filter((category) => categoryVisibleTo(category, request.user, users))
      .map((category) => publicCategory(category, request.user)),
  );
});
app.post(
  "/api/categories",
  auth,
  categoryCreator,
  upload.single("categoryCover"),
  async (request, response) => {
    const coverFile = request.file;
    const name = sanitizeText(request.body.name, 50);
    if (!name) {
      if (coverFile) await fs.promises.unlink(coverFile.path).catch(() => {});
      return response.status(400).json({ error: "Category name is required." });
    }
    const items = readCategories();
    if (
      !isMasterAdmin(request.user) &&
      items.filter((category) => owns(category, request.user)).length >=
        PREMIUM_CATEGORY_LIMIT
    ) {
      if (coverFile) await fs.promises.unlink(coverFile.path).catch(() => {});
      return response.status(409).json({
        code: "CATEGORY_LIMIT",
        error: "You have reached your limit of 5 custom categories!",
      });
    }
    if (coverFile) {
      let coverIsValid = false;
      try {
        coverIsValid = await hasValidSignature(coverFile, "cover");
      } catch (error) {
        await fs.promises.unlink(coverFile.path).catch(() => {});
        throw error;
      }
      if (!coverIsValid || coverFile.size > COVER_LIMIT) {
        await fs.promises.unlink(coverFile.path).catch(() => {});
        return response.status(400).json({
          error:
            coverFile.size > COVER_LIMIT
              ? "The category cover is larger than 2 MB."
              : "The category cover must be a valid JPG or PNG image.",
        });
      }
    }
    const category = {
      id: crypto.randomUUID(),
      name,
      ownerId: request.user.id,
      likedBy: [],
      coverFilename: coverFile?.filename || null,
      coverUrl: coverFile
        ? `/category-covers/${encodeURIComponent(coverFile.filename)}`
        : null,
    };
    items.push(category);
    try {
      await writeCategories(items);
    } catch (error) {
      if (coverFile) await fs.promises.unlink(coverFile.path).catch(() => {});
      throw error;
    }
    response.status(201).json(publicCategory(category, request.user));
  },
);
app.patch(
  "/api/categories/:id/cover",
  auth,
  manage,
  upload.single("categoryCover"),
  async (request, response) => {
    const coverFile = request.file;
    if (!coverFile)
      return response.status(400).json({ error: "Choose a JPG or PNG cover." });
    const categories = readCategories();
    const category = categories.find((item) => item.id === request.params.id);
    if (
      !category ||
      (!owns(category, request.user) && !isMasterAdmin(request.user))
    ) {
      await fs.promises.unlink(coverFile.path).catch(() => {});
      return response.status(category ? 403 : 404).json({
        code: category ? "CATEGORY_NOT_OWNED" : "CATEGORY_NOT_FOUND",
        error: category
          ? "You can only change covers on categories that you created."
          : "Category not found.",
      });
    }
    let coverIsValid = false;
    try {
      coverIsValid = await hasValidSignature(coverFile, "cover");
    } catch (error) {
      await fs.promises.unlink(coverFile.path).catch(() => {});
      throw error;
    }
    if (!coverIsValid || coverFile.size > COVER_LIMIT) {
      await fs.promises.unlink(coverFile.path).catch(() => {});
      return response.status(400).json({
        error:
          coverFile.size > COVER_LIMIT
            ? "The category cover is larger than 2 MB."
            : "The category cover must be a valid JPG or PNG image.",
      });
    }
    const previousCover = category.coverFilename
      ? path.join(CATEGORY_COVERS_DIR, path.basename(category.coverFilename))
      : null;
    category.coverFilename = coverFile.filename;
    category.coverUrl = `/category-covers/${encodeURIComponent(coverFile.filename)}`;
    try {
      await writeCategories(categories);
    } catch (error) {
      await fs.promises.unlink(coverFile.path).catch(() => {});
      throw error;
    }
    if (previousCover && previousCover !== coverFile.path)
      await fs.promises.unlink(previousCover).catch(() => {});
    response.json(publicCategory(category, request.user));
  },
);
app.patch(
  "/api/categories/:id/like",
  auth,
  premium,
  async (request, response) => {
    const categories = readCategories();
    const category = categories.find((item) => item.id === request.params.id);
    if (!category || !categoryVisibleTo(category, request.user))
      return response.status(404).json({ error: "Category not found." });
    const likedBy = new Set(
      Array.isArray(category.likedBy) ? category.likedBy : [],
    );
    const wantsLike = Boolean(request.body.liked);
    if (wantsLike && !likedBy.has(request.user.id)) {
      const savedCategoryCount = categories.reduce(
        (total, item) =>
          total +
          (Array.isArray(item.likedBy) &&
          item.likedBy.includes(request.user.id)
            ? 1
            : 0),
        0,
      );
      if (savedCategoryCount >= 10) {
        return response.status(409).json({
          code: "CATEGORY_LIBRARY_LIMIT",
          error:
            "Your category library is full. Remove one of your 10 saved categories before adding another.",
        });
      }
    }
    wantsLike
      ? likedBy.add(request.user.id)
      : likedBy.delete(request.user.id);
    category.likedBy = [...likedBy];
    await writeCategories(categories);
    response.json(publicCategory(category, request.user));
  },
);
app.delete("/api/categories/:id", auth, async (request, response) => {
  const categories = readCategories();
  const category = categories.find((item) => item.id === request.params.id);
  if (!category)
    return response.status(404).json({ error: "Category not found." });
  const isMasterAdmin = accessFor(request.user).adminMode === "master";
  if (!owns(category, request.user) && !isMasterAdmin)
    return response
      .status(403)
      .json({ error: "You can only delete your own categories." });
  await writeCategories(categories.filter((item) => item.id !== category.id));
  if (category.coverFilename) {
    const safeCoverPath = path.join(
      CATEGORY_COVERS_DIR,
      path.basename(category.coverFilename),
    );
    await fs.promises.unlink(safeCoverPath).catch(() => {});
  }
  const songs = readSongs();
  songs.forEach((song) => {
    song.categoryIds = (song.categoryIds || []).filter(
      (id) => id !== category.id,
    );
  });
  await writeSongs(songs);
  response.status(204).end();
});
app.patch(
  "/api/songs/:id/categories",
  auth,
  manage,
  async (request, response) => {
    const songs = readSongs(),
      song = songs.find((item) => item.id === request.params.id);
    if (!song) return response.status(404).json({ error: "Song not found." });
    const requestedCategoryIds = Array.isArray(request.body.categoryIds)
      ? request.body.categoryIds
      : [];
    const validation = validateCategoryAssignment(
      requestedCategoryIds,
      request.user,
      songs,
      song,
    );
    if (validation.error)
      return response
        .status(validation.status)
        .json({ code: validation.code, error: validation.error });
    const manageableIds = new Set(
      categoriesUserCanManage(request.user).map((category) => category.id),
    );
    const protectedCategoryIds = (song.categoryIds || []).filter(
      (id) => !manageableIds.has(id),
    );
    song.categoryIds = [
      ...new Set([...protectedCategoryIds, ...validation.categoryIds]),
    ];
    await writeSongs(songs);
    response.json(song);
  },
);

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
    error:
      error.code === "LIMIT_FILE_SIZE"
        ? "Audio files must be 15 MB or smaller; covers must be 2 MB or smaller."
        : error.message || "Request failed.",
  });
});
storageReady
  .then(async () => {
    const users = readUsers();
    const originalOwner =
      users.find((user) => user.role === "owner") || users[0];
    await migrateLegacyOwnership(originalOwner?.id);
    await migrateSongLikes();
    await migrateUserProfileFlags();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`D50 server is live on port ${PORT}`);
      console.log(
        DATABASE_PROVIDER === "postgres"
          ? "Songs and accounts are stored permanently in PostgreSQL"
          : `Songs and accounts are stored locally in ${DATA_DIR}`,
      );
    });
  })
  .catch((error) => {
    console.error("D50 could not initialize its database:", error);
    process.exitCode = 1;
  });
