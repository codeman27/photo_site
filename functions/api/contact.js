/**
 * Contact form handler — Cloudflare Pages Function.
 *
 * Receives the contact form POST at /api/contact, validates the input, and
 * forwards the message to the site owner via MailChannels (free with
 * Cloudflare Pages/Workers — no account or API key needed).
 *
 * Env vars (Cloudflare Pages dashboard -> Settings -> Environment variables):
 *   CONTACT_EMAIL  (required) — where messages are delivered
 *   FROM_EMAIL     (optional) — sender address on the outgoing email
 *
 * Spam protection: a hidden "website" honeypot field. Humans never see it,
 * bots fill it in, and those submissions are silently accepted (and dropped).
 */

const MAX_NAME = 100;
const MAX_EMAIL = 200;
const MAX_MESSAGE = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Progressive enhancement: fetch/XHR callers get JSON; a plain no-JS form
 * post gets redirected back to the site with a status flag in the URL.
 */
function respond(request, payload, status) {
  const accept = request.headers.get("accept") || "";
  if (accept.includes("application/json")) {
    return Response.json(payload, { status });
  }
  const target = payload.ok ? "success" : "error";
  return Response.redirect(new URL("/?contact=" + target + "#contact", request.url), 303);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.CONTACT_EMAIL) {
    return respond(request, { ok: false, error: "The contact form is not configured yet." }, 500);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return respond(request, { ok: false, error: "Invalid form submission." }, 400);
  }

  const get = (key) => (formData.get(key) || "").toString().trim();
  const name = get("name");
  const email = get("email");
  const sessionType = get("session_type");
  const message = get("message");
  const honeypot = get("website");

  // Honeypot triggered: pretend it worked so the bot moves on.
  if (honeypot) {
    return respond(request, { ok: true }, 200);
  }

  if (!name || !email || !message) {
    return respond(request, { ok: false, error: "Please fill in your name, email, and a message." }, 400);
  }
  if (!EMAIL_RE.test(email)) {
    return respond(request, { ok: false, error: "That email address doesn't look right." }, 400);
  }
  if (name.length > MAX_NAME || email.length > MAX_EMAIL || message.length > MAX_MESSAGE) {
    return respond(request, { ok: false, error: "One of the fields is too long." }, 400);
  }

  const subject = "Contact form: " + (sessionType || "general") + " inquiry from " + name;
  const text = [
    "Name: " + name,
    "Email: " + email,
    "Session type: " + (sessionType || "(not specified)"),
    "",
    "Message:",
    message,
  ].join("\n");

  const mail = await fetch("https://api.mailchannels.net/tx/v1/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: env.CONTACT_EMAIL }] }],
      from: {
        email: env.FROM_EMAIL || "contact-form@rawbephotography.com",
        name: "RawBe Photography website",
      },
      reply_to: { email: email, name: name },
      subject: subject,
      content: [{ type: "text/plain", value: text }],
    }),
  });

  if (!mail.ok) {
    return respond(request, { ok: false, error: "Message failed to send — please try again." }, 502);
  }

  return respond(request, { ok: true }, 200);
}

export async function onRequestGet() {
  return new Response("Method not allowed", { status: 405 });
}
