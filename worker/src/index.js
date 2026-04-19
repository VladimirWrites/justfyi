/**
 * JustFYI API — Cloudflare Worker
 *
 * Public endpoints:
 *   POST /submitRating  — community submissions
 *   POST /subscribe     — newsletter email signup
 *
 * Admin endpoints (protected by Cloudflare Access):
 *   GET  /admin              — review dashboard
 *   POST /admin/approve/:id  — approve submission
 *   POST /admin/reject/:id   — reject submission
 *
 * Approved submissions are not auto-published. The maintainer copies them
 * into extension/data/ratings.json by hand and ships a new extension release.
 */

// ─── URL Normalization (keep in sync with extension/background.js) ───
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
  let host = url.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "");
  const endIdx = host.search(/[/?#:]/);
  if (endIdx !== -1) host = host.substring(0, endIdx);

  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(last2) ? parts.slice(-3).join(".") : last2;
}

const VALID_STATUSES = [0, 1, 2, 3];
const VALID_CATEGORIES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 999];
const STATUS_LABELS = { 0: "Out of scope", 1: "Free", 2: "Free with limits", 3: "Paid" };
const CATEGORY_LABELS = { 1: "PDF", 2: "Image", 3: "Video", 4: "Audio", 5: "AI Generate", 6: "Writing", 7: "Dev", 8: "Design", 9: "File Convert", 10: "Notes / Docs", 11: "SEO", 12: "Security", 13: "VPN", 14: "Browser", 15: "Tasks / Project Mgmt", 16: "Cloud Storage", 999: "Other" };
const REVIEW = { PENDING: "pending", APPROVED: "approved", REJECTED: "rejected" };
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_S = 3600;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// IP-based rate limit backed by the rate_limits table. Each call opportunistically
// purges rows older than RATE_LIMIT_WINDOW_S, so IPs never linger as PII.

// Check-and-record: returns true if over limit, otherwise records a new row.
// Used by /submitRating and /subscribe where every successful request counts.
async function isRateLimited(env, ip) {
  if (await checkRateLimit(env, ip)) return true;
  await recordRateLimit(env, ip);
  return false;
}

// Just check without recording. Used by /admin/login so successful logins
// don't consume slots — only failed attempts are recorded.
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

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

// ─── Admin auth ───
// Credentials live in two worker secrets: ADMIN_EMAIL and ADMIN_PASSWORD.
// Access is granted only through the login form (POST /admin/login) that
// sets a stateless session cookie. The cookie value is
//    <expiryMs>.<hexHmacSha256(ADMIN_PASSWORD, expiryMs + ":" + ADMIN_EMAIL)>
// which means we do not store sessions server-side and the cookie cannot
// be forged without the password.
const SESSION_COOKIE = "admin_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

async function handleAdminLogin(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (await checkRateLimit(env, ip)) {
    return htmlResponse(renderLoginHTML("Too many failed attempts. Try again in an hour."), 429);
  }
  const form = await request.formData().catch(() => null);
  const email = (form && form.get("email") || "").toString().trim().toLowerCase();
  const password = (form && form.get("password") || "").toString();
  const goodEmail = env.ADMIN_EMAIL && timingSafeEqual(email, env.ADMIN_EMAIL.toLowerCase());
  const goodPass = env.ADMIN_PASSWORD && timingSafeEqual(password, env.ADMIN_PASSWORD);
  if (!goodEmail || !goodPass) {
    // Only record a rate-limit row when the attempt is wrong so a
    // legitimate user logging in (or out and back in) doesn't burn slots.
    await recordRateLimit(env, ip);
    return htmlResponse(renderLoginHTML("Wrong email or password."), 401);
  }
  const expiry = Date.now() + SESSION_TTL_MS;
  const token = await signSession(env, expiry);
  return new Response(null, {
    status: 302,
    headers: {
      "Location": "/admin",
      "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/admin; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}`,
    },
  });
}

function notFound() {
  return jsonResponse({ error: "Not found" }, 404);
}

function renderLoginHTML(error) {
  const errHtml = error
    ? `<div class="err">${error.replace(/[<>&]/g, c => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;" }[c]))}</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JustFYI Admin — Sign in</title>
<style>
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
</style>
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

// ─── Router ───
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

    // Admin — gated by session cookie set via the login form.
    if (path === "/admin" || path.startsWith("/admin/")) {
      if (path === "/admin/login" && request.method === "POST") {
        return handleAdminLogin(request, env);
      }
      if (path === "/admin/logout" && request.method === "POST") {
        return new Response(null, {
          status: 302,
          headers: {
            "Location": "/admin",
            "Set-Cookie": `${SESSION_COOKIE}=; Path=/admin; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
          },
        });
      }
      // Unauthenticated GET /admin shows the login page. Everything
      // else under /admin/* stays invisible (404) until auth'd.
      if (!(await isAdmin(request, env))) {
        if (path === "/admin" && request.method === "GET") {
          return htmlResponse(renderLoginHTML(null));
        }
        return notFound();
      }
      if (path === "/admin" && request.method === "GET") return handleAdminPage(url, env);
      if (path.startsWith("/admin/approve/") && request.method === "POST") return handleApprove(path, request, env);
      if (path.startsWith("/admin/reject/") && request.method === "POST") return handleReject(path, env);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};

// ═══════════════════════════════════════════
// Public: POST /submitRating
// ═══════════════════════════════════════════
async function handleSubmitRating(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON body." }, 400); }

  const { domain, status, category, openSource, login, abandoned, note } = body;

  if (!domain || typeof domain !== "string" || domain.trim().length === 0)
    return jsonResponse({ error: "domain is required." }, 400);
  if (!VALID_STATUSES.includes(status))
    return jsonResponse({ error: "status must be 0-3." }, 400);
  // Out-of-scope entries don't carry category/flags
  if (status !== 0) {
    if (!VALID_CATEGORIES.includes(category))
      return jsonResponse({ error: "category is invalid." }, 400);
    if (typeof openSource !== "boolean")
      return jsonResponse({ error: "openSource must be a boolean." }, 400);
    if (login !== undefined && typeof login !== "boolean")
      return jsonResponse({ error: "login must be a boolean." }, 400);
    if (abandoned !== undefined && typeof abandoned !== "boolean")
      return jsonResponse({ error: "abandoned must be a boolean." }, 400);
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (await isRateLimited(env, ip))
    return jsonResponse({ error: "Rate limit exceeded. Try again later." }, 429);

  // Community submissions never set "recommended" or "name" — those are
  // curation choices the admin makes after review.
  await env.DB.prepare(
    `INSERT INTO submissions (domain, status, category, open_source, login, abandoned, recommended, name, note, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, datetime('now'))`
  ).bind(
    normalizeUrl(domain), status,
    status === 0 ? 0 : category,
    openSource ? 1 : 0,
    login ? 1 : 0,
    abandoned ? 1 : 0,
    typeof note === "string" ? note.slice(0, 200) : ""
  ).run();

  return jsonResponse({ success: true });
}

// ═══════════════════════════════════════════
// Admin: GET /admin
// ═══════════════════════════════════════════
async function handleAdminPage(url, env) {
  const tab = url.searchParams.get("tab") || REVIEW.PENDING;

  const [pending, recent] = await Promise.all([
    env.DB.prepare("SELECT * FROM submissions WHERE review = ? ORDER BY submitted_at DESC").bind(REVIEW.PENDING).all(),
    // No LIMIT — approved rows are the full catalog, the admin needs to see all of them.
    env.DB.prepare("SELECT * FROM submissions WHERE review != ? ORDER BY review ASC, category ASC, domain ASC").bind(REVIEW.PENDING).all(),
  ]);

  // Attach the latest approved row for each pending submission so the
  // reviewer can see what's actually changing. One query fetches the
  // most recent approved row per distinct domain across all pending.
  const pendingDomains = pending.results.map(s => s.domain);
  let currentByDomain = new Map();
  if (pendingDomains.length) {
    const placeholders = pendingDomains.map(() => "?").join(",");
    const { results: approvedRows } = await env.DB.prepare(
      `SELECT s.* FROM submissions s
       JOIN (
         SELECT domain, MAX(id) AS max_id
         FROM submissions
         WHERE review = 'approved' AND domain IN (${placeholders})
         GROUP BY domain
       ) latest ON s.id = latest.max_id`
    ).bind(...pendingDomains).all();
    currentByDomain = new Map(approvedRows.map(r => [r.domain, r]));
  }
  const pendingWithCurrent = pending.results.map(s => ({
    ...s,
    current: currentByDomain.get(s.domain) || null,
  }));

  return htmlResponse(renderAdminHTML(pendingWithCurrent, recent.results, tab));
}

// ═══════════════════════════════════════════
// Public: POST /subscribe
// ═══════════════════════════════════════════
async function handleSubscribe(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON body." }, 400); }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  // Minimal email shape check. We can't verify deliverability without sending.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return jsonResponse({ error: "Enter a valid email address." }, 400);
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (await isRateLimited(env, ip))
    return jsonResponse({ error: "Rate limit exceeded. Try again later." }, 429);

  // INSERT OR IGNORE so a repeat signup is a silent no-op — avoids leaking
  // whether the address was already on the list.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO subscribers (email, subscribed_at) VALUES (?, datetime('now'))"
  ).bind(email).run();

  return jsonResponse({ success: true });
}

// ═══════════════════════════════════════════
// Admin: POST /admin/approve/:id
// ═══════════════════════════════════════════
async function handleApprove(path, request, env) {
  const id = path.split("/").pop();

  let body = {};
  try { body = await request.json(); } catch {}

  const overrideStatus = body.status;
  const overrideCat = body.category;
  const openSource = body.openSource;

  const sub = await env.DB.prepare("SELECT * FROM submissions WHERE id = ?").bind(id).first();
  if (!sub) return jsonResponse({ error: "Not found" }, 404);

  const finalStatus = overrideStatus !== undefined ? overrideStatus : sub.status;
  const finalCat = overrideCat !== undefined ? overrideCat : sub.category;
  const finalOs = openSource !== undefined ? (openSource ? 1 : 0) : sub.open_source;
  const finalLogin = body.login !== undefined ? (body.login ? 1 : 0) : sub.login;
  const finalAbandoned = body.abandoned !== undefined ? (body.abandoned ? 1 : 0) : sub.abandoned;
  // Curation fields: carry over whatever was on the row by default.
  // The admin can override by passing `name` (string, or empty to clear)
  // and `recommended` (bool) in the approve payload.
  const finalName = body.name !== undefined
    ? (typeof body.name === "string" && body.name.trim() ? body.name.trim() : null)
    : sub.name;
  const finalRec = body.recommended !== undefined ? (body.recommended ? 1 : 0) : sub.recommended;

  await env.DB.prepare(
    `UPDATE submissions
       SET review = ?, status = ?, category = ?, open_source = ?,
           login = ?, abandoned = ?, recommended = ?, name = ?
     WHERE id = ?`
  ).bind(REVIEW.APPROVED, finalStatus, finalCat, finalOs, finalLogin, finalAbandoned, finalRec, finalName, id).run();

  return jsonResponse({ success: true });
}

// ═══════════════════════════════════════════
// Admin: POST /admin/reject/:id
// ═══════════════════════════════════════════
async function handleReject(path, env) {
  const id = path.split("/").pop();
  await env.DB.prepare("UPDATE submissions SET review = ? WHERE id = ?").bind(REVIEW.REJECTED, id).run();
  return jsonResponse({ success: true });
}

// ═══════════════════════════════════════════
// Admin HTML
// ═══════════════════════════════════════════
function renderAdminHTML(pending, reviewed, activeTab) {
  function statusBadge(s) {
    const colors = { 1: "#006C49", 2: "#F59E0B", 3: "#005BC4", 4: "#9F403D", 5: "#6B7280" };
    return `<span style="background:${colors[s] || "#666"};color:#fff;padding:2px 8px;border-radius:100px;font-size:11px;font-weight:600">${STATUS_LABELS[s] || s}</span>`;
  }

  // Mini diff line: for a pending submission whose domain already has an
  // approved row, render a second row under it showing the current
  // values. Any field that differs is highlighted.
  function renderCurrentDiff(sub) {
    if (!sub.current) {
      return `<tr><td colspan="7" style="padding:4px 14px 10px 30px;font-size:12px;color:#9AA0A6;background:#FAFBFD">
        <em>Not in catalog yet — this would be a new entry.</em>
      </td></tr>`;
    }
    const cur = sub.current;
    const mark = (changed, text) =>
      changed
        ? `<span style="background:#FFF3BF;padding:1px 6px;border-radius:4px;font-weight:600">${text}</span>`
        : text;

    const parts = [
      mark(cur.status !== sub.status, `status ${STATUS_LABELS[cur.status] || cur.status}`),
      mark(cur.category !== sub.category, `cat ${CATEGORY_LABELS[cur.category] || cur.category || "—"}`),
      mark(cur.open_source !== sub.open_source, `OS:${cur.open_source ? "yes" : "no"}`),
      mark(cur.login !== sub.login, `login:${cur.login ? "yes" : "no"}`),
      mark(cur.abandoned !== sub.abandoned, `abandoned:${cur.abandoned ? "yes" : "no"}`),
    ];
    const name = cur.name ? `<strong>${cur.name}</strong> · ` : "";
    const rec = cur.recommended ? ` · <span style="color:#006C49;font-weight:600">★ recommended</span>` : "";
    return `<tr><td colspan="7" style="padding:4px 14px 10px 30px;font-size:12px;color:#5A6061;background:#FAFBFD">
      currently: ${name}${parts.join(" · ")}${rec}
    </td></tr>`;
  }

  const escAttr = s => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function renderRow(sub, showActions) {
    const os = sub.open_source ? "Yes" : "No";
    const btn = (label, onclick, bg) =>
      `<button onclick="${onclick}" style="background:${bg};color:#fff;border:none;padding:6px 14px;border-radius:100px;font-size:12px;font-weight:600;cursor:pointer;margin-right:4px">${label}</button>`;

    // Data attributes let the edit dialog read the row's current values
    // (name, rec) without relying on global JS maps.
    const openEditCall = (title) =>
      `openEdit(this, '${escAttr(title)}')`;
    const editAttrs =
      `data-id="${sub.id}" data-name="${escAttr(sub.name || "")}" data-rec="${sub.recommended ? 1 : 0}"`;

    const actions = showActions ? `
      <td style="white-space:nowrap">
        ${btn("Approve", `approve(${sub.id})`, "#006C49")}
        <button ${editAttrs} onclick="${openEditCall('Approve + edit')}" style="background:#005BC4;color:#fff;border:none;padding:6px 14px;border-radius:100px;font-size:12px;font-weight:600;cursor:pointer;margin-right:4px">Approve + edit</button>
        ${btn("Reject", `reject(${sub.id})`, "#9F403D")}
      </td>`
      : `<td style="white-space:nowrap">
          <span style="padding:2px 8px;border-radius:100px;font-size:11px;font-weight:600;background:${sub.review === REVIEW.APPROVED ? '#E8F5E9' : '#FFEBEE'};color:${sub.review === REVIEW.APPROVED ? '#2E7D32' : '#C62828'};margin-right:8px">${sub.review}</span>
          ${sub.review === REVIEW.APPROVED
            ? `<button ${editAttrs} onclick="${openEditCall('Edit entry')}" style="background:#005BC4;color:#fff;border:none;padding:6px 14px;border-radius:100px;font-size:12px;font-weight:600;cursor:pointer">Edit</button>`
            : ""}
        </td>`;

    const nameBit = sub.name ? `<strong>${sub.name}</strong> — ` : "";
    const recBit = sub.recommended ? ' <span style="color:#006C49" title="Recommended">★</span>' : "";

    const mainRow = `<tr>
      <td>${nameBit}<span style="font-weight:500">${sub.domain}</span>${recBit}</td>
      <td>${statusBadge(sub.status)}</td>
      <td>${CATEGORY_LABELS[sub.category] || sub.category}</td>
      <td>${os}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sub.note || "-"}</td>
      <td style="font-size:12px;color:#666">${sub.submitted_at}</td>
      ${actions}
    </tr>`;
    // Diff row is only shown for pending submissions (showActions) where
    // we actually fetched `current`. Reviewed rows skip it.
    return showActions && "current" in sub ? mainRow + renderCurrentDiff(sub) : mainRow;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JustFYI Admin</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Inter, system-ui, sans-serif; background: #FAFAFA; color: #1C1B1F; }
  .header { background: #fff; border-bottom: 1px solid #E0E0E0; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 18px; font-weight: 700; }
  .stats { display: flex; gap: 24px; font-size: 13px; color: #666; }
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
  #toast { position: fixed; bottom: 24px; right: 24px; background: #1C1B1F; color: #fff; padding: 10px 20px; border-radius: 8px; font-size: 13px; display: none; z-index: 100; }

  /* Edit dialog — native <dialog> default positioning varies by browser
     so pin the centering explicitly. */
  dialog#edit-dialog {
    width: 420px; max-width: 90vw; border: none; border-radius: 16px;
    padding: 0; box-shadow: 0 20px 50px rgba(0,0,0,0.18);
    position: fixed;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    margin: 0;
  }
  dialog#edit-dialog::backdrop { background: rgba(0,0,0,0.4); }
  dialog#edit-dialog form { padding: 24px; }
  dialog#edit-dialog h3 {
    font-size: 16px; font-weight: 700; margin-bottom: 4px;
  }
  dialog#edit-dialog .sub {
    font-size: 12px; color: #666; margin-bottom: 20px;
  }
  dialog#edit-dialog label.field {
    display: block; font-size: 12px; font-weight: 600; color: #444; margin: 14px 0 6px;
  }
  dialog#edit-dialog input[type=text] {
    width: 100%; font: inherit; font-size: 14px;
    padding: 10px 12px; border: 1px solid #D0D0D0; border-radius: 8px;
    background: #fff; color: #1C1B1F;
  }
  dialog#edit-dialog input[type=text]:focus {
    outline: none; border-color: #006C49; box-shadow: 0 0 0 3px rgba(0,108,73,0.15);
  }
  dialog#edit-dialog label.check {
    display: flex; align-items: center; gap: 8px; font-size: 14px;
    margin: 18px 0 4px; cursor: pointer;
  }
  dialog#edit-dialog .actions {
    display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px;
  }
  dialog#edit-dialog button {
    padding: 9px 18px; border-radius: 100px; font: inherit; font-size: 13px;
    font-weight: 600; cursor: pointer;
  }
  dialog#edit-dialog .btn-cancel { background: #fff; border: 1px solid #CAC4D0; color: #49454F; }
  dialog#edit-dialog .btn-save   { background: #006C49; border: none; color: #fff; }
  dialog#edit-dialog .btn-save:hover { background: #005A3C; }
</style>
</head>
<body>
<div class="header">
  <h1>JustFYI Admin</h1>
  <div class="stats">
    <span><strong>${pending.length}</strong> pending</span>
    <form method="POST" action="/admin/logout" style="display:inline">
      <button type="submit" style="background:transparent;border:1px solid #CAC4D0;padding:6px 14px;border-radius:100px;font-size:12px;font-weight:600;cursor:pointer;color:#49454F">Sign out</button>
    </form>
  </div>
</div>
<div class="tabs">
  <a class="tab ${activeTab === REVIEW.PENDING ? 'active' : ''}" href="/admin?tab=pending">Pending (${pending.length})</a>
  <a class="tab ${activeTab === 'reviewed' ? 'active' : ''}" href="/admin?tab=reviewed">Reviewed</a>
</div>
<div class="content">
${activeTab === REVIEW.PENDING ? `
  ${pending.length === 0 ? '<div class="empty">No pending submissions.</div>' : `
  <table>
    <thead><tr><th>Domain</th><th>Status</th><th>Category</th><th>OS</th><th>Note</th><th>Submitted</th><th>Actions</th></tr></thead>
    <tbody>${pending.map(s => renderRow(s, true)).join("")}</tbody>
  </table>`}
` : `
  ${reviewed.length === 0 ? '<div class="empty">No reviewed submissions yet.</div>' : `
  <table>
    <thead><tr><th>Domain</th><th>Status</th><th>Category</th><th>OS</th><th>Note</th><th>Submitted</th><th>Status</th></tr></thead>
    <tbody>${reviewed.map(s => renderRow(s, false)).join("")}</tbody>
  </table>`}
`}
</div>
<div id="toast"></div>

<dialog id="edit-dialog">
  <form id="edit-form">
    <h3 id="edit-title">Edit entry</h3>
    <div class="sub" id="edit-domain"></div>
    <label class="field" for="edit-name">Display name</label>
    <input type="text" id="edit-name" placeholder="e.g. Notion (leave blank for none)">
    <label class="check">
      <input type="checkbox" id="edit-rec">
      <span>Recommended ★</span>
    </label>
    <div class="actions">
      <button type="button" class="btn-cancel" onclick="document.getElementById('edit-dialog').close()">Cancel</button>
      <button type="submit" class="btn-save">Save</button>
    </div>
  </form>
</dialog>

<script>
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
  // The row's domain sits in the first cell of the same tr. Show it so
  // the dialog makes clear which row we're editing.
  const domainCell = btn.closest('tr').querySelector('td');
  document.getElementById('edit-domain').textContent = domainCell ? domainCell.innerText.trim() : '';
  document.getElementById('edit-name').value = btn.dataset.name || '';
  document.getElementById('edit-rec').checked = btn.dataset.rec === '1';
  editDialog.showModal();
  document.getElementById('edit-name').focus();
}

document.getElementById('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
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
  // Quick approve: no edits, keep whatever the submission already has.
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
</script>
</body>
</html>`;
}
