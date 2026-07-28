#!/usr/bin/env node
/**
 * Nostr -> data/images.json sync script.
 *
 * There are NO tokens and nothing expires: photos are NIP-94 file-metadata
 * events (kind 1063) published by the creator's key, and reading public events
 * from relays needs no credentials.
 *
 * Every run re-fetches ALL of the creator's photo events and rebuilds the post
 * list, so it picks up new photos, caption edits, and changed section tags.
 *
 * Usage:
 *   node scripts/sync-nostr.js [--dry-run] [--allow-empty]
 *
 * Config:
 *   data/nostr.json   (relays, creator pubkey) — committed, not secret
 *   NOSTR_PUBKEY      (optional env override for the pubkey)
 *
 * Behavior:
 *   - Writes data/images.json ONLY when the photo set actually changed, so
 *     scheduled runs (e.g. the daily GitHub Action) produce no empty commits.
 *   - If 0 photo events are found, the existing data/images.json is kept
 *     (protects the site from a relay outage wiping the portfolio). Pass
 *     --allow-empty only if the creator genuinely deleted everything.
 *   - On ANY failure the existing data/images.json is left untouched and the
 *     process exits 1, so the site keeps working from the last good data.
 *
 * Requires Node 22+ (global WebSocket) and `npm install` (nostr-tools).
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SimplePool, nip19 } from "nostr-tools";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "data", "images.json");
const CONFIG_PATH = path.join(__dirname, "..", "data", "nostr.json");

const DRY_RUN = process.argv.includes("--dry-run");
const ALLOW_EMPTY = process.argv.includes("--allow-empty");
const QUERY_MAX_WAIT_MS = 20000;

/** File metadata events (NIP-94) published by the upload page. */
const PHOTO_EVENT_KIND = 1063;

function decodePubkey(npubOrHex) {
  if (/^[0-9a-f]{64}$/i.test(npubOrHex)) return npubOrHex.toLowerCase();
  const decoded = nip19.decode(npubOrHex);
  if (decoded.type !== "npub") throw new Error("Configured pubkey is not an npub");
  return decoded.data;
}

function tagValues(event, name) {
  return event.tags.filter((t) => t[0] === name && t[1]).map((t) => t[1]);
}

/** Normalize a kind-1063 event into our images.json post schema. */
function normalizeEvent(event, creatorHex, relayHint) {
  const urls = tagValues(event, "url");
  const sha = tagValues(event, "x")[0];
  if (!urls.length || !sha) return null;

  return {
    id: event.id,
    url: urls[0],
    mirrors: urls.slice(1),
    caption: event.content || "",
    tags: tagValues(event, "t").map((t) => t.toLowerCase()),
    permalink: `https://njump.me/${nip19.neventEncode({
      id: event.id,
      author: creatorHex,
      relays: relayHint ? [relayHint] : [],
    })}`,
    timestamp: new Date(event.created_at * 1000).toISOString(),
  };
}

/** Keep only the newest event per image (same sha re-published = an edit). */
function dedupeByHash(events) {
  const byHash = new Map();
  for (const event of events) {
    const sha = tagValues(event, "x")[0];
    if (!sha) continue;
    const prev = byHash.get(sha);
    if (!prev || event.created_at > prev.created_at) byHash.set(sha, event);
  }
  return [...byHash.values()];
}

async function loadJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function postsEqual(a, b) {
  if (a.length !== b.length) return false;
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
  if (typeof WebSocket === "undefined") {
    console.error("Error: this script needs Node 22+ (global WebSocket). You are on " + process.version + ".");
    process.exit(1);
  }

  const config = await loadJson(CONFIG_PATH);
  if (!config || !Array.isArray(config.relays) || !config.relays.length) {
    console.error("Error: data/nostr.json is missing or has no relays.");
    process.exit(1);
  }

  const pubkeyInput = process.env.NOSTR_PUBKEY || config.pubkey;
  let creatorHex;
  try {
    creatorHex = decodePubkey(pubkeyInput || "");
  } catch {
    // "Not set up yet" is not an outage: skip gracefully so a scheduled run
    // stays silent (no daily failure emails) until the npub is configured.
    console.log("No creator pubkey configured — skipping sync.");
    console.log("Put the creator's npub in data/nostr.json (\"pubkey\": \"npub1...\") or set NOSTR_PUBKEY.");
    return;
  }

  console.log(DRY_RUN ? "Running Nostr sync in --dry-run mode (no files will be written)." : "Running Nostr sync...");
  console.log(`Creator: ${nip19.npubEncode(creatorHex)}`);
  console.log(`Relays: ${config.relays.join(", ")}`);

  const pool = new SimplePool();
  try {
    const events = await pool.querySync(
      config.relays,
      { kinds: [PHOTO_EVENT_KIND], authors: [creatorHex] },
      { maxWait: QUERY_MAX_WAIT_MS }
    );
    console.log(`Fetched ${events.length} photo events from relays.`);

    const posts = dedupeByHash(events)
      .map((e) => normalizeEvent(e, creatorHex, config.relays[0]))
      .filter(Boolean)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Drift detection: a photo tagged with a section that data/nostr.json
    // doesn't define would upload and sync fine but never render on the site.
    const knownTags = new Set((config.sections || []).map((s) => s.tag));
    const unknownTags = new Set();
    for (const p of posts) {
      for (const t of p.tags) {
        if (!knownTags.has(t)) unknownTags.add(t);
      }
    }
    if (unknownTags.size) {
      console.warn(
        `Warning: ${unknownTags.size} tag(s) match no section in data/nostr.json and will NOT render on the site: ` +
          [...unknownTags].join(", ")
      );
    }

    if (!posts.length && !ALLOW_EMPTY) {
      console.log("No photo events found. Existing data/images.json left untouched.");
      console.log("(If the creator really has zero photos, re-run with --allow-empty.)");
      return;
    }

    const existing = await loadJson(OUTPUT_PATH);
    const existingPosts = existing?.posts || [];

    if (postsEqual(existingPosts, posts)) {
      console.log("No changes detected on the relays. data/images.json left as-is.");
      return;
    }

    const { added, removed, updated } = summarizeChanges(existingPosts, posts);
    console.log(`Changes detected: ${added.length} new, ${removed.length} removed, ${updated.length} updated.`);
    for (const p of added) console.log(`  + new: ${p.url} [tags: ${p.tags.join(", ") || "none"}]`);
    for (const p of removed) console.log(`  - removed: ${p.url}`);
    for (const p of updated) console.log(`  ~ updated: ${p.url} [tags: ${p.tags.join(", ") || "none"}]`);

    if (DRY_RUN) {
      console.log("Dry run: not writing data/images.json.");
      return;
    }

    const output = {
      generatedAt: new Date().toISOString(),
      source: "nostr",
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
  } finally {
    pool.close(config.relays);
  }
}

// Relay websockets can keep the event loop alive after the work is done;
// exit explicitly so scheduled CI runs don't hang until the step timeout.
main().then(() => process.exit(0));
