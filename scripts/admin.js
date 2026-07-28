/**
 * RawBe Photography — creator upload page logic.
 *
 * Flow per photo:
 *   1. Downscale to max 2560px so uploads are web-sized (already-small
 *      images pass through untouched).
 *   2. SHA-256 the bytes, sign a Blossom auth event (kind 24242).
 *   3. PUT the bytes to every configured Blossom server (mirrors). Returned
 *      URLs are only trusted if they contain the file's SHA-256 (content
 *      addressing) — otherwise we fall back to the canonical /<sha><ext> URL.
 *   4. Sign a NIP-94 file-metadata event (kind 1063) with the URLs, hash,
 *      mime type, caption and the section hashtag, and publish it to relays.
 *
 * The site's sync script (scripts/sync-nostr.js) later reads those public
 * kind-1063 events and rebuilds data/images.json. No API keys anywhere:
 * the creator's Nostr key is the only credential, and it never expires.
 *
 * Security notes:
 *   - nostr-tools is VENDORED at scripts/vendor/nostr-tools.js (exact pinned
 *     version, served from this origin) so no third-party code runs on a
 *     page that handles the creator's key. Do not "upgrade" it to a CDN URL.
 *   - A pasted nsec is kept in memory only — never written to localStorage —
 *     so it dies with the tab. The NIP-07 signer extension is the
 *     recommended path precisely because the key never enters the page.
 *
 * Runs as a browser ES module.
 */

import {
  SimplePool,
  finalizeEvent,
  getPublicKey,
  nip19,
} from "./vendor/nostr-tools.js";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

var METHOD_STORAGE_KEY = "rawbe-nostr-method";
var MAX_IMAGE_EDGE = 2560;
var AUTH_EXPIRY_SECONDS = 600;
var PUBLISH_TIMEOUT_MS = 15000;

/**
 * Formats every visitor's browser can display (matches the allowlist in
 * NOSTR_ARCHITECTURE.md). Doubles as the mime -> extension map.
 */
var SUPPORTED_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/gif": ".gif",
  "image/apng": ".png",
};

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

var config = null; // data/nostr.json
var pool = new SimplePool();
var signer = null; // { method: "nip07"|"nsec", pubkeyHex, signEvent(template) }
var secretKey = null; // nsec path only: in-memory, never persisted
var publishing = false;
var queue = []; // { file, section, captionEl, statusEl, rowEl, thumbEl, thumbUrl, done }

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function $(id) {
  return document.getElementById(id);
}

function log(msg) {
  $("log-card").hidden = false;
  var el = $("log");
  var time = new Date().toLocaleTimeString();
  el.textContent += "[" + time + "] " + msg + "\n";
  el.scrollTop = el.scrollHeight;
}

function hexFromBytes(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/** UTF-8 safe base64 (btoa alone chokes on non-latin1 caption text). */
function base64Encode(str) {
  var bytes = new TextEncoder().encode(str);
  var bin = "";
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function sha256Hex(buffer) {
  return crypto.subtle.digest("SHA-256", buffer).then(function (hash) {
    return hexFromBytes(new Uint8Array(hash));
  });
}

function decodePubkey(npubOrHex) {
  if (/^[0-9a-f]{64}$/i.test(npubOrHex)) return npubOrHex.toLowerCase();
  var decoded = nip19.decode(npubOrHex);
  if (decoded.type !== "npub") throw new Error("Expected an npub");
  return decoded.data;
}

/** Revoke a queue row's object URL so the file bytes can be freed. */
function releaseThumb(item) {
  if (item.thumbUrl) {
    URL.revokeObjectURL(item.thumbUrl);
    item.thumbUrl = null;
  }
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

function loadConfig() {
  return fetch("data/nostr.json")
    .then(function (res) {
      if (!res.ok) throw new Error("Could not load data/nostr.json (serve the site over HTTP).");
      return res.json();
    })
    .then(function (cfg) {
      config = cfg;
      var warning = $("config-warning");
      try {
        config.creatorPubkeyHex = decodePubkey(cfg.pubkey);
      } catch (e) {
        warning.textContent =
          "Site setup incomplete: put the creator's npub in data/nostr.json. Uploads are disabled until then.";
        warning.hidden = false;
      }
      renderTiles();
      restoreLogin();
    })
    .catch(function (err) {
      var warning = $("config-warning");
      warning.textContent = "Config failed to load — uploads are disabled. (" + err.message + ")";
      warning.hidden = false;
    });
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

function makeNsecSigner(key) {
  return {
    method: "nsec",
    pubkeyHex: getPublicKey(key),
    signEvent: function (template) {
      return Promise.resolve(finalizeEvent(template, key));
    },
  };
}

function setSigner(newSigner, persist) {
  if (!config) {
    alert("The site config (data/nostr.json) did not load, so signing in is disabled. See the warning at the top of the page.");
    return;
  }
  signer = newSigner;
  $("signer-options").hidden = true;
  $("identity-status").hidden = false;
  $("identity-npub").textContent = nip19.npubEncode(signer.pubkeyHex);

  var match = $("identity-match");
  match.hidden = false;
  if (!config.creatorPubkeyHex) {
    match.className = "banner banner-warn";
    match.textContent = "The creator pubkey is not configured yet, so uploads are disabled.";
  } else if (signer.pubkeyHex === config.creatorPubkeyHex) {
    match.className = "banner banner-ok";
    match.textContent = "This key matches the configured creator key. Uploads will appear on the site.";
    $("drop-card").hidden = false;
    $("manage-card").hidden = false;
  } else {
    match.className = "banner banner-err";
    match.textContent =
      "This key does NOT match the configured creator key. You can test the flow, but nothing will appear on the site.";
    $("drop-card").hidden = false;
  }

  // Only the NIP-07 method is persisted: the key never enters this page, so
  // restoring it is safe. A pasted nsec is memory-only and dies with the tab.
  if (persist && signer.method === "nip07") {
    localStorage.setItem(METHOD_STORAGE_KEY, "nip07");
  }
  log("Signed in as " + nip19.npubEncode(signer.pubkeyHex));
  updatePublishButton();
}

function loginWithNsec() {
  var input = $("nsec-input").value.trim();
  if (!input) return;
  try {
    var decoded = nip19.decode(input);
    if (decoded.type !== "nsec") throw new Error("not an nsec");
    secretKey = decoded.data;
    setSigner(makeNsecSigner(secretKey), false);
    $("nsec-input").value = "";
  } catch (e) {
    alert("That does not look like a valid nsec key.");
  }
}

function loginWithNip07(silent) {
  if (!window.nostr) {
    if (!silent) alert("No Nostr signer extension found (e.g. Alby or nos2x).");
    return Promise.resolve(false);
  }
  if (!config) {
    if (!silent) alert("The site config (data/nostr.json) did not load, so signing in is disabled.");
    return Promise.resolve(false);
  }
  return window.nostr
    .getPublicKey()
    .then(function (pubkeyHex) {
      setSigner(
        {
          method: "nip07",
          pubkeyHex: pubkeyHex,
          signEvent: function (template) {
            return window.nostr.signEvent(template);
          },
        },
        true
      );
      return true;
    })
    .catch(function () {
      if (!silent) alert("The signer extension refused the request.");
      return false;
    });
}

function restoreLogin() {
  if (localStorage.getItem(METHOD_STORAGE_KEY) === "nip07") {
    loginWithNip07(true);
  }
}

function logout() {
  localStorage.removeItem(METHOD_STORAGE_KEY);
  signer = null;
  secretKey = null;
  publishedPhotos = [];
  $("signer-options").hidden = false;
  $("identity-status").hidden = true;
  $("drop-card").hidden = true;
  $("manage-card").hidden = true;
  $("photos-list").textContent = "";
  $("photos-count").textContent = "";
  log("Signed out.");
  updatePublishButton();
}

/* ------------------------------------------------------------------ */
/* Section tiles                                                       */
/* ------------------------------------------------------------------ */

function renderTiles() {
  var wrap = $("section-tiles");
  wrap.textContent = "";
  (config.sections || []).forEach(function (section) {
    var tile = document.createElement("div");
    tile.className = "tile";

    var title = document.createElement("div");
    title.className = "tile-title";
    title.textContent = section.title;
    tile.appendChild(title);

    var hint = document.createElement("div");
    hint.className = "tile-hint";
    hint.textContent = "drop photos here";
    tile.appendChild(hint);

    var input = document.createElement("input");
    input.type = "file";
    input.accept = Object.keys(SUPPORTED_MIME).join(",");
    input.multiple = true;
    input.hidden = true;
    tile.appendChild(input);

    tile.addEventListener("click", function () {
      input.click();
    });
    input.addEventListener("change", function () {
      addFiles(input.files, section);
      input.value = "";
    });
    tile.addEventListener("dragover", function (e) {
      e.preventDefault();
      tile.classList.add("drag-over");
    });
    tile.addEventListener("dragleave", function () {
      tile.classList.remove("drag-over");
    });
    tile.addEventListener("drop", function (e) {
      e.preventDefault();
      tile.classList.remove("drag-over");
      addFiles(e.dataTransfer.files, section);
    });

    wrap.appendChild(tile);
  });
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

function addFiles(fileList, section) {
  var added = 0;
  Array.prototype.forEach.call(fileList, function (file) {
    if (!file.type || !SUPPORTED_MIME[file.type]) {
      log(
        "Skipped " + file.name + " (" + (file.type || "unknown type") +
        ") — supported: JPEG, PNG, WebP, AVIF, GIF, APNG. iPhone users: set camera format to 'Most Compatible' (JPEG)."
      );
      return;
    }
    var row = document.createElement("div");
    row.className = "queue-row";

    var thumbUrl = URL.createObjectURL(file);
    var thumb = document.createElement("img");
    thumb.src = thumbUrl;
    thumb.alt = "";
    row.appendChild(thumb);

    var meta = document.createElement("div");
    meta.className = "queue-meta";
    var name = document.createElement("div");
    name.className = "queue-name";
    name.textContent = file.name;
    var sec = document.createElement("div");
    sec.className = "queue-section";
    sec.textContent = section.title;
    var caption = document.createElement("input");
    caption.className = "queue-caption";
    caption.type = "text";
    caption.placeholder = "Caption (optional)";
    meta.appendChild(name);
    meta.appendChild(sec);
    meta.appendChild(caption);
    row.appendChild(meta);

    var status = document.createElement("div");
    status.className = "queue-status";
    status.textContent = "ready";
    row.appendChild(status);

    $("queue-list").appendChild(row);
    queue.push({
      file: file,
      section: section,
      captionEl: caption,
      statusEl: status,
      rowEl: row,
      thumbEl: thumb,
      thumbUrl: thumbUrl,
      done: false,
    });
    added++;
  });
  if (added) {
    $("queue-card").hidden = false;
    updatePublishButton();
  }
}

function updatePublishButton() {
  var pending = queue.filter(function (item) {
    return !item.done;
  }).length;
  $("publish-all").textContent = pending ? "Publish " + pending + " photo" + (pending > 1 ? "s" : "") : "Publish photos";
  $("publish-all").disabled =
    !pending || publishing || !signer || !config || !config.creatorPubkeyHex;
}

function setStatus(item, text, state) {
  item.statusEl.textContent = text;
  item.rowEl.classList.remove("done", "failed");
  if (state) item.rowEl.classList.add(state);
}

/* ------------------------------------------------------------------ */
/* Image prep                                                          */
/* ------------------------------------------------------------------ */

/**
 * Downscale anything larger than MAX_IMAGE_EDGE to web size. Images already
 * within bounds pass through byte-identical (no needless re-encode). GIFs
 * pass through untouched to preserve animation.
 */
function prepareImage(file) {
  if (file.type === "image/gif") return Promise.resolve(file);

  return createImageBitmap(file)
    .then(function (bmp) {
      var scale = Math.min(1, MAX_IMAGE_EDGE / bmp.width, MAX_IMAGE_EDGE / bmp.height);
      if (scale >= 1) {
        bmp.close();
        return file;
      }
      var w = Math.max(1, Math.round(bmp.width * scale));
      var h = Math.max(1, Math.round(bmp.height * scale));
      var canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
      bmp.close();
      var outType = file.type === "image/png" || file.type === "image/apng" ? "image/png" : "image/jpeg";
      return new Promise(function (resolve) {
        canvas.toBlob(
          function (blob) {
            if (!blob) return resolve(file);
            var ext = SUPPORTED_MIME[outType] || ".jpg";
            var name = file.name.replace(/\.[^.]+$/, "") + ext;
            resolve(new File([blob], name, { type: outType }));
          },
          outType,
          0.88
        );
      });
    })
    .catch(function () {
      return file; // browser can't decode it — upload original as-is
    });
}

/* ------------------------------------------------------------------ */
/* Blossom upload (BUD-02)                                             */
/* ------------------------------------------------------------------ */

function blossomAuthEvent(sha, size, name) {
  var now = Math.floor(Date.now() / 1000);
  return signer.signEvent({
    kind: 24242,
    created_at: now,
    tags: [
      ["t", "upload"],
      ["x", sha],
      ["size", String(size)],
      ["expiration", String(now + AUTH_EXPIRY_SECONDS)],
    ],
    content: "Upload " + name + " to the RawBe Photography site",
  });
}

/** Canonical content-addressed URL for a blob on a given server. */
function canonicalUrl(server, sha, mime) {
  return server.replace(/\/$/, "") + "/" + sha + (SUPPORTED_MIME[mime] || "");
}

function uploadToServer(server, file, sha) {
  return blossomAuthEvent(sha, file.size, file.name).then(function (auth) {
    return fetch(server.replace(/\/$/, "") + "/upload", {
      method: "PUT",
      headers: {
        Authorization: "Nostr " + base64Encode(JSON.stringify(auth)),
        "Content-Type": file.type,
      },
      body: file,
    });
  }).then(function (res) {
    if (!res.ok) throw new Error(server + " rejected the upload (" + res.status + ")");
    return res.json().then(function (descriptor) {
      var url = descriptor && descriptor.url;
      // Only trust the returned URL if it is content-addressed by our hash.
      // A malicious/compromised server could otherwise substitute an
      // arbitrary (mutable, tracking) URL that the site would hotlink.
      if (url && url.indexOf(sha) !== -1) return url;
      if (url) log(server + " returned a non-content-addressed URL; using the canonical hash URL instead.");
      return canonicalUrl(server, sha, file.type);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Nostr publish (NIP-94, kind 1063)                                   */
/* ------------------------------------------------------------------ */

function publishMetadata(item, sha, urls, file) {
  var caption = item.captionEl.value.trim();
  var tags = [
    ["m", file.type],
    ["x", sha],
    ["size", String(file.size)],
    ["t", item.section.tag],
    ["alt", caption || "Photograph by RawBe Photography"],
  ];
  urls.forEach(function (url) {
    tags.push(["url", url]);
  });

  var now = Math.floor(Date.now() / 1000);
  return signer
    .signEvent({ kind: 1063, created_at: now, tags: tags, content: caption })
    .then(function (event) {
      var publications = pool.publish(config.relays, event);
      return Promise.race([
        Promise.any(publications),
        new Promise(function (_, reject) {
          setTimeout(function () {
            reject(new Error("relay publish timed out"));
          }, PUBLISH_TIMEOUT_MS);
        }),
      ]);
    });
}

/* ------------------------------------------------------------------ */
/* Publish pipeline                                                    */
/* ------------------------------------------------------------------ */

function processItem(item) {
  setStatus(item, "preparing…");
  return prepareImage(item.file)
    .then(function (prepared) {
      item.prepared = prepared;
      if (prepared !== item.file) {
        log(item.file.name + ": resized to web size (" + Math.round(prepared.size / 1024) + " KB).");
      }
      setStatus(item, "hashing…");
      return prepared.arrayBuffer().then(sha256Hex);
    })
    .then(function (sha) {
      item.sha = sha;
      setStatus(item, "uploading…");
      var uploads = config.blossomServers.map(function (server) {
        return uploadToServer(server, item.prepared, sha);
      });
      return Promise.allSettled(uploads).then(function (results) {
        var urls = results
          .filter(function (r) {
            return r.status === "fulfilled";
          })
          .map(function (r) {
            return r.value;
          });
        results.forEach(function (r) {
          if (r.status === "rejected") log("Mirror failed: " + r.reason.message);
        });
        if (!urls.length) throw new Error("every blossom server rejected the upload");
        log(item.file.name + ": stored on " + urls.length + " of " + config.blossomServers.length + " servers.");
        return urls;
      });
    })
    .then(function (urls) {
      setStatus(item, "signing…");
      return publishMetadata(item, item.sha, urls, item.prepared).then(function () {
        return urls;
      });
    })
    .then(function (urls) {
      setStatus(item, "published", "done");
      item.done = true;
      // Swap the local preview for the uploaded copy (proves it serves),
      // then free the local file bytes.
      item.thumbEl.src = urls[0];
      releaseThumb(item);
      log(item.file.name + ": published to relays.");
    })
    .catch(function (err) {
      setStatus(item, "failed: " + err.message, "failed");
      log("FAILED " + item.file.name + ": " + err.message);
    });
}

function publishAll() {
  if (!signer || !config || publishing) return;
  if (signer.pubkeyHex !== config.creatorPubkeyHex) {
    if (!confirm("This key does not match the configured creator key — nothing will appear on the site. Continue anyway?")) {
      return;
    }
  }
  publishing = true;
  updatePublishButton();
  var pending = queue.filter(function (item) {
    return !item.done;
  });
  // Sequential: gentler on relays and free blossom servers.
  var chain = Promise.resolve();
  pending.forEach(function (item) {
    chain = chain.then(function () {
      return processItem(item);
    });
  });
  chain.then(function () {
    publishing = false;
    updatePublishButton();
    log("Queue finished.");
  });
}

function clearDone() {
  queue = queue.filter(function (item) {
    if (item.done) {
      releaseThumb(item);
      item.rowEl.remove();
      return false;
    }
    return true;
  });
  if (!queue.length) $("queue-card").hidden = true;
  updatePublishButton();
}

/* ------------------------------------------------------------------ */
/* Manage published photos (NIP-09 deletion)                          */
/* ------------------------------------------------------------------ */

var PHOTO_EVENT_KIND = 1063;
var DELETE_EVENT_KIND = 5;
var QUERY_MAX_WAIT_MS = 20000;

var publishedPhotos = []; // { id, url, caption, tags, sha, event }

function tagValues(event, name) {
  return event.tags.filter(function (t) {
    return t[0] === name && t[1];
  }).map(function (t) {
    return t[1];
  });
}

/** Fetch the creator's published kind-1063 photo events from relays. */
function fetchPublishedPhotos() {
  if (!signer || !config) {
    log("Sign in first to load published photos.");
    return Promise.resolve([]);
  }
  if (!config.creatorPubkeyHex) {
    log("Creator pubkey not configured — cannot load photos.");
    return Promise.resolve([]);
  }

  log("Fetching published photos from relays…");
  $("load-photos").disabled = true;
  $("photos-count").textContent = "loading…";

  return pool
    .querySync(
      config.relays,
      { kinds: [PHOTO_EVENT_KIND], authors: [config.creatorPubkeyHex] },
      { maxWait: QUERY_MAX_WAIT_MS }
    )
    .then(function (events) {
      // Dedupe by hash (same photo re-published = edit, keep newest)
      var byHash = new Map();
      events.forEach(function (event) {
        var sha = tagValues(event, "x")[0];
        if (!sha) return;
        var prev = byHash.get(sha);
        if (!prev || event.created_at > prev.created_at) byHash.set(sha, event);
      });

      publishedPhotos = Array.from(byHash.values())
        .map(function (event) {
          var urls = tagValues(event, "url");
          var sha = tagValues(event, "x")[0];
          return {
            id: event.id,
            url: urls[0] || "",
            caption: event.content || "",
            tags: tagValues(event, "t"),
            sha: sha,
            event: event,
          };
        })
        .filter(function (p) {
          return p.url;
        })
        .sort(function (a, b) {
          return b.event.created_at - a.event.created_at;
        });

      log("Loaded " + publishedPhotos.length + " published photo" + (publishedPhotos.length === 1 ? "" : "s") + ".");
      renderPhotosList();
      return publishedPhotos;
    })
    .catch(function (err) {
      log("Failed to load photos: " + err.message);
      $("photos-count").textContent = "failed to load";
      return [];
    })
    .finally(function () {
      $("load-photos").disabled = false;
    });
}

/** Render the list of published photos with delete buttons. */
function renderPhotosList() {
  var wrap = $("photos-list");
  wrap.textContent = "";
  $("photos-count").textContent = publishedPhotos.length
    ? publishedPhotos.length + " photo" + (publishedPhotos.length === 1 ? "" : "s") + " published"
    : "no published photos";

  publishedPhotos.forEach(function (photo) {
    var row = document.createElement("div");
    row.className = "photo-row";
    row.dataset.eventId = photo.id;

    var thumb = document.createElement("img");
    thumb.src = photo.url;
    thumb.alt = photo.caption || "Published photo";
    thumb.loading = "lazy";
    row.appendChild(thumb);

    var meta = document.createElement("div");
    meta.className = "photo-meta";

    var caption = document.createElement("div");
    caption.className = "photo-caption";
    caption.textContent = photo.caption || "(no caption)";
    meta.appendChild(caption);

    var info = document.createElement("div");
    info.className = "photo-info";
    var sectionTag = photo.tags.find(function (t) {
      return (config.sections || []).some(function (s) {
        return s.tag === t;
      });
    });
    info.textContent = (sectionTag || photo.tags[0] || "untagged") + " · " +
      new Date(photo.event.created_at * 1000).toLocaleDateString();
    meta.appendChild(info);

    row.appendChild(meta);

    var actions = document.createElement("div");
    actions.className = "photo-actions";

    var deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-small btn-danger";
    deleteBtn.type = "button";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", function () {
      deletePhoto(photo, row);
    });
    actions.appendChild(deleteBtn);

    row.appendChild(actions);
    wrap.appendChild(row);
  });
}

/**
 * Delete a published photo via NIP-09 (kind-5 deletion request).
 * Relays that honor NIP-09 will remove the referenced event.
 */
function deletePhoto(photo, rowEl) {
  if (!signer) {
    alert("Sign in first to delete photos.");
    return;
  }
  if (signer.pubkeyHex !== config.creatorPubkeyHex) {
    alert("Only the creator key can delete photos.");
    return;
  }

  var label = photo.caption || photo.url.slice(-40);
  if (!confirm("Delete this photo?\n\n" + label + "\n\nThis publishes a deletion request to the relays. The photo will disappear from the site after the next sync.")) {
    return;
  }

  rowEl.classList.add("deleting");
  var btn = rowEl.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Deleting…";
  log("Deleting " + label + "…");

  var now = Math.floor(Date.now() / 1000);
  var deleteEvent = {
    kind: DELETE_EVENT_KIND,
    created_at: now,
    tags: [
      ["e", photo.id],
      ["k", String(PHOTO_EVENT_KIND)],
    ],
    content: "Deleted via RawBe Photography admin panel",
  };

  signer
    .signEvent(deleteEvent)
    .then(function (signed) {
      var publications = pool.publish(config.relays, signed);
      return Promise.race([
        Promise.any(publications),
        new Promise(function (_, reject) {
          setTimeout(function () {
            reject(new Error("relay publish timed out"));
          }, PUBLISH_TIMEOUT_MS);
        }),
      ]);
    })
    .then(function () {
      log("Deleted " + label + " — removal appears on the site after the next sync.");
      // Remove from local list and re-render
      publishedPhotos = publishedPhotos.filter(function (p) {
        return p.id !== photo.id;
      });
      rowEl.remove();
      $("photos-count").textContent = publishedPhotos.length
        ? publishedPhotos.length + " photo" + (publishedPhotos.length === 1 ? "" : "s") + " published"
        : "no published photos";
    })
    .catch(function (err) {
      log("Failed to delete " + label + ": " + err.message);
      rowEl.classList.remove("deleting");
      btn.disabled = false;
      btn.textContent = "Delete";
    });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

$("nsec-login").addEventListener("click", loginWithNsec);
$("nip07-login").addEventListener("click", function () {
  loginWithNip07(false);
});
$("logout").addEventListener("click", logout);
$("publish-all").addEventListener("click", publishAll);
$("clear-done").addEventListener("click", clearDone);
$("load-photos").addEventListener("click", fetchPublishedPhotos);

if (window.nostr) $("nip07-login").hidden = false;

loadConfig();
