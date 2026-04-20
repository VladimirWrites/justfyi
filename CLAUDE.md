# JustFYI -- Claude Code Guidelines

## Project Overview
Browser extension (justfyi.app) that tells users whether an online tool is actually free, freemium, paid, or abandoned — before they upload a file. Hand-curated ratings, bundled as local JSON. No login in extension.

## Project Structure
- `/extension/` -- Chrome extension (Manifest V3, vanilla JS)
- `/extension/data/ratings.json` -- Bundled ratings database
- `/worker/` -- Cloudflare Worker + D1 (single submitRating endpoint)
- `/landing/` -- Landing page (static HTML)

## Key Constraints
- Extension NEVER contacts server while browsing -- only during active submission
- All lookups are local against bundled JSON loaded into chrome.storage.local on install
- No login UI in extension -- no auth at all
- No runtime ratings sync — the bundled file IS the ratings database. New ratings ship with extension releases
- URL normalization logic is duplicated in extension/background.js and worker/src/index.js -- keep in sync
- No inline scripts in extension HTML (MV3 CSP)
- All code bundled in extension, no remote script loading
- Vanilla JS only in extension, no frameworks

## Backend (Cloudflare)
- Worker endpoints:
  - POST /submitRating — community submissions (public)
  - POST /subscribe — newsletter email signup (public)
  - GET /admin — submission review dashboard (Cloudflare Access protected)
  - POST /admin/approve/:id — mark submission approved in D1
  - POST /admin/reject/:id — reject submission
- D1 tables:
  - `submissions` — rating submissions with review column (pending/approved/rejected). No IP/UA stored.
  - `subscribers` — newsletter emails only (email + subscribed_at). No IP/UA stored.
  - `rate_limits` — short-lived IP log for rate limiting, purged opportunistically on each request (~1h lifetime)
- Rate limit: 5 writes per IP per hour, shared across /submitRating and /subscribe
- Admin auth via Cloudflare Access (zero-trust, no code)
- Approved submissions are NOT auto-published — maintainer manually copies approved rows from D1 into extension/data/ratings.json and ships a new extension release
- PII policy: long-lived tables (`submissions`, `subscribers`) store NO IP or User-Agent. IPs live only in `rate_limits` for at most one hour.

## Commands
- `cd worker && npm install` -- install worker dependencies
- `cd worker && npm run dev` -- local dev server
- `cd worker && npm run deploy` -- deploy to Cloudflare
- `cd worker && npm run db:init` -- initialize D1 schema

## Rating Statuses
0=out_of_scope, 1=free, 2=free_with_limits, 3=paid

Status is the money/friction axis. Login and abandoned are orthogonal flags — any status can be combined with `lg: true` (requires signup) and/or `ab: true` (project no longer maintained).

## JSON Schema
- `d`: domain string (normalized, plain text)
- `s`: status number (0-3)
- `os`: boolean (open source) -- all except out_of_scope
- `cat`: category number -- all except out_of_scope
- `n`: display name string -- optional, populate for any well-known tool
- `rec`: boolean -- true only for curated recommended alternatives (requires `n`)
- `lg`: boolean -- true if the free tier requires signup/account
- `ab`: boolean -- true if the project is sunset / no longer maintained

## Categories
1=PDF, 2=Image, 3=Video, 4=Audio, 5=AI Generate, 6=Writing, 7=Dev, 8=Design, 9=File Convert, 10=Notes / Docs, 11=SEO, 12=Security, 13=VPN, 14=Browser, 15=Tasks / Project Mgmt, 16=Cloud Storage, 17=Communication, 18=Email, 19=Learning, 20=Analytics, 21=Automation, 22=Video Calls, 23=Code Hosting, 24=Deploy / Hosting, 25=Playgrounds / Online IDE, 26=Finance / Accounting, 27=Forms & Surveys, 28=CRM / Sales, 29=Translation, 30=3D / CAD, 31=Maps / Navigation, 999=Other

Numbered categories stay sortable; `999` is a catch-all bucket so new categories can be inserted in the numbered sequence without renumbering.
