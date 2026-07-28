# Photography Site Architecture on Nostr + Blossom

A comprehensive reference for building a decentralized photography platform using Nostr protocols and Blossom media storage.

> **Implementation status (2026-07):** This document is the full *roadmap* reference.
> What is **implemented today** in this repo is the foundation: Blossom uploads
> with kind-24242 auth, multi-server mirroring, NIP-94 **kind-1063** metadata
> events (used as the site's photo index — see below), relay sync into
> `data/images.json`, NIP-07/nsec login, and author-filtered reads.
> **Not yet implemented:** kind-20 picture events, albums, comments, reactions,
> zaps, blog, blurhash, kind:10002/10063 lists, and the React component stack
> shown below (this repo is vanilla JS — treat all `useUploadFile`/TSX snippets
> as illustrative, not existing code).
>
> **Deviation note:** this doc prescribes kind 20 (NIP-68) as the primary photo
> event; the current site uses kind 1063 alone because it carries everything the
> portfolio needs in one event. If interop with NIP-68 picture clients becomes a
> goal, dual-publish kind 20 with `imeta` from the upload page — the sync can
> then read either kind.

---

## Table of Contents

1. [Philosophy & Core Principles](#philosophy--core-principles)
2. [Technology Stack Overview](#technology-stack-overview)
3. [Blossom: Media Storage Layer](#blossom-media-storage-layer)
4. [Nostr Event Kinds for Photography](#nostr-event-kinds-for-photography)
5. [Data Architecture](#data-architecture)
6. [Feature Architecture](#feature-architecture)
7. [Relay Strategy](#relay-strategy)
8. [Security Model](#security-model)
9. [Performance Patterns](#performance-patterns)
10. [Monetization via Zaps](#monetization-via-zaps)
11. [Implementation Checklist](#implementation-checklist)

---

## Philosophy & Core Principles

A Nostr-native photography site is **not** a traditional web app with a database backend. Everything is:

- **Self-sovereign**: Photographers own their keys, their content, and their audience relationships
- **Censorship-resistant**: Photos live on Blossom servers chosen by the photographer; metadata lives on relays
- **Interoperable**: Any NIP-68-compatible client can display your photos
- **Portable**: Export your identity (nsec) and every photo and follower comes with you

The golden rule: **media bytes live on Blossom, metadata lives on Nostr relays.**

---

## Technology Stack Overview

| Layer | Technology | Purpose |
|---|---|---|
| Identity | Nostr keypair (NIP-01) | User identity, signing |
| Media Storage | Blossom (NIP-B7) | Store image blobs by SHA-256 |
| Photo Events | NIP-68 kind `20` | Picture-first posts |
| File Metadata | NIP-94 kind `1063` | Full file metadata index |
| Photo Sets / Albums | NIP-51 kind `30006` | Curated picture collections |
| Long-form Blog | NIP-23 kind `30023` | Behind-the-scenes essays |
| Comments | NIP-22 kind `1111` | Discussion threads on photos |
| Reactions | NIP-25 kind `7` | Likes/hearts on photos |
| Zaps | NIP-57 kind `9735` | Lightning payments to photographers |
| Profile | NIP-01 kind `0` | Photographer bio, avatar, banner |
| Relay List | NIP-65 kind `10002` | Read/write relay preferences |
| Blossom Server List | NIP-B7 kind `10063` | Preferred media servers |
| Wallet Connect | NIP-47 | Connect a Lightning wallet |

---

## Blossom: Media Storage Layer

### What Blossom Is

Blossom (defined in **NIP-B7** / BUD specs) is a protocol for storing files on media servers addressable by their **SHA-256 hash**. Unlike traditional CDNs:

- Files are content-addressed: `https://cdn.blossom.cloud/<sha256>.jpg`
- The hash *is* the identity — if the hash matches, the file is authentic
- Clients can mirror files across multiple Blossom servers for redundancy

### The `kind:10063` Server List

Every photographer should publish a **Blossom server list** so clients can find their media if one server goes down:

```json
{
  "kind": 10063,
  "content": "",
  "tags": [
    ["server", "https://blossom.primal.net"],
    ["server", "https://cdn.satellite.earth"],
    ["server", "https://nostr.build"]
  ]
}
```

**Recommendation**: list at least **2–3 Blossom servers** for resilience. If a URL in a photo event becomes unreachable, Nostr clients that implement NIP-B7 will automatically try your other listed servers using the same SHA-256 hash path.

### Uploading Photos

*(Roadmap — React/TS snippet. The implemented vanilla-JS equivalent is `scripts/admin.js`, which performs the same Blossom `PUT` with a kind-24242 auth event.)*

Use the `useUploadFile` hook:

```ts
import { useUploadFile } from "@/hooks/useUploadFile";

const { mutateAsync: uploadFile } = useUploadFile();

// Returns NIP-94-compatible tags
const tags = await uploadFile(file);
const url   = tags[0][1];   // "url" tag — the Blossom URL
const hash  = tags.find(([n]) => n === "x")?.[1];   // SHA-256
const dim   = tags.find(([n]) => n === "dim")?.[1];  // "3024x4032"
const mime  = tags.find(([n]) => n === "m")?.[1];    // "image/jpeg"
const blur  = tags.find(([n]) => n === "blurhash")?.[1];
```

The returned tags follow the **NIP-94 schema** and map directly into `imeta` entries for photo events.

### Supported Image Formats (NIP-68)

Only publish photos in these MIME types for maximum client compatibility:

| Format | MIME Type | Best For |
|---|---|---|
| JPEG | `image/jpeg` | Photographs (lossy, small) |
| PNG | `image/png` | Lossless, transparency |
| WebP | `image/webp` | Modern, excellent quality/size |
| AVIF | `image/avif` | Next-gen, excellent compression |
| APNG | `image/apng` | Animated images |
| GIF | `image/gif` | Legacy animated images |

**Recommendation**: Upload originals as JPEG or WebP. Generate responsive thumbnails server-side if needed.

---

## Nostr Event Kinds for Photography

### Primary: `kind:20` — Picture Event (NIP-68)

*(Roadmap — not yet published by this repo; the implemented pipeline uses kind 1063 as the primary event. See the status note at the top.)*

The **core event kind** for a photography site in the full Nostr ecosystem. Every photo post should eventually be a `kind:20` so picture-first clients can display it.

```json
{
  "kind": 20,
  "content": "Golden hour at the cliffs. Shot with a 50mm at f/1.8.",
  "tags": [
    ["title", "Cliffside at Dusk"],

    ["imeta",
      "url https://blossom.primal.net/abc123...def456.jpg",
      "m image/jpeg",
      "x abc123...def456",
      "dim 4032x3024",
      "blurhash LGF5?xYk^6#M@-5c,1J5@[or[Q6.",
      "alt Golden hour light over coastal cliffs",
      "fallback https://cdn.satellite.earth/abc123...def456.jpg"
    ],

    ["m", "image/jpeg"],
    ["x", "abc123...def456"],

    ["t", "photography"],
    ["t", "landscape"],
    ["t", "goldenhour"],

    ["location", "Big Sur, California, USA"],
    ["g", "9q8yy"],

    ["L", "ISO-639-1"],
    ["l", "en", "ISO-639-1"]
  ]
}
```

#### Key Design Decisions

| Decision | Recommendation | Reason |
|---|---|---|
| `title` tag | Always include | Powers gallery titles in clients |
| `alt` inside `imeta` | Always include | Accessibility + search indexing |
| `blurhash` inside `imeta` | Always include | Shows placeholder before image loads |
| `fallback` inside `imeta` | Include for each Blossom server you use | Redundancy if primary URL fails |
| `x` hash at top level | Always include | Makes photos queryable by hash |
| `t` hashtags | 3–8 per photo | Relay-level indexing; enables discovery |
| `location` + `g` geohash | Include when possible | Powers map-based galleries |
| Multiple `imeta` tags | Use for multi-photo carousel posts | NIP-68 supports up to N images per post |

#### Tagging Users in Photos (People Tags)

```json
["p", "<pubkey-hex>", "<relay-hint>"],
["annotate-user", "<pubkey-hex>:<posX>:<posY>"]
```

Include both a `p` tag (for notifications) and an `annotate-user` inside `imeta` (for position data).

---

### Secondary: `kind:1063` — File Metadata (NIP-94)

Use `kind:1063` as a **permanent file metadata record** in your media library. Think of it as your photo archive index.

```json
{
  "kind": 1063,
  "content": "RAW export from Sony A7IV, post-processed in Lightroom",
  "tags": [
    ["url", "https://blossom.primal.net/abc123.jpg"],
    ["m",   "image/jpeg"],
    ["x",   "abc123..."],
    ["ox",  "original-sha256..."],
    ["size","4200000"],
    ["dim", "4032x3024"],
    ["blurhash", "LGF5?xYk..."],
    ["thumb", "https://blossom.primal.net/thumb_abc123.jpg"],
    ["alt", "Golden hour at Big Sur cliffs"],
    ["summary", "Coastal landscape shot during magic hour"]
  ]
}
```

**When to use `1063` vs. `20`:**

| Use Case | Kind |
|---|---|
| Public photo post (social feed) | `20` |
| Private media library / archive | `1063` |
| File shared in a DM | `1063` inside gift wrap |
| Reference in a long-form blog post | `1063` for the asset, embed URL in `30023` |

---

### Albums & Collections: `kind:30006` — Picture Sets (NIP-51)

Organize photos into albums using the **picture curation set**:

```json
{
  "kind": 30006,
  "content": "",
  "tags": [
    ["d", "iceland-2024"],
    ["title", "Iceland 2024"],
    ["description", "10 days chasing the northern lights"],
    ["image", "https://blossom.primal.net/cover-abc.jpg"],
    ["e", "<event-id-of-photo-1>"],
    ["e", "<event-id-of-photo-2>"],
    ["e", "<event-id-of-photo-3>"]
  ]
}
```

Each `e` tag references a `kind:20` picture event by its event ID.

**Album URL pattern**: `/:npub/:album-slug` → query `kind:30006` filtered by `authors: [pubkey]` and `#d: [slug]`.

---

### Long-form: `kind:30023` — Blog / Behind the Scenes (NIP-23)

For essays, tutorials, and storytelling:

```json
{
  "kind": 30023,
  "content": "# Iceland in Winter\n\nIt was -20°C when I arrived...",
  "tags": [
    ["d",            "iceland-winter-2024"],
    ["title",        "Iceland in Winter: A Photographer's Guide"],
    ["summary",      "Everything I learned chasing auroras in the dark."],
    ["image",        "https://blossom.primal.net/hero-abc.jpg"],
    ["published_at", "1704067200"],
    ["t",            "photography"],
    ["t",            "travel"],
    ["t",            "iceland"]
  ]
}
```

Embed photos in the Markdown body with standard image syntax. Reference back to your `kind:20` events with `nostr:nevent1...` links for cross-linking.

---

### Comments: `kind:1111` — NIP-22 Comments

Comments on a photo attach to the `kind:20` event:

```json
{
  "kind": 1111,
  "content": "Incredible light! What time of day was this?",
  "tags": [
    ["K", "20"],
    ["E", "<photo-event-id>", "<relay>", "<author-pubkey>"],
    ["e", "<photo-event-id>", "<relay>", "root"],
    ["p", "<photographer-pubkey>"]
  ]
}
```

Query comments with: `{ kinds: [1111], "#E": [photoEventId] }`

---

## Data Architecture

### Entity Relationship

```
Photographer (kind:0)
  │
  ├── Blossom Server List (kind:10063)
  ├── Relay List (kind:10002)
  │
  ├── Photo Posts (kind:20) ──── imeta → Blossom URL (SHA-256)
  │     │                                      │
  │     ├── Comments (kind:1111)               └── Fallback servers
  │     ├── Reactions (kind:7)
  │     └── Zap Receipts (kind:9735)
  │
  ├── Albums (kind:30006) ──── e tags → kind:20 events
  │
  ├── Blog Posts (kind:30023) ──── image → Blossom URLs
  │
  └── File Archive (kind:1063) ──── url → Blossom URLs
```

### Query Patterns

#### Fetch a photographer's gallery feed
```ts
nostr.query([{
  kinds: [20],
  authors: [pubkeyHex],
  limit: 30,
}])
```

#### Fetch photos by hashtag (discovery)
```ts
nostr.query([{
  kinds: [20],
  '#t': ['landscape'],
  limit: 50,
}])
```

#### Fetch a specific album
```ts
nostr.query([{
  kinds: [30006],
  authors: [pubkeyHex],     // REQUIRED — trust boundary
  '#d': ['iceland-2024'],
  limit: 1,
}])
```

#### Fetch comments on a photo
```ts
nostr.query([{
  kinds: [1111],
  '#E': [photoEventId],
  limit: 100,
}])
```

#### Fetch zaps on a photo
```ts
nostr.query([{
  kinds: [9735],
  '#e': [photoEventId],
  limit: 50,
}])
```

#### Look up a photographer's Blossom servers (for fallback resolution)
```ts
nostr.query([{
  kinds: [10063],
  authors: [pubkeyHex],
  limit: 1,
}])
```

---

## Feature Architecture

### Page & Route Structure

```
/                          → Discovery feed (kind:20, multi-author, latest)
/:npub                     → Photographer profile + gallery grid
/:npub/:album-d-tag        → Album view (kind:30006)
/:nip19                    → Universal NIP-19 router (nevent, naddr, npub, etc.)
/explore                   → Hashtag/tag browse
/upload                    → Photo upload composer (auth required)
/settings/relays           → Relay management
/settings/blossom          → Blossom server management
```

### Component Architecture

```
<App>
  <NostrProvider>          ← Nostr connection pool
    <AppProvider>          ← Theme, relay config, Blossom servers
      <QueryClientProvider>
        <AppRouter>
          <GalleryFeed />       ← kind:20 infinite scroll
          <PhotoDetail />       ← Single photo + comments + zaps
          <ProfilePage />       ← kind:0 + kind:20 grid
          <AlbumPage />         ← kind:30006
          <UploadComposer />    ← useUploadFile + useNostrPublish
          <LoginArea />         ← Auth
        </AppRouter>
      </QueryClientProvider>
    </AppProvider>
  </NostrProvider>
</App>
```

### Upload Flow

```
User selects file
       │
       ▼
useUploadFile(file)                   ← Blossom upload (NIP-B7 auth)
       │
       ▼
Returns NIP-94 tags array
  [["url", "https://blossom.../sha256.jpg"],
   ["x",   "sha256hex"],
   ["m",   "image/jpeg"],
   ["dim", "3024x4032"],
   ["blurhash", "L6PZfSi_.AyE..."],
   ...]
       │
       ▼
User fills in: title, description,
               location, hashtags,
               people tags
       │
       ▼
useNostrPublish({ kind: 20, ... })    ← Publish to relays
```

### Image Display with Blurhash Placeholder

Always use the `blurhash` value for loading states. Show the blurred placeholder immediately, then swap to the real image once loaded. This is essential for a good photography UX — images may be large and take time over mobile connections.

---

## Relay Strategy

### Relay Tiers for a Photography Site

Not all relays are equal. Use a tiered approach:

#### Tier 1 — General Purpose (Read + Write)
Good for profile metadata, social discovery, reactions, and comments.

- `wss://relay.ditto.pub`
- `wss://relay.primal.net`
- `wss://relay.damus.io`
- `wss://nos.lol`

#### Tier 2 — Media-Specialized Relays (Write)
Relays that specifically support picture events and media-heavy clients:

- `wss://relay.nostr.band` — strong search & indexing
- `wss://relay.nostrplebs.com`

#### Tier 3 — Personal / Self-Hosted (Write)
For photographers who want full control:

- Run your own relay (e.g. [Nostream](https://github.com/Cameri/nostream), [Strfry](https://github.com/hoytech/strfry))
- Write all your events here as the canonical source

### NIP-65 Relay List

Publish a `kind:10002` relay list so other clients know where to find your photos:

```json
{
  "kind": 10002,
  "tags": [
    ["r", "wss://relay.ditto.pub"],
    ["r", "wss://relay.primal.net", "read"],
    ["r", "wss://relay.damus.io",   "read"],
    ["r", "wss://nos.lol"]
  ]
}
```

---

## Security Model

### Key Security Principles

1. **Never store nsec unencrypted in production.** The `nsec` is stored in plaintext in localStorage by default — any XSS vulnerability equals permanent key theft. Encourage users to use a NIP-07 browser extension (Alby, nos2x) or a NIP-46 remote signer.

2. **Sanitize all event-sourced URLs.** Before rendering any URL from a Nostr event as `src`, `href`, or in CSS, run it through `sanitizeUrl()` which enforces an https-only allowlist. A malicious photographer event could contain `javascript:` URLs.

3. **Sanitize CSS strings.** If you interpolate event data into CSS (e.g. a banner image URL in a `style` attribute), sanitize the string to prevent CSS injection.

4. **Never use `dangerouslySetInnerHTML`** with event content or metadata. Always use a proper Markdown renderer or text renderer.

5. **Author-filter addressable events.** When fetching albums (`kind:30006`) or profiles, always include `authors: [trustedPubkey]` in the filter. The `d` tag alone is not a trust boundary.

```ts
// ❌ Anyone can publish a fake album with this d-tag
nostr.query([{ kinds: [30006], '#d': ['iceland-2024'] }])

// ✅ Only trust this specific photographer
nostr.query([{ kinds: [30006], authors: [photographerPubkey], '#d': ['iceland-2024'] }])
```

6. **Verify SHA-256 hashes.** When displaying an image from Blossom, optionally verify that the downloaded file's SHA-256 matches the hash in the `x` tag. This prevents a compromised Blossom server from serving altered images.

---

## Performance Patterns

### Lazy Loading & Blurhash

Show the `blurhash` value as a CSS background color/gradient while the real image loads:

```tsx
<div
  style={{ backgroundImage: `url(${blurhashDataUrl})` }}
  className="w-full aspect-[4/3] bg-muted"
>
  <img
    src={sanitizeUrl(imageUrl)}
    alt={altText}
    loading="lazy"
    decoding="async"
    className="w-full h-full object-cover"
    onLoad={(e) => e.currentTarget.parentElement?.removeAttribute('style')}
  />
</div>
```

### Infinite Scroll

Use the `nostr-infinite-scroll` skill for the main gallery feed. Key parameters for photography:

- `limit: 20` per page (photos are heavy; don't over-fetch)
- Sort by `created_at` descending
- Use `until` cursor for pagination (not `since`)

### Query Batching

Combine related queries to minimize relay round-trips:

```ts
// ❌ Two queries
nostr.query([{ kinds: [20], authors: [pubkey] }])
nostr.query([{ kinds: [30006], authors: [pubkey] }])

// ✅ One query, split in JS
nostr.query([
  { kinds: [20], authors: [pubkey], limit: 30 },
  { kinds: [30006], authors: [pubkey], limit: 50 }
])
```

### Thumbnail Strategy

For gallery grid views, prefer requesting the `thumb` URL from `kind:1063` metadata rather than loading full-resolution images. If no thumbnail exists, use CSS `object-fit: cover` on a smaller viewport.

---

## Monetization via Zaps

### Setting Up Zaps (NIP-57)

Photographers earn Bitcoin directly through Lightning zaps on their photos. The flow:

1. Photographer sets a `lud16` (Lightning address) in their `kind:0` profile, e.g. `alice@getalby.com`
2. Viewers click a ⚡ Zap button on a photo
3. Client builds a `kind:9734` zap request referencing the `kind:20` photo event
4. Lightning invoice is paid
5. `kind:9735` zap receipt is published to relays
6. Gallery UI shows cumulative zap amounts and zap comments on photos

### Zap Split for Collaborations

Use the `zap` tag in a `kind:20` event to split zaps between multiple photographers:

```json
["zap", "<collaborator-pubkey>", "wss://relay.hint", "1"]
```

If you include `zap` tags with weights, zap sats are split proportionally between all listed pubkeys. This is ideal for:
- Co-authored photo projects
- Giving a cut to a model or assistant
- Funding a community photo journal

### Zap Goals (NIP-75)

Use `kind:9041` to set a fundraising goal for a specific project (e.g. "Fund my Iceland expedition"):

```json
{
  "kind": 9041,
  "content": "Help me fund my 2-week Northern Lights expedition to Iceland!",
  "tags": [
    ["amount", "2100000"],
    ["relays", "wss://relay.ditto.pub"],
    ["a", "30023:<pubkey>:iceland-expedition-blog"]
  ]
}
```

---

## Implementation Checklist

### Foundation
- [ ] Photographer profile `kind:0` with name, bio, avatar (Blossom URL), banner (Blossom URL), `lud16` Lightning address
- [ ] `kind:10002` relay list published (NIP-65)
- [ ] `kind:10063` Blossom server list published (NIP-B7) with 2+ servers

### Photo Upload
- [ ] `useUploadFile` hook integrated for Blossom upload
- [ ] Upload UI supports JPEG, WebP, PNG, AVIF
- [ ] `kind:20` event published with full `imeta` (url, x, dim, blurhash, alt, fallback)
- [ ] Required tags: `title`, `m`, `x`, `t` (hashtags)
- [ ] Optional tags: `location`, `g` (geohash), `p` (people tags), `annotate-user`
- [ ] `kind:1063` file metadata record published for archiving

### Gallery Display
- [ ] Gallery grid with blurhash placeholders
- [ ] Lazy loading (`loading="lazy"` + `decoding="async"`)
- [ ] All image URLs sanitized with `sanitizeUrl()` before rendering
- [ ] Infinite scroll for discovery feeds
- [ ] Responsive masonry or grid layout

### Albums
- [ ] Album creation UI (publishes `kind:30006`)
- [ ] Album view page at `/:npub/:d-tag`
- [ ] Album queries **always** include `authors` filter (security)

### Social Features
- [ ] Reaction (like) button with `kind:7` publish
- [ ] Comment section using `kind:1111` (NIP-22)
- [ ] Zap button with NIP-57 flow (`kind:9734` → invoice → `kind:9735`)
- [ ] Zap total display on photos

### Blog / Long-form
- [ ] `kind:30023` article editor
- [ ] Markdown renderer (no `dangerouslySetInnerHTML`)
- [ ] Cross-links to photo events via `nostr:nevent1...`

### Settings
- [ ] Relay management (`kind:10002`)
- [ ] Blossom server management (`kind:10063`)
- [ ] Profile edit (avatar/banner upload via Blossom)
- [ ] Wallet Connect (NIP-47) for auto-paying invoices

### Security
- [ ] All event URLs sanitized before use in `src`/`href`/CSS
- [ ] No `dangerouslySetInnerHTML` with untrusted data
- [ ] Addressable event queries always include `authors` filter
- [ ] NIP-07 browser extension login supported

---

## Key NIP Reference Summary

| NIP | Kind | Purpose |
|---|---|---|
| NIP-01 | 0, 1 | Identity, basic notes |
| NIP-02 | 3 | Follow list |
| NIP-22 | 1111 | Comments on photos |
| NIP-23 | 30023 | Long-form blog posts |
| NIP-25 | 7 | Reactions / likes |
| NIP-51 | 30006 | Photo albums / curation sets |
| NIP-57 | 9734, 9735 | Lightning zaps |
| NIP-65 | 10002 | Relay list |
| NIP-68 | 20 | Picture-first feed events ← **PRIMARY** |
| NIP-92 | (tag) | `imeta` tag for media attachments |
| NIP-94 | 1063 | File metadata / archive |
| NIP-98 | (auth) | HTTP auth for Blossom upload |
| NIP-B7 | 10063, 24242 | Blossom media protocol |

---

*Built with [Shakespeare](https://shakespeare.diy) — the AI-powered Nostr app builder.*
