#!/usr/bin/env node
/**
 * Instagram -> data/images.json sync script.
 *
 * Re-fetches the creator's FULL media list from the Instagram Graph API on
 * every run and re-parses every caption for hashtags. Because each run starts
 * from scratch, it picks up:
 *   - new posts
 *   - deleted posts
 *   - edited captions / changed hashtags (tags are re-derived every time)
 *
 * Usage:
 *   IG_ACCESS_TOKEN=<long-lived-token> node scripts/sync.js [--dry-run]
 *
 * Env vars:
 *   IG_ACCESS_TOKEN  (required) Long-lived Instagram User Access Token (~60 days)
 *   IG_USER_ID       (optional) Instagram Business/Creator user id. Default: "me"
 *   IG_GRAPH_VERSION (optional) Graph API version. Default: "v21.0"
 *
 * Behavior:
 *   - Writes data/images.json ONLY when the media set actually changed, so
 *     scheduled runs (e.g. the daily GitHub Action) produce no empty commits.
 *   - On ANY failure (bad token, network, rate limit) the existing
 *     data/images.json is left untouched and the process exits 1, so the site
 *     keeps working from the last good data and the scheduler alerts you.
 *
 * Requires Node 18+ (uses global fetch). No npm dependencies.
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "data", "images.json");

const GRAPH_VERSION = process.env.IG_GRAPH_VERSION || "v21.0";
const GRAPH_BASE = `https://graph.instagram.com/${GRAPH_VERSION}`;
const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const USER_ID = process.env.IG_USER_ID || "me";
const DRY_RUN = process.argv.includes("--dry-run");

const MEDIA_FIELDS = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp";
const PAGE_SIZE = 100; // Graph API max per page for /media
const MAX_PAGES = 100; // safety valve: 10k posts

/** Pull every hashtag out of a caption, lowercased, without the '#'. */
function extractTags(caption) {
  if (!caption) return [];
  const matches = caption.match(/#([\p{L}\p{N}_]+)/gu) || [];
  return [...new Set(matches.map((m) => m.slice(1).toLowerCase()))];
}

/** Pick the best displayable image URL for a media item. */
function imageUrlFor(media) {
  if (media.media_type === "VIDEO") return media.thumbnail_url || null;
  return media.media_url || null; // IMAGE and CAROUSEL_ALBUM both expose media_url
}

/** Normalize a Graph API media object into our images.json schema. */
function normalizePost(media) {
  return {
    id: media.id,
    url: imageUrlFor(media),
    mirrors: [], // schema parity with scripts/sync-nostr.js (Nostr mirrors)
    caption: media.caption || "",
    tags: extractTags(media.caption),
    permalink: media.permalink,
    timestamp: media.timestamp,
  };
}

async function graphGet(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const apiMessage = body?.error?.message || res.statusText;
    const apiCode = body?.error?.code;
    // 190 = invalid/expired OAuth token
    if (apiCode === 190) {
      throw new Error(
        `Instagram token is invalid or expired (code 190). Generate a new long-lived token and update the IG_ACCESS_TOKEN secret. API said: ${apiMessage}`
      );
    }
    throw new Error(`Graph API request failed (${res.status}): ${apiMessage}`);
  }
  return body;
}

/** Validate the token and report which account we are syncing. */
async function verifyToken() {
  const me = await graphGet(
    `${GRAPH_BASE}/me?fields=id,username&access_token=${encodeURIComponent(ACCESS_TOKEN)}`
  );
  console.log(`Syncing Instagram account: @${me.username} (id ${me.id})`);
  return me;
}

/** Fetch ALL media for the user, following pagination cursors. */
async function fetchAllMedia() {
  let url =
    `${GRAPH_BASE}/${USER_ID}/media` +
    `?fields=${MEDIA_FIELDS}&limit=${PAGE_SIZE}` +
    `&access_token=${encodeURIComponent(ACCESS_TOKEN)}`;

  const all = [];
  let pages = 0;
  while (url && pages < MAX_PAGES) {
    const page = await graphGet(url);
    all.push(...(page.data || []));
    url = page?.paging?.next || null;
    pages += 1;
  }
  if (pages >= MAX_PAGES) {
    console.warn(`Warning: stopped after ${MAX_PAGES} pages (${all.length} posts).`);
  }
  return all;
}

async function loadExisting() {
  try {
    return JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
  } catch {
    return null;
  }
}

function postsEqual(a, b) {
  if (a.length !== b.length) return false;
  // Order is stable (API returns newest first), so a plain deep compare works.
  return JSON.stringify(a) === JSON.stringify(b);
}

function summarizeChanges(oldPosts, newPosts) {
  const oldById = new Map((oldPosts || []).map((p) => [p.id, p]));
  const newById = new Map(newPosts.map((p) => [p.id, p]));

  const added = newPosts.filter((p) => !oldById.has(p.id));
  const removed = (oldPosts || []).filter((p) => !newById.has(p.id));
  const updated = newPosts.filter((p) => {
    const prev = oldById.get(p.id);
    return prev && JSON.stringify(prev) !== JSON.stringify(p);
  });

  return { added, removed, updated };
}

async function main() {
  if (!ACCESS_TOKEN) {
    console.error("Error: IG_ACCESS_TOKEN environment variable is not set.");
    console.error("See README.md for how to create a long-lived Instagram token.");
    process.exit(1);
  }

  console.log(DRY_RUN ? "Running sync in --dry-run mode (no files will be written)." : "Running Instagram sync...");

  try {
    await verifyToken();

    const media = await fetchAllMedia();
    console.log(`Fetched ${media.length} media items from Instagram.`);

    const posts = media
      .map(normalizePost)
      .filter((p) => p.url) // skip anything without a displayable image
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const existing = await loadExisting();
    const existingPosts = existing?.posts || [];

    if (postsEqual(existingPosts, posts)) {
      console.log("No changes detected on the profile. data/images.json left as-is.");
      return;
    }

    const { added, removed, updated } = summarizeChanges(existingPosts, posts);
    console.log(`Changes detected: ${added.length} new, ${removed.length} removed, ${updated.length} updated (caption/tag edits).`);
    for (const p of added) console.log(`  + new: ${p.permalink} [tags: ${p.tags.join(", ") || "none"}]`);
    for (const p of removed) console.log(`  - removed: ${p.permalink}`);
    for (const p of updated) console.log(`  ~ updated: ${p.permalink} [tags: ${p.tags.join(", ") || "none"}]`);

    if (DRY_RUN) {
      console.log("Dry run: not writing data/images.json.");
      return;
    }

    const output = {
      generatedAt: new Date().toISOString(),
      source: "instagram-graph-api",
      posts,
    };

    // Atomic write: tmp file + rename so the site never reads a half-written file.
    const tmpPath = `${OUTPUT_PATH}.tmp`;
    await writeFile(tmpPath, JSON.stringify(output, null, 2) + "\n", "utf8");
    await rename(tmpPath, OUTPUT_PATH);
    console.log(`Wrote ${posts.length} posts to data/images.json.`);
  } catch (err) {
    console.error(`Sync failed: ${err.message}`);
    console.error("Existing data/images.json was NOT modified; the site keeps working from the last good data.");
    process.exit(1);
  }
}

main();
