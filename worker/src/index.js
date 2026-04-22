/**
 * JustFYI API — Cloudflare Worker
 *
 * Public endpoints:
 *   POST /submitRating  — community submissions
 *   POST /subscribe     — newsletter email signup
 *
 * Admin endpoints (protected by email + password login):
 *   GET  /admin              — dashboard (or login form if unauth'd)
 *   POST /admin/login        — set session cookie
 *   POST /admin/logout       — clear session cookie
 *   POST /admin/approve/:id  — approve / edit a submission
 *   POST /admin/reject/:id   — reject a submission
 *
 * Approved rows are the admin's working copy; the shipping ratings.json
 * is still updated by hand.
 */


// ───────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────

const VALID_STATUSES = [0, 1, 2, 3];
const VALID_CATEGORIES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 999];

const STATUS_LABELS = {
  0: "Out of scope",
  1: "Free",
  2: "Free with limits",
  3: "Paid",
};
const STATUS_COLORS = {
  0: "#6B7280",
  1: "#006C49",
  2: "#F59E0B",
  3: "#9F403D",
};
const CATEGORY_LABELS = {
  1: "PDF", 2: "Image", 3: "Video", 4: "Audio", 5: "AI Generate",
  6: "Writing", 7: "Dev", 8: "Design", 9: "File Convert",
  10: "Notes / Docs", 11: "SEO", 12: "Security", 13: "VPN",
  14: "Browser", 15: "Tasks / Project Mgmt", 16: "Cloud Storage",
  17: "Communication", 18: "Email", 19: "Learning", 20: "Analytics",
  21: "Automation", 22: "Video Calls",
  23: "Code Hosting", 24: "Deploy / Hosting", 25: "Playgrounds / Online IDE",
  26: "Finance / Accounting", 27: "Forms & Surveys", 28: "CRM / Sales",
  29: "Translation", 30: "3D / CAD", 31: "Maps / Navigation",
  32: "Password Manager",
  999: "Other",
};

// Normalise any of these inputs into a sorted-unique int[] of valid cats:
//   • `categories: [17, 22]`  — new canonical
//   • `category: 17`          — legacy single-int, accepted for compat
//   • JSON string '[17, 22]'  — what we store in D1
// Returns null if input is missing/invalid so the caller can fall back.
function parseCategories(body) {
  let raw = body?.categories ?? (body?.category !== undefined ? [body.category] : null);
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { return null; } }
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const v of raw) {
    const n = typeof v === "number" ? v : parseInt(v, 10);
    if (!VALID_CATEGORIES.includes(n)) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

// Parse the stored categories string on a D1 row. Always returns an array.
function rowCategories(row) {
  try { return JSON.parse(row.categories || "[]"); } catch { return []; }
}
const REVIEW = { PENDING: "pending", APPROVED: "approved", REJECTED: "rejected" };

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_S = 3600;

const SESSION_COOKIE = "admin_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};


// ───────────────────────────────────────────────────────────
// Response helpers
// ───────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

function notFound() {
  return jsonResponse({ error: "Not found" }, 404);
}


// ───────────────────────────────────────────────────────────
// Escape / sanitize
// ───────────────────────────────────────────────────────────

// Escape the 5 characters that matter in either HTML text nodes or
// attribute values. Safe for both, so we only need one function.
function escHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Strip control chars (incl CR/LF for SMTP-header hygiene), collapse
// whitespace, trim, and cap length. Returns "" for non-strings.
function sanitizeText(v, maxLen) {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  let s = v.replace(/[\x00-\x1F\x7F]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
function parseEmail(v) {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\x00-\x1F\x7F]/g, "").trim().toLowerCase();
  if (s.length < 3 || s.length > 254) return null;
  if (!EMAIL_RE.test(s)) return null;
  return s;
}


// ───────────────────────────────────────────────────────────
// URL normalization
// (duplicated in extension/background.js — keep in sync)
// ───────────────────────────────────────────────────────────

const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk",
  "co.jp", "ne.jp", "or.jp", "ac.jp",
  "co.kr", "co.in", "co.id", "co.il", "co.nz", "co.za", "co.th",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "com.ar", "com.be", "com.br", "com.cn", "com.co", "com.hk", "com.mx",
  "com.my", "com.pe", "com.ph", "com.pk", "com.sg", "com.tr", "com.tw",
  "com.uy", "com.ve",
]);

function normalizeUrl(url) {
  let host = url.trim().toLowerCase().replace(/^https?:\/\//, "");
  const endIdx = host.search(/[/?#:]/);
  if (endIdx !== -1) host = host.substring(0, endIdx);

  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(last2) ? parts.slice(-3).join(".") : last2;
}


// ───────────────────────────────────────────────────────────
// Rate limiting — IP-based, stored in rate_limits table.
// Each call opportunistically purges rows older than the window,
// so IPs never linger as PII.
// ───────────────────────────────────────────────────────────

async function checkRateLimit(env, ip) {
  await env.DB.prepare(
    "DELETE FROM rate_limits WHERE created_at < datetime('now', ?)"
  ).bind(`-${RATE_LIMIT_WINDOW_S} seconds`).run();
  const { results } = await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM rate_limits WHERE ip = ?"
  ).bind(ip).all();
  return results[0].cnt >= RATE_LIMIT_MAX;
}

async function recordRateLimit(env, ip) {
  await env.DB.prepare(
    "INSERT INTO rate_limits (ip, created_at) VALUES (?, datetime('now'))"
  ).bind(ip).run();
}

// Check + record. Used by /submitRating and /subscribe where every
// successful request counts. /admin/login uses checkRateLimit +
// recordRateLimit separately so successful logins don't burn slots.
async function isRateLimited(env, ip) {
  if (await checkRateLimit(env, ip)) return true;
  await recordRateLimit(env, ip);
  return false;
}


// ───────────────────────────────────────────────────────────
// Admin auth — stateless HMAC-signed session cookie.
// Credentials live in ADMIN_EMAIL and ADMIN_PASSWORD secrets.
// Cookie value is  <expiryMs>.<hex HMAC-SHA256(ADMIN_PASSWORD, expiryMs + ":" + ADMIN_EMAIL)>
// — no server-side session storage, and the cookie can't be forged
// without the password.
// ───────────────────────────────────────────────────────────

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

async function hmacHex(key, msg) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function signSession(env, expiryMs) {
  const sig = await hmacHex(env.ADMIN_PASSWORD, `${expiryMs}:${env.ADMIN_EMAIL}`);
  return `${expiryMs}.${sig}`;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function isAdmin(request, env) {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) return false;
  const cookie = readCookie(request, SESSION_COOKIE);
  if (!cookie) return false;
  const dot = cookie.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(cookie.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = await signSession(env, exp);
  return timingSafeEqual(expected, cookie);
}

// Shared cookie attributes for set + clear responses.
function sessionCookie(value, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${value}; Path=/admin; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}


// ───────────────────────────────────────────────────────────
// Public handlers
// ───────────────────────────────────────────────────────────

async function handleSubmitRating(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body." }, 400); }

  const { domain, status, openSource, login, abandoned, subscription, note } = body;

  if (!domain || typeof domain !== "string" || domain.trim().length === 0)
    return jsonResponse({ error: "domain is required." }, 400);
  if (!VALID_STATUSES.includes(status))
    return jsonResponse({ error: "status must be 0-3." }, 400);

  // Out-of-scope entries don't carry category/flags
  let cats = [];
  if (status !== 0) {
    cats = parseCategories(body);
    if (!cats || cats.length === 0)
      return jsonResponse({ error: "category is required (provide `categories: [..]` or `category: N`)." }, 400);
    if (typeof openSource !== "boolean")
      return jsonResponse({ error: "openSource must be a boolean." }, 400);
    if (login !== undefined && typeof login !== "boolean")
      return jsonResponse({ error: "login must be a boolean." }, 400);
    if (abandoned !== undefined && typeof abandoned !== "boolean")
      return jsonResponse({ error: "abandoned must be a boolean." }, 400);
    if (subscription !== undefined && typeof subscription !== "boolean")
      return jsonResponse({ error: "subscription must be a boolean." }, 400);
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (await isRateLimited(env, ip))
    return jsonResponse({ error: "Rate limit exceeded. Try again later." }, 429);

  // Community submissions never set "recommended" or "name" — those
  // are curation choices the admin makes after review.
  await env.DB.prepare(
    `INSERT INTO submissions (domain, status, category, categories, open_source, login, abandoned, subscription, recommended, name, note, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, datetime('now'))`
  ).bind(
    normalizeUrl(domain), status,
    status === 0 ? 0 : cats[0],      // legacy `category` column — keep first cat for back-compat
    JSON.stringify(cats),            // canonical `categories` column
    openSource ? 1 : 0,
    login ? 1 : 0,
    abandoned ? 1 : 0,
    subscription ? 1 : 0,
    sanitizeText(note, 200)
  ).run();

  return jsonResponse({ success: true });
}

async function handleSubscribe(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body." }, 400); }

  const email = parseEmail(body.email);
  if (!email) return jsonResponse({ error: "Enter a valid email address." }, 400);

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (await isRateLimited(env, ip))
    return jsonResponse({ error: "Rate limit exceeded. Try again later." }, 429);

  // INSERT OR IGNORE so a repeat signup is a silent no-op — avoids
  // leaking whether the address was already on the list.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO subscribers (email, subscribed_at) VALUES (?, datetime('now'))"
  ).bind(email).run();

  return jsonResponse({ success: true });
}


// ───────────────────────────────────────────────────────────
// Admin handlers
// ───────────────────────────────────────────────────────────

async function handleAdminLogin(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (await checkRateLimit(env, ip))
    return htmlResponse(renderLoginHTML("Too many failed attempts. Try again in an hour."), 429);

  const form = await request.formData().catch(() => null);
  // Normalise login fields the same way submissions are cleaned so a
  // stray newline, null byte, or a few MB of junk can't reach compare.
  const rawEmail = form && form.get("email") ? String(form.get("email")) : "";
  // eslint-disable-next-line no-control-regex
  const email = rawEmail.replace(/[\x00-\x1F\x7F]/g, "").trim().toLowerCase().slice(0, 254);
  const rawPw = form && form.get("password") ? String(form.get("password")) : "";
  // eslint-disable-next-line no-control-regex
  const password = rawPw.replace(/[\x00-\x1F\x7F]/g, "").slice(0, 256);

  const goodEmail = env.ADMIN_EMAIL && timingSafeEqual(email, env.ADMIN_EMAIL.toLowerCase());
  const goodPass = env.ADMIN_PASSWORD && timingSafeEqual(password, env.ADMIN_PASSWORD);
  if (!goodEmail || !goodPass) {
    // Only wrong attempts cost a rate-limit slot.
    await recordRateLimit(env, ip);
    return htmlResponse(renderLoginHTML("Wrong email or password."), 401);
  }

  const expiry = Date.now() + SESSION_TTL_MS;
  const token = await signSession(env, expiry);
  return new Response(null, {
    status: 302,
    headers: {
      "Location": "/admin",
      "Set-Cookie": sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)),
    },
  });
}

function handleAdminLogout() {
  return new Response(null, {
    status: 302,
    headers: {
      "Location": "/admin",
      "Set-Cookie": sessionCookie("", 0),
    },
  });
}

// GET /admin/export → downloadable ratings.json built from the
// approved rows in D1. Ordering matches what's hand-curated in the
// repo:
//   1. Recommended entries, sorted by category then id.
//   2. Blank line.
//   3. Non-recommended with a real category, grouped by category with
//      a blank line between category groups.
//   4. Blank line.
//   5. Out-of-scope (status = 0) entries at the end.
async function handleAdminExport(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM submissions
     WHERE review = ?
     ORDER BY recommended DESC, (status = 0) ASC, category ASC, id ASC`
  ).bind(REVIEW.APPROVED).all();

  const lines = ["["];
  let prev = null;
  for (let i = 0; i < results.length; i++) {
    const row = results[i];
    const isRec = row.recommended === 1;
    const isOos = row.status === 0;

    if (prev) {
      const recEnded = prev.isRec && !isRec;
      const nonRecCatChanged = !isRec && !isOos && !prev.isOos && row.category !== prev.category;
      const oosStarted = isOos && !prev.isOos;
      if (recEnded || nonRecCatChanged || oosStarted) lines.push("");
    }

    const comma = i < results.length - 1 ? "," : "";
    lines.push("  " + formatJsonEntry(rowToJsonEntry(row)) + comma);
    prev = { isRec, isOos, category: row.category };
  }
  lines.push("]", "");  // trailing newline

  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ratings.json"',
      "Cache-Control": "no-store",
    },
  });
}

// Single-line JSON object with a space after every ":" and ",", to
// match the hand-curated ratings.json style.
function formatJsonEntry(obj) {
  const pairs = Object.entries(obj).map(
    ([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`
  );
  return `{ ${pairs.join(", ")} }`;
}

// Build a ratings.json entry from a D1 submissions row. Field order
// matches the hand-curated file: d, s, os, cat, n, rec, lg, ab. The
// `cat` field is a scalar when the entry has exactly one category and
// an array when it has more — preserves the existing file's shape for
// single-cat entries while allowing multi-cat when we need it.
function rowToJsonEntry(row) {
  if (row.status === 0) return { d: row.domain, s: 0 };
  const cats = rowCategories(row);
  const e = {
    d: row.domain,
    s: row.status,
    os: Boolean(row.open_source),
    cat: cats.length === 1 ? cats[0] : cats,
  };
  if (row.name) e.n = row.name;
  if (row.recommended) e.rec = true;
  if (row.login) e.lg = true;
  if (row.abandoned) e.ab = true;
  if (row.subscription) e.sb = true;
  return e;
}

async function handleAdminPage(url, env) {
  const tab = url.searchParams.get("tab") || REVIEW.PENDING;

  const [pending, recent] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM submissions WHERE review = ? ORDER BY submitted_at DESC"
    ).bind(REVIEW.PENDING).all(),
    // No LIMIT — approved rows are the full catalog, the admin needs
    // to see all of them. Sorted for stable browsing.
    env.DB.prepare(
      "SELECT * FROM submissions WHERE review != ? ORDER BY review ASC, category ASC, domain ASC"
    ).bind(REVIEW.PENDING).all(),
  ]);

  const pendingWithCurrent = await attachCurrentApproved(env, pending.results);
  return htmlResponse(renderAdminHTML(pendingWithCurrent, recent.results, tab));
}

// For each pending submission, look up the most recent approved row
// for the same domain so the diff view can show what would change.
// Chunked because D1 caps a single query at 100 bound parameters.
async function attachCurrentApproved(env, pendingRows) {
  if (!pendingRows.length) return pendingRows.map(s => ({ ...s, current: null }));

  const domains = [...new Set(pendingRows.map(s => s.domain))];
  const byDomain = new Map();
  const CHUNK = 90;
  for (let i = 0; i < domains.length; i += CHUNK) {
    const slice = domains.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT s.* FROM submissions s
       JOIN (
         SELECT domain, MAX(id) AS max_id
         FROM submissions
         WHERE review = 'approved' AND domain IN (${placeholders})
         GROUP BY domain
       ) latest ON s.id = latest.max_id`
    ).bind(...slice).all();
    for (const r of results) byDomain.set(r.domain, r);
  }

  return pendingRows.map(s => ({ ...s, current: byDomain.get(s.domain) || null }));
}

async function handleApprove(path, request, env) {
  const id = path.split("/").pop();

  let body = {};
  try { body = await request.json(); } catch {}

  const sub = await env.DB.prepare("SELECT * FROM submissions WHERE id = ?").bind(id).first();
  if (!sub) return notFound();

  // Pick each field from the request body, falling back to whatever
  // was stored on the submission row.
  const asInt01 = v => (v ? 1 : 0);
  const pick = (key, fallback, transform = v => v) =>
    body[key] !== undefined ? transform(body[key]) : fallback;

  const finalStatus = pick("status", sub.status);
  const finalOs = pick("openSource", sub.open_source, asInt01);
  const finalLogin = pick("login", sub.login, asInt01);
  const finalAbandoned = pick("abandoned", sub.abandoned, asInt01);
  const finalSubscription = pick("subscription", sub.subscription, asInt01);
  const finalRec = pick("recommended", sub.recommended, asInt01);

  // Categories: accept new `categories` array OR legacy `category` int,
  // falling back to whatever's on the row.
  let finalCats = rowCategories(sub);
  if (body.categories !== undefined || body.category !== undefined) {
    const parsed = parseCategories(body);
    if (parsed) finalCats = parsed;
  }
  const finalCat = finalCats[0] ?? 0;  // legacy column

  // Curation name: "" or whitespace-only clears the field; otherwise
  // clean and cap at 80 chars.
  let finalName = sub.name;
  if (body.name !== undefined) {
    const cleaned = sanitizeText(body.name, 80);
    finalName = cleaned.length ? cleaned : null;
  }

  await env.DB.prepare(
    `UPDATE submissions
       SET review = ?, status = ?, category = ?, categories = ?, open_source = ?,
           login = ?, abandoned = ?, subscription = ?, recommended = ?, name = ?
     WHERE id = ?`
  ).bind(
    REVIEW.APPROVED, finalStatus, finalCat, JSON.stringify(finalCats), finalOs,
    finalLogin, finalAbandoned, finalSubscription, finalRec, finalName, id
  ).run();

  return jsonResponse({ success: true });
}

async function handleReject(path, env) {
  const id = path.split("/").pop();
  await env.DB.prepare("UPDATE submissions SET review = ? WHERE id = ?")
    .bind(REVIEW.REJECTED, id).run();
  return jsonResponse({ success: true });
}


// ───────────────────────────────────────────────────────────
// HTML templates
// ───────────────────────────────────────────────────────────

const LOGIN_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, system-ui, sans-serif;
    background: #FAFAFA;
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    color: #1C1B1F;
  }
  .card {
    width: 360px; max-width: 90vw;
    background: #fff; border: 1px solid #E0E0E0; border-radius: 16px;
    padding: 32px; box-shadow: 0 4px 16px rgba(0,0,0,0.06);
  }
  h1 { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
  .sub { font-size: 13px; color: #666; margin-bottom: 20px; }
  label { display: block; font-size: 12px; font-weight: 600; color: #444; margin: 14px 0 6px; }
  input {
    width: 100%; font: inherit; font-size: 14px;
    padding: 10px 12px; border: 1px solid #D0D0D0; border-radius: 8px;
    background: #fff; color: #1C1B1F;
  }
  input:focus { outline: none; border-color: #006C49; box-shadow: 0 0 0 3px rgba(0,108,73,0.15); }
  button {
    margin-top: 20px; width: 100%;
    padding: 11px; border: none; border-radius: 100px; cursor: pointer;
    background: #006C49; color: #fff; font: inherit; font-size: 14px; font-weight: 600;
  }
  button:hover { background: #005A3C; }
  .err {
    font-size: 13px; color: #9F403D;
    background: rgba(159,64,61,0.08); padding: 10px 12px; border-radius: 8px;
    margin-bottom: 16px;
  }
`;

function renderLoginHTML(error) {
  const errHtml = error ? `<div class="err">${escHtml(error)}</div>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JustFYI Admin — Sign in</title>
<style>${LOGIN_CSS}</style>
</head>
<body>
<form class="card" method="POST" action="/admin/login" autocomplete="off">
  <h1>JustFYI Admin</h1>
  <div class="sub">Sign in to review submissions.</div>
  ${errHtml}
  <label for="email">Email</label>
  <input type="email" id="email" name="email" required autocomplete="username">
  <label for="password">Password</label>
  <input type="password" id="password" name="password" required autocomplete="current-password">
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;
}

const ADMIN_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Inter, system-ui, sans-serif; background: #FAFAFA; color: #1C1B1F; }
  .header { background: #fff; border-bottom: 1px solid #E0E0E0; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 18px; font-weight: 700; }
  .stats { display: flex; gap: 24px; align-items: center; font-size: 13px; color: #666; }
  .stats strong { color: #1C1B1F; }
  .tabs { display: flex; gap: 0; border-bottom: 1px solid #E0E0E0; background: #fff; padding: 0 24px; }
  .tab { padding: 12px 20px; font-size: 13px; font-weight: 600; color: #666; cursor: pointer; border-bottom: 2px solid transparent; text-decoration: none; }
  .tab.active { color: #006C49; border-bottom-color: #006C49; }
  .content { padding: 24px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  th { text-align: left; padding: 10px 14px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #666; background: #F5F5F5; border-bottom: 1px solid #E0E0E0; }
  td { padding: 10px 14px; font-size: 13px; border-bottom: 1px solid #F0F0F0; }
  tr:last-child td { border-bottom: none; }
  .empty { text-align: center; padding: 48px; color: #999; font-size: 14px; }

  /* Pill buttons — work for both <button> and <a> uses. */
  .btn { display: inline-flex; align-items: center; border: none; padding: 6px 14px; border-radius: 100px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; margin-right: 4px; color: #fff; text-decoration: none; }
  .btn--approve { background: #006C49; }
  .btn--edit { background: #005BC4; }
  .btn--reject { background: #9F403D; }
  .btn--ghost { background: transparent; border: 1px solid #CAC4D0; color: #49454F; margin: 0; }

  /* Status / review badges */
  .status-badge { display: inline-block; color: #fff; padding: 2px 8px; border-radius: 100px; font-size: 11px; font-weight: 600; }
  .review-badge { padding: 2px 8px; border-radius: 100px; font-size: 11px; font-weight: 600; margin-right: 8px; }
  .review-badge--approved { background: #E8F5E9; color: #2E7D32; }
  .review-badge--rejected { background: #FFEBEE; color: #C62828; }

  /* Pending diff subrow */
  .diff { padding: 4px 14px 10px 30px; font-size: 12px; background: #FAFBFD; }
  .diff--new { color: #9AA0A6; }
  .diff--changed { color: #5A6061; }
  .diff-mark { background: #FFF3BF; padding: 1px 6px; border-radius: 4px; font-weight: 600; }

  /* Name / rec indicator in the domain cell */
  .row-name { font-weight: 700; }
  .row-rec  { color: #006C49; }
  .row-domain { font-weight: 500; color: inherit; text-decoration: none; }
  .row-domain:hover { color: #006C49; text-decoration: underline; }

  /* NEW / CHANGE pill on pending rows — tells the admin at a glance
     whether approving this will add a row to the catalog or overwrite
     an existing one. */
  .kind { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; margin-right: 8px; vertical-align: middle; }
  .kind--new    { background: #E8F5E9; color: #2E7D32; }
  .kind--change { background: #FFF3BF; color: #8A6D00; }

  /* Login / abandoned flags in the domain cell */
  .flag { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; margin-left: 6px; vertical-align: middle; }
  .flag--lg { background: #E3F2FD; color: #0D47A1; }
  .flag--ab { background: #EEE; color: #555; }
  .flag--sb { background: #FFF3E0; color: #8A5A00; }

  /* Per-table filter bar */
  .filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; padding: 10px 14px; background: #fff; border: 1px solid #E0E0E0; border-radius: 8px; }
  .filters input, .filters select { padding: 6px 10px; border: 1px solid #D0D0D0; border-radius: 6px; font: inherit; font-size: 12px; background: #fff; color: #1C1B1F; }
  .filters input.f-search { flex: 1; min-width: 220px; }
  .filters input:focus, .filters select:focus { outline: none; border-color: #006C49; box-shadow: 0 0 0 2px rgba(0,108,73,0.15); }
  .filters .f-clear { padding: 6px 14px; border: 1px solid #CAC4D0; background: #fff; border-radius: 100px; cursor: pointer; font: inherit; font-size: 12px; color: #49454F; }
  .filters .f-count { margin-left: auto; font-size: 12px; color: #666; }

  #toast { position: fixed; bottom: 24px; right: 24px; background: #1C1B1F; color: #fff; padding: 10px 20px; border-radius: 8px; font-size: 13px; display: none; z-index: 100; }

  /* Edit dialog — native <dialog> default positioning varies by browser,
     so pin the centering explicitly. */
  dialog#edit-dialog {
    width: 540px; max-width: 90vw; max-height: 90vh; overflow-y: auto;
    border: none; border-radius: 16px;
    padding: 0; box-shadow: 0 20px 50px rgba(0,0,0,0.18);
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); margin: 0;
  }
  dialog#edit-dialog .hint { font-weight: 400; color: #888; font-size: 11px; }
  dialog#edit-dialog .cat-grid {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px 14px;
    border: 1px solid #E0E0E0; border-radius: 8px; padding: 10px 12px;
  }
  dialog#edit-dialog .cat-grid label.check { margin: 2px 0; font-size: 12.5px; }
  dialog#edit-dialog::backdrop { background: rgba(0,0,0,0.4); }
  dialog#edit-dialog form { padding: 24px; }
  dialog#edit-dialog h3 { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
  dialog#edit-dialog .sub { font-size: 12px; color: #666; margin-bottom: 20px; }
  dialog#edit-dialog label.field { display: block; font-size: 12px; font-weight: 600; color: #444; margin: 14px 0 6px; }
  dialog#edit-dialog input[type=text],
  dialog#edit-dialog select {
    width: 100%; font: inherit; font-size: 14px;
    padding: 10px 12px; border: 1px solid #D0D0D0; border-radius: 8px;
    background: #fff; color: #1C1B1F;
  }
  /* Replace the native select arrow with an SVG we can position with
     real padding, instead of fighting the browser's default offset. */
  dialog#edit-dialog select {
    appearance: none; -webkit-appearance: none;
    padding-right: 38px;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%2349454F'><path d='M5 8l5 5 5-5z'/></svg>");
    background-repeat: no-repeat;
    background-position: right 14px center;
    background-size: 14px;
  }
  dialog#edit-dialog input[type=text]:focus,
  dialog#edit-dialog select:focus { outline: none; border-color: #006C49; box-shadow: 0 0 0 3px rgba(0,108,73,0.15); }
  dialog#edit-dialog .row { display: flex; gap: 12px; }
  dialog#edit-dialog .row > label.field { flex: 1; }
  dialog#edit-dialog .checks { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; margin-top: 16px; }
  dialog#edit-dialog label.check { display: flex; align-items: center; gap: 8px; font-size: 14px; margin: 4px 0; cursor: pointer; }
  dialog#edit-dialog .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  dialog#edit-dialog button { padding: 9px 18px; border-radius: 100px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
  dialog#edit-dialog .btn-cancel { background: #fff; border: 1px solid #CAC4D0; color: #49454F; }
  dialog#edit-dialog .btn-save   { background: #006C49; border: none; color: #fff; }
  dialog#edit-dialog .btn-save:hover { background: #005A3C; }
`;

// Admin JS kept as a top-level constant so it isn't buried inside a
// string template. Read/edit here with normal syntax support.
const ADMIN_JS = `
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2500);
}
function toastAndReload(msg) {
  toast(msg);
  setTimeout(() => location.reload(), 500);
}

const editDialog = document.getElementById('edit-dialog');
let editingId = null;
let editingAction = null; // 'approve' or 'update'

function openEdit(btn, title) {
  editingId = btn.dataset.id;
  editingAction = title.startsWith('Approve') ? 'approve' : 'update';
  document.getElementById('edit-title').textContent = title;
  const domainCell = btn.closest('tr').querySelector('td');
  document.getElementById('edit-domain').textContent = domainCell ? domainCell.innerText.trim() : '';

  document.getElementById('edit-status').value = btn.dataset.status;
  const selectedCats = new Set(JSON.parse(btn.dataset.categories || '[]').map(String));
  for (const cb of document.querySelectorAll('#edit-categories input[name="cat"]')) {
    cb.checked = selectedCats.has(cb.value);
  }
  document.getElementById('edit-os').checked = btn.dataset.os === '1';
  document.getElementById('edit-lg').checked = btn.dataset.lg === '1';
  document.getElementById('edit-ab').checked = btn.dataset.ab === '1';
  document.getElementById('edit-sb').checked = btn.dataset.sb === '1';
  document.getElementById('edit-name').value = btn.dataset.name || '';
  document.getElementById('edit-rec').checked = btn.dataset.rec === '1';

  editDialog.showModal();
  document.getElementById('edit-name').focus();
}

document.getElementById('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const categories = [...document.querySelectorAll('#edit-categories input[name="cat"]:checked')]
    .map(cb => parseInt(cb.value, 10));
  const body = {
    status: parseInt(document.getElementById('edit-status').value, 10),
    categories,
    openSource: document.getElementById('edit-os').checked,
    login: document.getElementById('edit-lg').checked,
    abandoned: document.getElementById('edit-ab').checked,
    subscription: document.getElementById('edit-sb').checked,
    name: document.getElementById('edit-name').value.trim(),
    recommended: document.getElementById('edit-rec').checked,
  };
  await fetch('/admin/approve/' + editingId, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
  editDialog.close();
  toastAndReload(editingAction === 'approve' ? 'Approved' : 'Updated');
});

async function approve(id) {
  await fetch('/admin/approve/' + id, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}',
  });
  toastAndReload('Approved');
}
async function reject(id) {
  if (!confirm('Reject this submission?')) return;
  await fetch('/admin/reject/' + id, { method: 'POST' });
  toastAndReload('Rejected');
}

function initFilters(scope) {
  const bar = document.querySelector('.filters[data-scope="' + scope + '"]');
  if (!bar) return;
  const table = bar.nextElementSibling;
  const rows = [...table.querySelectorAll('tbody > tr[data-row]')];
  const countEl = bar.querySelector('.f-count');
  const qEl = bar.querySelector('.f-search');
  const sEl = bar.querySelector('.f-status');
  const cEl = bar.querySelector('.f-cat');
  const oEl = bar.querySelector('.f-os');
  const fEl = bar.querySelector('.f-flag');
  const rEl = bar.querySelector('.f-review');

  // Restore from localStorage so filters survive reloads after
  // approve/reject/update actions.
  const storeKey = 'filters:' + scope;
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey) || '{}');
    if (saved.q != null) qEl.value = saved.q;
    if (saved.s != null) sEl.value = saved.s;
    if (saved.c != null) cEl.value = saved.c;
    if (saved.o != null) oEl.value = saved.o;
    if (saved.f != null) fEl.value = saved.f;
    if (rEl && saved.r != null) rEl.value = saved.r;
  } catch {}

  const save = () => {
    const state = { q: qEl.value, s: sEl.value, c: cEl.value, o: oEl.value, f: fEl.value };
    if (rEl) state.r = rEl.value;
    localStorage.setItem(storeKey, JSON.stringify(state));
  };

  const apply = () => {
    const q = qEl.value.trim().toLowerCase();
    const s = sEl.value;
    const c = cEl.value;
    const o = oEl.value;
    const f = fEl.value;
    const rv = rEl ? rEl.value : '';
    let visible = 0;
    for (const tr of rows) {
      let show = true;
      if (q && !(tr.dataset.domain.includes(q) || tr.dataset.name.includes(q) || tr.dataset.note.includes(q))) show = false;
      if (show && s && tr.dataset.status !== s) show = false;
      if (show && c) {
        const cats = JSON.parse(tr.dataset.cats || '[]');
        if (!cats.includes(parseInt(c, 10))) show = false;
      }
      if (show && o && tr.dataset.os !== o) show = false;
      if (show && f) {
        if (f === 'rec' && tr.dataset.rec !== '1') show = false;
        else if (f === 'lg' && tr.dataset.lg !== '1') show = false;
        else if (f === 'ab' && tr.dataset.ab !== '1') show = false;
        else if (f === 'sb' && tr.dataset.sb !== '1') show = false;
        else if (f === 'none' && (tr.dataset.rec === '1' || tr.dataset.lg === '1' || tr.dataset.ab === '1' || tr.dataset.sb === '1')) show = false;
      }
      if (show && rv && tr.dataset.review !== rv) show = false;
      tr.style.display = show ? '' : 'none';
      const next = tr.nextElementSibling;
      if (next && next.dataset.diff) next.style.display = show ? '' : 'none';
      if (show) visible++;
    }
    countEl.textContent = visible + ' of ' + rows.length;
  };

  const onChange = () => { save(); apply(); };
  bar.addEventListener('input', onChange);
  bar.addEventListener('change', onChange);
  bar.querySelector('.f-clear').addEventListener('click', () => {
    qEl.value = ''; sEl.value = ''; cEl.value = ''; oEl.value = ''; fEl.value = '';
    if (rEl) rEl.value = '';
    localStorage.removeItem(storeKey);
    apply();
  });
  apply();
}
initFilters('pending');
initFilters('reviewed');
`;

function renderStatusBadge(s) {
  return `<span class="status-badge" style="background:${STATUS_COLORS[s] || "#666"}">${escHtml(STATUS_LABELS[s] || s)}</span>`;
}

// Subrow under each pending submission showing the currently-shipped
// values. Yellow-highlights the fields that differ.
function renderDiffRow(sub) {
  if (!sub.current) {
    return `<tr data-diff="1"><td colspan="7" class="diff diff--new"><em>Not in catalog yet — this would be a new entry.</em></td></tr>`;
  }
  const cur = sub.current;
  const mark = (changed, text) =>
    changed ? `<span class="diff-mark">${text}</span>` : text;

  const curCats = rowCategories(cur);
  const subCats = rowCategories(sub);
  const sameCats = curCats.length === subCats.length
    && curCats.every((c, i) => c === subCats[i]);
  const curCatsLabel = curCats.map(c => escHtml(CATEGORY_LABELS[c] || c)).join(" / ") || "—";

  const parts = [
    mark(cur.status !== sub.status,
      `status ${escHtml(STATUS_LABELS[cur.status] || cur.status)}`),
    mark(!sameCats, `cats ${curCatsLabel}`),
    mark(cur.open_source !== sub.open_source, `OS:${cur.open_source ? "yes" : "no"}`),
    mark(cur.login !== sub.login, `login:${cur.login ? "yes" : "no"}`),
    mark(cur.abandoned !== sub.abandoned, `abandoned:${cur.abandoned ? "yes" : "no"}`),
    mark(cur.subscription !== sub.subscription, `sub:${cur.subscription ? "yes" : "no"}`),
  ];
  const name = cur.name ? `<strong>${escHtml(cur.name)}</strong> · ` : "";
  const rec = cur.recommended ? ' · <span style="color:#006C49;font-weight:600">★ recommended</span>' : "";
  return `<tr data-diff="1"><td colspan="7" class="diff diff--changed">currently: ${name}${parts.join(" · ")}${rec}</td></tr>`;
}

function renderRow(sub, showActions) {
  const os = sub.open_source ? "Yes" : "No";
  const cats = rowCategories(sub);
  const catsLabel = cats.map(c => escHtml(CATEGORY_LABELS[c] || c)).join(", ") || "—";
  // Every field the edit dialog needs, stuffed on the button so the JS
  // can read them without another network call. data-categories is a
  // JSON string so the dialog can parse and tick the right checkboxes.
  const editAttrs = [
    `data-id="${sub.id}"`,
    `data-status="${sub.status}"`,
    `data-categories="${escHtml(JSON.stringify(cats))}"`,
    `data-os="${sub.open_source ? 1 : 0}"`,
    `data-lg="${sub.login ? 1 : 0}"`,
    `data-ab="${sub.abandoned ? 1 : 0}"`,
    `data-sb="${sub.subscription ? 1 : 0}"`,
    `data-rec="${sub.recommended ? 1 : 0}"`,
    `data-name="${escHtml(sub.name || "")}"`,
  ].join(" ");

  const actions = showActions
    ? `<td style="white-space:nowrap">
        <button class="btn btn--approve" onclick="approve(${sub.id})">Approve</button>
        <button class="btn btn--edit" ${editAttrs} onclick="openEdit(this, 'Approve + edit')">Approve + edit</button>
        <button class="btn btn--reject" onclick="reject(${sub.id})">Reject</button>
      </td>`
    : `<td style="white-space:nowrap">
        <span class="review-badge review-badge--${sub.review}">${sub.review}</span>
        ${sub.review === REVIEW.APPROVED
          ? `<button class="btn btn--edit" ${editAttrs} onclick="openEdit(this, 'Edit entry')">Edit</button>`
          : ""}
      </td>`;

  const nameBit = sub.name ? `<span class="row-name">${escHtml(sub.name)}</span> — ` : "";
  const recBit = sub.recommended ? ' <span class="row-rec" title="Recommended">★</span>' : "";
  const lgBit = sub.login ? ' <span class="flag flag--lg" title="Requires login">login</span>' : "";
  const abBit = sub.abandoned ? ' <span class="flag flag--ab" title="Abandoned project">abandoned</span>' : "";
  const sbBit = sub.subscription ? ' <span class="flag flag--sb" title="Subscription-based pricing">sub</span>' : "";
  // On pending rows, lead with a NEW / CHANGE pill so approving-on-autopilot
  // can't accidentally overwrite a curated entry.
  const kindBit = showActions && "current" in sub
    ? (sub.current
        ? '<span class="kind kind--change" title="Will overwrite an existing approved row">CHANGE</span>'
        : '<span class="kind kind--new" title="Will add a new row to the catalog">NEW</span>')
    : "";

  const rowData = [
    `data-row="1"`,
    `data-domain="${escHtml(sub.domain.toLowerCase())}"`,
    `data-name="${escHtml((sub.name || "").toLowerCase())}"`,
    `data-note="${escHtml((sub.note || "").toLowerCase())}"`,
    `data-status="${sub.status}"`,
    `data-cats="${escHtml(JSON.stringify(cats))}"`,
    `data-os="${sub.open_source ? 1 : 0}"`,
    `data-lg="${sub.login ? 1 : 0}"`,
    `data-ab="${sub.abandoned ? 1 : 0}"`,
    `data-sb="${sub.subscription ? 1 : 0}"`,
    `data-rec="${sub.recommended ? 1 : 0}"`,
    `data-review="${escHtml(sub.review || "")}"`,
  ].join(" ");

  const mainRow = `<tr ${rowData}>
    <td>${kindBit}${nameBit}<a class="row-domain" href="https://${escHtml(sub.domain)}" target="_blank" rel="noopener noreferrer">${escHtml(sub.domain)}</a>${recBit}${lgBit}${abBit}${sbBit}</td>
    <td>${renderStatusBadge(sub.status)}</td>
    <td>${catsLabel}</td>
    <td>${os}</td>
    <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sub.note ? escHtml(sub.note) : "-"}</td>
    <td style="font-size:12px;color:#666">${escHtml(sub.submitted_at)}</td>
    ${actions}
  </tr>`;

  return showActions && "current" in sub ? mainRow + renderDiffRow(sub) : mainRow;
}

function renderFilterBar(scope) {
  const catOptions = Object.entries(CATEGORY_LABELS)
    .map(([v, l]) => `<option value="${v}">${escHtml(l)}</option>`)
    .join("");
  const reviewFilter = scope === "reviewed"
    ? `<select class="f-review">
         <option value="">Any review</option>
         <option value="approved">Approved</option>
         <option value="rejected">Rejected</option>
       </select>`
    : "";
  return `<div class="filters" data-scope="${scope}">
    <input type="search" class="f-search" placeholder="Search domain, name, or note…">
    <select class="f-status">
      <option value="">Any status</option>
      <option value="1">Free</option>
      <option value="2">Free with limits</option>
      <option value="3">Paid</option>
      <option value="0">Out of scope</option>
    </select>
    <select class="f-cat">
      <option value="">Any category</option>
      ${catOptions}
    </select>
    <select class="f-os">
      <option value="">Any source</option>
      <option value="1">Open source</option>
      <option value="0">Proprietary</option>
    </select>
    <select class="f-flag">
      <option value="">Any flag</option>
      <option value="rec">★ Recommended</option>
      <option value="lg">Requires login</option>
      <option value="ab">Abandoned</option>
      <option value="sb">Subscription</option>
      <option value="none">No flags</option>
    </select>
    ${reviewFilter}
    <button type="button" class="f-clear">Clear</button>
    <span class="f-count"></span>
  </div>`;
}

function renderAdminHTML(pending, reviewed, activeTab) {
  const pendingTab = `
    ${pending.length === 0
      ? '<div class="empty">No pending submissions.</div>'
      : `${renderFilterBar("pending")}
        <table>
          <thead><tr><th>Domain</th><th>Status</th><th>Category</th><th>OS</th><th>Note</th><th>Submitted</th><th>Actions</th></tr></thead>
          <tbody>${pending.map(s => renderRow(s, true)).join("")}</tbody>
        </table>`}`;

  const reviewedTab = `
    ${reviewed.length === 0
      ? '<div class="empty">No reviewed submissions yet.</div>'
      : `${renderFilterBar("reviewed")}
        <table>
          <thead><tr><th>Domain</th><th>Status</th><th>Category</th><th>OS</th><th>Note</th><th>Submitted</th><th>Status</th></tr></thead>
          <tbody>${reviewed.map(s => renderRow(s, false)).join("")}</tbody>
        </table>`}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JustFYI Admin</title>
<style>${ADMIN_CSS}</style>
</head>
<body>
<div class="header">
  <h1>JustFYI Admin</h1>
  <div class="stats">
    <span><strong>${pending.length}</strong> pending</span>
    <a class="btn btn--ghost" href="/admin/export" download="ratings.json">Export JSON</a>
    <form method="POST" action="/admin/logout" style="display:inline">
      <button type="submit" class="btn btn--ghost">Sign out</button>
    </form>
  </div>
</div>
<div class="tabs">
  <a class="tab ${activeTab === REVIEW.PENDING ? 'active' : ''}" href="/admin?tab=pending">Pending (${pending.length})</a>
  <a class="tab ${activeTab === 'reviewed' ? 'active' : ''}" href="/admin?tab=reviewed">Reviewed</a>
</div>
<div class="content">${activeTab === REVIEW.PENDING ? pendingTab : reviewedTab}</div>

<div id="toast"></div>

<dialog id="edit-dialog">
  <form id="edit-form">
    <h3 id="edit-title">Edit entry</h3>
    <div class="sub" id="edit-domain"></div>

    <label class="field">Status
      <select id="edit-status">
        <option value="1">Free</option>
        <option value="2">Free with limits</option>
        <option value="3">Paid</option>
        <option value="0">Out of scope</option>
      </select>
    </label>

    <label class="field">Categories <span class="hint">(pick one or more)</span></label>
    <div class="cat-grid" id="edit-categories">
      ${Object.entries(CATEGORY_LABELS).map(([v, l]) =>
        `<label class="check"><input type="checkbox" name="cat" value="${v}"> ${escHtml(l)}</label>`
      ).join("")}
    </div>

    <label class="field" for="edit-name">Display name</label>
    <input type="text" id="edit-name" placeholder="e.g. Notion (leave blank for none)">

    <div class="checks">
      <label class="check"><input type="checkbox" id="edit-os"> Open source</label>
      <label class="check"><input type="checkbox" id="edit-lg"> Requires login</label>
      <label class="check"><input type="checkbox" id="edit-ab"> Abandoned</label>
      <label class="check"><input type="checkbox" id="edit-sb"> Subscription</label>
      <label class="check"><input type="checkbox" id="edit-rec"> Recommended ★</label>
    </div>

    <div class="actions">
      <button type="button" class="btn-cancel" onclick="document.getElementById('edit-dialog').close()">Cancel</button>
      <button type="submit" class="btn-save">Save</button>
    </div>
  </form>
</dialog>

<script>${ADMIN_JS}</script>
</body>
</html>`;
}


// ───────────────────────────────────────────────────────────
// Router
// ───────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Public
    if (path === "/submitRating" && request.method === "POST") return handleSubmitRating(request, env);
    if (path === "/subscribe" && request.method === "POST") return handleSubscribe(request, env);

    // Admin — gated by session cookie (email + password login).
    if (path === "/admin" || path.startsWith("/admin/")) {
      if (path === "/admin/login" && request.method === "POST") return handleAdminLogin(request, env);
      if (path === "/admin/logout" && request.method === "POST") return handleAdminLogout();

      // Unauthenticated GET /admin shows the login page. Everything
      // else under /admin/* stays invisible (404) until auth'd.
      if (!(await isAdmin(request, env))) {
        if (path === "/admin" && request.method === "GET") return htmlResponse(renderLoginHTML(null));
        return notFound();
      }

      if (path === "/admin" && request.method === "GET") return handleAdminPage(url, env);
      if (path === "/admin/export" && request.method === "GET") return handleAdminExport(env);
      if (path.startsWith("/admin/approve/") && request.method === "POST") return handleApprove(path, request, env);
      if (path.startsWith("/admin/reject/") && request.method === "POST") return handleReject(path, env);
    }

    return notFound();
  },
};
