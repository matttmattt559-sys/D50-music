const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const root = path.join(__dirname, "..");
const accountId = String(process.env.R2_ACCOUNT_ID || "").trim();
const bucket = String(process.env.R2_BUCKET_NAME || "").trim();
const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || "").trim();
const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || "").trim();
const publicUrl = String(process.env.R2_DEV_URL || "").trim().replace(/\/$/, "");
const appBaseUrl = String(process.env.APP_BASE_URL || "").trim().replace(/\/$/, "");

function validPublicUrl() {
  try {
    const url = new URL(publicUrl);
    return url.protocol === "https:" && url.hostname.endsWith(".r2.dev") && url.hostname !== "r2.dev";
  } catch {
    return false;
  }
}

if (!accountId || !bucket || !accessKeyId || !secretAccessKey || !validPublicUrl()) {
  throw new Error(
    "Set R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and the complete pub-….r2.dev R2_DEV_URL first.",
  );
}

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

function sourceUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/") && appBaseUrl) return `${appBaseUrl}${raw}`;
  return null;
}

function extensionFor(url, contentType) {
  const pathname = new URL(url).pathname;
  const extension = path.extname(pathname).toLowerCase();
  if (/^\.(mp3|wav|m4a|jpg|jpeg|png)$/.test(extension)) return extension;
  const types = {
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mp4": ".m4a",
    "image/jpeg": ".jpg",
    "image/png": ".png",
  };
  return types[String(contentType || "").split(";")[0].toLowerCase()] || "";
}

async function copyUrl(urlValue, folder, ownerId) {
  const url = sourceUrl(urlValue);
  if (!url || url.startsWith(`${publicUrl}/`)) return null;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const body = Buffer.from(await response.arrayBuffer());
  const key = `${folder}/${Date.now()}-${ownerId || "legacy"}-${crypto.randomUUID()}${extensionFor(url, contentType)}`;
  await r2.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ContentLength: body.length,
    CacheControl: "public, max-age=31536000, immutable",
  }));
  return {
    key,
    url: `${publicUrl}/${key.split("/").map(encodeURIComponent).join("/")}`,
  };
}

async function migrateSong(song) {
  const audio = await copyUrl(song.url, "audio", song.ownerId || song.uploadedBy);
  const cover = await copyUrl(song.coverUrl, "covers", song.ownerId || song.uploadedBy);
  if (audio) {
    song.url = audio.url;
    song.r2AudioKey = audio.key;
    delete song.cloudinaryPublicId;
    song.filename = null;
  }
  if (cover) {
    song.coverUrl = cover.url;
    song.r2CoverKey = cover.key;
    song.coverFilename = null;
  }
  return Boolean(audio || cover);
}

async function migratePostgres(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
  });
  let changedSongs = 0;
  let changedCategories = 0;
  try {
    const songs = await pool.query("SELECT id, data FROM songs ORDER BY created_at ASC");
    for (const row of songs.rows) {
      const song = row.data;
      if (!(await migrateSong(song))) continue;
      await pool.query(
        "UPDATE songs SET url = $2, data = $3::jsonb, updated_at = NOW() WHERE id = $1",
        [row.id, song.url, JSON.stringify(song)],
      );
      changedSongs += 1;
      console.log(`Migrated song: ${song.title || row.id}`);
    }
    const result = await pool.query("SELECT value FROM d50_documents WHERE name = 'categories'");
    const categories = result.rowCount && Array.isArray(result.rows[0].value) ? result.rows[0].value : [];
    for (const category of categories) {
      const cover = await copyUrl(category.coverUrl, "category-covers", category.ownerId);
      if (!cover) continue;
      category.coverUrl = cover.url;
      category.r2CoverKey = cover.key;
      category.coverFilename = null;
      changedCategories += 1;
    }
    if (changedCategories)
      await pool.query(
        "UPDATE d50_documents SET value = $1::jsonb, updated_at = NOW() WHERE name = 'categories'",
        [JSON.stringify(categories)],
      );
  } finally {
    await pool.end();
  }
  return { changedSongs, changedCategories };
}

async function migrateLocal() {
  const dataDir = process.env.D50_DATA_DIR || path.join(root, "data");
  const songsPath = path.join(dataDir, "songs.json");
  const categoriesPath = path.join(dataDir, "categories.json");
  const songs = JSON.parse(fs.readFileSync(songsPath, "utf8"));
  const categories = JSON.parse(fs.readFileSync(categoriesPath, "utf8"));
  let changedSongs = 0;
  let changedCategories = 0;
  for (const song of songs) if (await migrateSong(song)) changedSongs += 1;
  for (const category of categories) {
    const cover = await copyUrl(category.coverUrl, "category-covers", category.ownerId);
    if (!cover) continue;
    category.coverUrl = cover.url;
    category.r2CoverKey = cover.key;
    category.coverFilename = null;
    changedCategories += 1;
  }
  fs.writeFileSync(songsPath, `${JSON.stringify(songs, null, 2)}\n`);
  fs.writeFileSync(categoriesPath, `${JSON.stringify(categories, null, 2)}\n`);
  return { changedSongs, changedCategories };
}

(async () => {
  const result = process.env.DATABASE_URL
    ? await migratePostgres(process.env.DATABASE_URL)
    : await migrateLocal();
  console.log(`R2 migration complete: ${result.changedSongs} songs and ${result.changedCategories} categories updated.`);
})().catch((error) => {
  console.error("R2 migration failed:", error.message);
  process.exitCode = 1;
});
