/**
 * Contact form handler — Cloudflare Pages Function.
 *
 * Uses Cloudflare's native Email Service (env.EMAIL.send()) — no third-party
 * service or API key required beyond the send_email binding in wrangler.toml.
 *
 * One-time setup:
 *   1. Onboard your domain at Cloudflare dash → Email Sending → Onboard Domain.
 *      Cloudflare will auto-add SPF/DKIM/DMARC records.
 *   2. Update FROM_DOMAIN below to that domain.
 *   3. Deploy: npx wrangler pages deploy .
 *
 * Spam protection: a hidden "website" honeypot field silently drops bots.
 */

// ── Update these two constants before deploying ──────────────────────────────
const FROM_DOMAIN = "rawbephotography.com"; // must be onboarded in Cloudflare Email Sending
const CONTACT_EMAIL = "rawbephotography970@gmail.com"; // where form submissions are delivered
// ─────────────────────────────────────────────────────────────────────────────

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

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.EMAIL) {
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

  const subject = "New inquiry: " + (sessionType || "general") + " \u2014 " + name;
  const textBody = [
    "Name: " + name,
    "Email: " + email,
    "Session type: " + (sessionType || "(not specified)"),
    "",
    "Message:",
    message,
  ].join("\n");
  const htmlBody = `<h2>New Contact Form Submission</h2>
<p><strong>Name:</strong> ${escapeHtml(name)}</p>
<p><strong>Email:</strong> ${escapeHtml(email)}</p>
<p><strong>Session type:</strong> ${escapeHtml(sessionType || "(not specified)")}</p>
<p><strong>Message:</strong></p>
<p style="white-space:pre-wrap">${escapeHtml(message)}</p>`;

  try {
    await env.EMAIL.send({
      to: CONTACT_EMAIL,
      from: "Contact Form <forms@" + FROM_DOMAIN + ">",
      reply_to: email,
      subject: subject,
      text: textBody,
      html: htmlBody,
    });
  } catch (err) {
    return respond(request, { ok: false, error: "Message failed to send \u2014 please try again." }, 502);
  }

  return respond(request, { ok: true }, 200);
}

export async function onRequestGet() {
  return new Response("Method not allowed", { status: 405 });
}
