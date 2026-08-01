# RawBe Photography — Portfolio Site

Static photography portfolio. No framework, no build step — plain HTML/CSS/JS.
Photos are uploaded by the creator through the site's own upload page and stored
on **Nostr Blossom servers**; the photo index lives on **Nostr relays**. There
are **no API keys and nothing expires** — the creator's Nostr key is the only
credential.

## How photo publishing works

1. The creator opens **`admin.html`** on the site (footer → "Creator upload")
   and signs in with their Nostr key — a signer extension (Alby, nos2x) is
   recommended (the key never touches the page, and sign-in is remembered),
   or they can paste their `nsec` (kept **in memory only**, forgotten when the
   tab closes).
2. They drag photos onto section tiles (Weddings, Family, …). For each photo
   the page:
   - validates the format (JPEG, PNG, WebP, AVIF, GIF, APNG only) and
     downscales it to web size (max 2560px; already-small files pass through),
   - signs a Blossom authorization event (kind 24242) and `PUT`s the file to
     every configured Blossom server (mirrors, for redundancy). Returned URLs
     are only trusted when they contain the file's SHA-256 (content
     addressing) — otherwise the canonical `/<sha256><ext>` URL is used,
   - signs a NIP-94 file-metadata event (kind 1063) with the URLs, hash, mime
     type, caption and section hashtag, and publishes it to public relays.

   The upload page loads **no third-party code**: nostr-tools is vendored at
   `scripts/vendor/nostr-tools.js` (nostr-tools 2.24.1, sha256
   `c400eab94bdfcc29b733ac8066a0731581e36c73316a4e062ad0a51779804e92`). If you
   ever update it, re-download from a trusted source, verify the hash, and
   keep it pinned — never swap it for a CDN URL.
3. A GitHub Action (`.github/workflows/sync.yml`) runs `scripts/sync-nostr.js`
   **once a day**. It reads the creator's public kind-1063 events from the
   relays and rebuilds `data/images.json`. Reading public Nostr events needs
   **no credentials at all**, which is why there is no token to renew.
4. The Action commits `data/images.json` **only when something changed**. If
   your host (Netlify/Vercel/GitHub Pages) deploys on push, the site updates
   itself. To publish immediately, use Actions → "Sync Nostr photos" → Run.
5. If the relay fetch fails or returns nothing, the existing `data/images.json`
   is left untouched: the site keeps working from the last good data.

### Access control

The site only renders events authored by the creator pubkey configured in
`data/nostr.json`. Anyone can open the upload page, but photos signed by any
other key never appear on the site — **the key is the permission system**.

### One-time setup

1. Get the creator's **npub** (from their Nostr client profile, or derive it
   from the `nsec` with any key tool).
2. Put it in `data/nostr.json`:
   ```json
   { "pubkey": "npub1..." }
   ```
3. Optionally adjust the `relays` and `blossomServers` lists in the same file.
   All listed Blossom servers receive every upload (mirroring); all listed
   relays receive every metadata event.
4. Commit and deploy. No secrets to configure anywhere — including in GitHub.

### `data/nostr.json` reference

| Field            | Purpose                                                        |
|------------------|----------------------------------------------------------------|
| `pubkey`         | Creator's npub (or 64-char hex). The only key the site reads.  |
| `relays`         | Nostr relays for publishing/reading metadata events.           |
| `blossomServers` | Blossom servers that store the actual image files.             |
| `sections`       | Upload-page tiles. `tag` must match `GALLERY_SECTIONS` in `scripts/main.js`. |

### Running the sync by hand

```bash
npm install          # once (installs nostr-tools; requires Node 22+)
npm run sync         # fetch relays and write data/images.json
npm run sync:check   # dry run: report what would change, write nothing
```

### Adding a new gallery section

Add one entry to `sections` in `data/nostr.json` — that's the single source of
truth. The upload page gets a new tile and the site renders a new gallery
automatically (`scripts/main.js` derives its section list from the same file,
falling back to built-in defaults if it can't be loaded). The section tagged
`portfolio-carousel` feeds the hero carousel instead of a gallery. The sync
script warns if a synced photo carries a tag that matches no section (a photo
that would never render).

## Running the site locally

The site fetches `data/*.json`, so it needs to be served over HTTP (opening
`index.html` directly from the filesystem won't work):

```bash
npm run serve        # python3 -m http.server 8080
# or: npx serve .
```

Then open http://localhost:8080 (and `/admin.html` for the upload page).
Out of the box it renders sample placeholder photos from `data/images.json`;
the first successful Nostr sync replaces them.

## Themes

Two complete themes live in `styles/classic/` (elegant, default) and
`styles/punk/` (dark tattoo/punk). The header toggle swaps the stylesheet and
remembers the choice in `localStorage`. Both files must keep defining the same
selectors — when editing one theme, mirror the selector in the other.
The upload page has its own theme-independent stylesheet (`styles/admin.css`).

## Pricing & contact form

- **Pricing** comes from `data/pricing.json` — edit packages there and deploy.
  (`highlighted: true` marks the featured package.)
- **Contact form** is handled by a Cloudflare Pages Function
  (`functions/api/contact.js`) which forwards messages via
  [MailChannels](https://blog.cloudflare.com/sending-email-from-workers-with-mailchannels/)
  — free with Cloudflare Pages, **no account or API key needed**.

  **Setup (one time):**
  1. Cloudflare Pages dashboard → your project → **Settings → Environment
     variables** → add `CONTACT_EMAIL` = the address messages go to.
  2. (Optional) add `FROM_EMAIL` for the sender address shown on the email.
  3. (Recommended for deliverability) add an SPF record to your domain's DNS:
     `v=spf1 include:relay.mailchannels.net ~all` — if you already have an SPF
     record, merge `include:relay.mailchannels.net` into it instead.

  The visitor's email is set as Reply-To, so you can answer straight from
  your inbox. A hidden honeypot field drops basic bot submissions. The form
  also works without JavaScript (the function redirects back with a status
  message). Local testing: `npx wrangler pages dev .` with a `.dev.vars`
  file containing `CONTACT_EMAIL=you@example.com` (`.dev.vars` is gitignored).

## File structure

```
├── index.html                  # single-page site
├── admin.html                  # creator upload page (drag & drop)
├── data/
│   ├── images.json             # single source of truth for photos (synced)
│   ├── nostr.json              # creator pubkey, relays, blossom servers, sections
│   └── pricing.json            # pricing packages (manual)
├── scripts/
│   ├── admin.js                # upload page logic (blossom PUT + kind-1063 publish)
│   ├── vendor/nostr-tools.js   # pinned nostr-tools bundle for the upload page (no CDN)
│   ├── sync-nostr.js           # relays -> images.json sync (Node 22+, nostr-tools)
│   └── main.js                 # theme toggle, carousel, galleries, lightbox, pricing, contact form
├── functions/
│   └── api/contact.js          # Cloudflare Pages Function: contact form -> email (MailChannels)
├── styles/
│   ├── classic/main.css        # default professional theme
│   ├── punk/main.css           # punk/tattoo theme (same selectors)
│   └── admin.css               # upload page styles (theme-independent)
├── .github/workflows/sync.yml  # daily scheduled sync + Cloudflare deploy
└── images/                     # static assets (og-image, etc.)
```

## Sync workflow & Cloudflare deployment

The daily sync workflow (`.github/workflows/sync.yml`) does three things in order:

1. **Fetch** — runs `scripts/sync-nostr.js` to pull the latest kind-1063 events
   from Nostr relays.
2. **Commit & push** — commits `data/images.json` to `main` **only when it
   changed**, and sets an internal `pushed` flag.
3. **Trigger Cloudflare Pages deploy** — only when `pushed` is `true`, POSTs to
   a Cloudflare Pages deploy hook, firing the same native deployment that a PR
   merge would trigger. No wrangler CLI or `wrangler.toml` involvement.

Steps 1 and 2 need **no secrets** (reading public Nostr events is credential-free).
Step 3 requires one repository secret:

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_DEPLOY_HOOK` | Cloudflare Pages dashboard → your project → **Settings → Builds & deployments → Deploy hooks** → Add hook. Copy the full HTTPS URL. |

Set it at **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**.

No-op syncs (nothing changed in Nostr) skip the deploy step entirely and need
no secrets at all.

## Known risks / open items

- **Free infrastructure persistence:** public Blossom servers and relays are
  community-run. Uploads are mirrored to every configured Blossom server, and
  `data/images.json` is committed after every sync, so the site itself never
  breaks — but long-term archival of the original files depends on at least
  one server keeping them. The site already fails over: if an image URL dies,
  the page retries that photo's mirror URLs automatically. For guaranteed
  permanence, run a self-hosted Blossom server later and add it to
  `blossomServers`.
- **Relay churn:** if all configured relays drop an event, the sync finds
  nothing and (safely) does nothing. Keep 3–5 relays in `data/nostr.json`.
- **nsec handling:** a pasted nsec lives only in page memory (never persisted)
  and is forgotten when the tab closes. A signer extension is still the
  better path — the key never enters the page and sign-in persists.
- **Commit the lockfile:** the GitHub Action runs `npm ci` with npm caching —
  `package-lock.json` must be committed alongside `package.json` or every
  run fails at install.
