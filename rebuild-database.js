#!/usr/bin/env node
"use strict";

// One-time D50 recovery from R2. Run with no arguments to preview, then --apply.
// Original titles, song IDs, likes and category assignments are not stored in R2.
const crypto = require("crypto");
const path = require("path");
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { Pool } = require("pg");

const env = (name) => String(process.env[name] || "").trim();
const required = ["DATABASE_URL", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_DEV_URL"];
const missing = required.filter((name) => !env(name));
if (missing.length) throw new Error(`Missing Render environment variables: ${missing.join(", ")}`);
const bucket = env("R2_BUCKET_NAME") || "d50-music-vault";
const publicBase = env("R2_DEV_URL").replace(/\/+$/, "");
const publicUrl = new URL(publicBase);
if (publicUrl.protocol !== "https:" || !publicUrl.hostname.endsWith(".r2.dev") || publicUrl.hostname === "r2.dev")
  throw new Error("R2_DEV_URL must be the complete https://pub-….r2.dev address, not https://r2.dev.");
const apply = process.argv.includes("--apply");
if (process.argv.some((arg) => !["--apply", "--help"].includes(arg)))
  throw new Error("Usage: node rebuild-database.js [--apply]");
if (process.argv.includes("--help")) {
  console.log("Preview: node rebuild-database.js\nWrite once: node rebuild-database.js --apply");
  process.exit(0);
}

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") },
});
const db = new Pool({
  connectionString: env("DATABASE_URL"),
  ssl: env("NODE_ENV") === "production" ? { rejectUnauthorized: false } : undefined,
});
const idFor = (kind, key) => {
  const hex = crypto.createHash("sha256").update(`d50-restore:${kind}:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const mediaUrl = (key) => `${publicBase}/${key.split("/").map(encodeURIComponent).join("/")}`;
const audioExt = new Set([".mp3", ".wav", ".m4a"]);
const imageExt = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const mime = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4" };

async function list(prefix) {
  const files = [];
  let token;
  do {
    const page = await r2.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}),
    }));
    files.push(...(page.Contents || []).filter((item) => item.Key && !item.Key.endsWith("/")));
    if (page.IsTruncated && !page.NextContinuationToken)
      throw new Error(`R2 truncated ${prefix} without a continuation token`);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  console.log(`${prefix}: ${files.length} objects`);
  return files;
}

// D50 uses <milliseconds>-<ownerId>-<randomUuid>.<ext> for each upload.
// The random UUID belongs to the object, so audio and cover cannot be joined by it.
function keyInfo(item) {
  const filename = path.posix.basename(item.Key);
  const ext = path.posix.extname(filename).toLowerCase();
  const match = /^(\d{13})-(.+)-([0-9a-f]{8}-[0-9a-f-]{27,})\.[^.]+$/i.exec(filename);
  return {
    ...item, ext, stem: filename.slice(0, -ext.length),
    timestamp: match ? Number(match[1]) : null,
    ownerId: match ? match[2] : null,
  };
}

function matchCovers(audio, covers) {
  const pairs = new Map();
  const uses = new Map();
  for (const track of audio) {
    const exact = covers.filter((cover) => cover.stem === track.stem);
    const nearby = track.ownerId && track.timestamp !== null
      ? covers.filter((cover) => cover.ownerId === track.ownerId &&
          cover.timestamp !== null && Math.abs(cover.timestamp - track.timestamp) <= 10000)
      : [];
    const candidates = exact.length ? exact : nearby;
    if (candidates.length !== 1) continue;
    const cover = candidates[0];
    // Reject a cover claimed by more than one track.
    pairs.set(track.Key, cover);
    uses.set(cover.Key, (uses.get(cover.Key) || 0) + 1);
  }
  for (const [key, cover] of pairs) if (uses.get(cover.Key) !== 1) pairs.delete(key);
  return pairs;
}

async function main() {
  const [inAudio, inSongs, inCovers] = await Promise.all([
    list("audio/"), list("songs/"), list("covers/"),
  ]);
  const tracks = [...new Map([...inAudio, ...inSongs]
    .filter((item) => audioExt.has(path.posix.extname(item.Key).toLowerCase()))
    .map((item) => [item.Key, keyInfo(item)])).values()];
  const covers = inCovers.filter((item) => imageExt.has(path.posix.extname(item.Key).toLowerCase())).map(keyInfo);
  if (!tracks.length) throw new Error("No supported audio files found in audio/ or songs/. No database changes made.");
  const pairs = matchCovers(tracks, covers);
  console.log(`Found ${tracks.length} playable audio objects; ${pairs.size} uniquely paired covers. Other covers remain unassigned.`);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT id, data FROM songs");
    const knownKeys = new Set(existing.rows.map((row) => row.data?.r2AudioKey).filter(Boolean));
    const owners = new Set((await client.query("SELECT id FROM users")).rows.map((row) => row.id));
    const result = await client.query("SELECT value FROM d50_documents WHERE name = 'categories'");
    const categories = result.rows[0] && Array.isArray(result.rows[0].value) ? result.rows[0].value : [];
    let category = categories.find((entry) => entry.name?.toLowerCase() === "trending ai hits");
    const categoryCreated = !category;
    if (!category) {
      category = { id: idFor("category", "Trending AI Hits"), name: "Trending AI Hits", ownerId: null, likedBy: [] };
      categories.push(category);
    }
    let inserted = 0;
    let skipped = 0;
    for (const track of tracks) {
      const id = idFor("song", track.Key);
      if (knownKeys.has(track.Key) || existing.rows.some((row) => row.id === id)) { skipped++; continue; }
      const cover = pairs.get(track.Key);
      const ownerId = owners.has(track.ownerId) ? track.ownerId : null;
      const createdAt = track.timestamp || track.LastModified?.getTime() || Date.now();
      const song = {
        id, title: "Restored Track", artist: "Unknown", originalName: path.posix.basename(track.Key),
        filename: null, mimeType: mime[track.ext] || "application/octet-stream",
        size: Number(track.Size || 0), createdAt, ownerId, uploadedBy: ownerId,
        uploaderName: "Unknown", categoryIds: [category.id], likedBy: [],
        url: mediaUrl(track.Key), r2AudioKey: track.Key,
        coverFilename: null, coverUrl: cover ? mediaUrl(cover.Key) : null,
        r2CoverKey: cover?.Key || null, status: "approved",
      };
      if (apply) {
        await client.query(
          `INSERT INTO songs (id, title, url, owner_id, status, data, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'approved', $5::jsonb, $6, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [id, song.title, song.url, ownerId, JSON.stringify(song), createdAt],
        );
      }
      inserted++;
      console.log(`${apply ? "RESTORE" : "PREVIEW"} ${track.Key} -> ${song.url}${cover ? ` | cover ${cover.Key}` : " | no confirmed cover"}`);
    }
    if (apply && inserted && categoryCreated)
      await client.query(
        `INSERT INTO d50_documents (name, value, updated_at) VALUES ('categories', $1::jsonb, NOW())
         ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify(categories)],
      );
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
    console.log(`${apply ? "Done" : "Dry run only"}: ${inserted} new tracks, ${skipped} already present. ${apply ? "Restart the Render service to refresh D50's in-memory catalog." : "Review cover matches, then run again with --apply."}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

main().catch((error) => { console.error("Recovery failed:", error.message); process.exitCode = 1; })
  .finally(async () => { await db.end(); r2.destroy(); });
