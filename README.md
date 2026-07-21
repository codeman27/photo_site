# RawBe Photography — Portfolio Site

Static photography portfolio for [@rawbe_photography_llc](https://www.instagram.com/rawbe_photography_llc/).
No framework, no build step — plain HTML/CSS/JS. Content auto-syncs from Instagram
once a day; hashtags on posts decide where each photo appears on the site.

## How the Instagram sync works (the "check the profile once a day" piece)

There is no supported way to pull photos from a public Instagram profile
anonymously — scraping violates Instagram's terms and breaks constantly. The
reliable mechanism is the **Instagram Graph API** plus a **scheduled job**:

1. The creator switches their account to a free **Creator (or Business) account**
   in the Instagram app (Settings → Account → Switch to professional account).
2. One-time authorization produces a **long-lived access token** (~60 days).
3. A GitHub Action (`.github/workflows/sync.yml`) runs `scripts/sync.js`
   **once a day**. Every run re-fetches the creator's *entire* media list and
   re-parses *every* caption for hashtags, so it picks up:
   - new posts,
   - deleted posts,
   - edited captions / changed hashtags (a photo can move sections without reposting).
4. The Action commits `data/images.json` **only when something changed** — quiet
   days produce zero commits. If your host (Netlify/Vercel/GitHub Pages) deploys
   on push, the site updates itself.
5. If the API call fails (expired token, outage), the existing `data/images.json`
   is left untouched: the site keeps working from the last good data, and the
   failed Action emails the repo owner.

### One-time Instagram API setup

1. Convert the IG account to Creator/Business (above).
2. Create an app at [developers.facebook.com](https://developers.facebook.com/),
   add the **Instagram** product (Instagram API with Instagram Login).
3. Add the creator's Instagram account in the app dashboard and generate an
   access token with the `instagram_business_basic` permission.
4. Exchange it for a **long-lived token** (60 days) — see
   [Instagram Platform docs](https://developers.facebook.com/docs/instagram-platform).
5. Add the token to the GitHub repo: **Settings → Secrets and variables →
   Actions → New repository secret** named `IG_ACCESS_TOKEN`.
   (Optional: `IG_USER_ID` — the numeric IG user id; defaults to `me`.)

**Token renewal:** long-lived tokens expire after ~60 days. Before then, either
re-generate one the same way, or call:

```
curl "https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=YOUR_CURRENT_TOKEN"
```

and update the `IG_ACCESS_TOKEN` secret with the new value. If the token lapses,
the daily Action fails loudly (email) and the site keeps showing the last sync.

### Running the sync by hand

```bash
export IG_ACCESS_TOKEN=your_long_lived_token
npm run sync          # fetch and write data/images.json
npm run sync:check    # dry run: report what would change, write nothing
```

### Hashtag conventions for the creator

Post to Instagram normally; hashtags in the caption place the photo:

| Hashtag              | Appears in            |
|----------------------|-----------------------|
| `#portfolio-carousel`| Hero carousel         |
| `#wedding`           | Weddings gallery      |
| `#family`            | Family gallery        |
| `#portrait`          | Portraits gallery     |
| `#maternity`         | Maternity gallery     |

Tags can be combined (a wedding shot can also be in the carousel). Editing a
caption's hashtags later works too — the next daily sync re-reads them. To add a
new gallery section, add one entry to `GALLERY_SECTIONS` in `scripts/main.js`.

## Running the site locally

The site fetches `data/*.json`, so it needs to be served over HTTP (opening
`index.html` directly from the filesystem won't work):

```bash
npm run serve        # python3 -m http.server 8080
# or: npx serve .
```

Then open http://localhost:8080. Out of the box it renders sample placeholder
photos from `data/images.json`; the first successful sync replaces them.

## Themes

Two complete themes live in `styles/classic/` (elegant, default) and
`styles/punk/` (dark tattoo/punk). The header toggle swaps the stylesheet and
remembers the choice in `localStorage`. Both files must keep defining the same
selectors — when editing one theme, mirror the selector in the other.

## Pricing & contact form

- **Pricing** comes from `data/pricing.json` — edit packages there and deploy.
  (`highlighted: true` marks the featured package.)
- **Contact form** is wired for [Formspree](https://formspree.io/): create a free
  form, then replace `YOUR_FORM_ID` in the `action` attribute in `index.html`.

## File structure

```
├── index.html                  # single-page site
├── data/
│   ├── images.json             # single source of truth for photos (synced)
│   └── pricing.json            # pricing packages (manual)
├── scripts/
│   ├── sync.js                 # Instagram -> images.json sync (Node 18+, no deps)
│   └── main.js                 # theme toggle, carousel, galleries, lightbox, pricing
├── styles/
│   ├── classic/main.css        # default professional theme
│   └── punk/main.css           # punk/tattoo theme (same selectors)
├── .github/workflows/sync.yml  # daily scheduled sync
└── images/                     # static assets (og-image, etc.)
```

## Known risks / open items

- **Image hotlinking:** the site embeds Instagram `media_url` CDN links directly.
  These generally work, but Instagram CDN changes can break hotlinked images.
  If that happens, the fix is to download the images into `images/` during sync
  and reference local files instead (sync script would need that added).
- **Token expiry:** see "Token renewal" above — roughly once every 60 days a
  human refreshes the token unless/until the renewal call is automated.
