# JustFYI

A browser extension that tells you — before you upload your file — whether an online tool is actually free, freemium, paid, or abandoned. When a tool is paywalled or limited, JustFYI suggests free and open source alternatives.

Ratings are community-submitted and bundled with the extension as a local JSON file. No login required. No server contact while browsing.

Lives at [justfyi.app](https://justfyi.app). Source at [github.com/VladimirWrites/justfyi](https://github.com/VladimirWrites/justfyi).

## Project Structure

```
/extension       Chrome extension (Manifest V3, vanilla JS)
/worker          Cloudflare Worker + D1 (submitRating API)
/landing         Landing page
```

## Setup

### Prerequisites

- Node.js 20+
- Wrangler CLI (`npm install -g wrangler`)
- A Cloudflare account

### 1. Cloudflare Setup

```bash
wrangler login
wrangler d1 create justfyi
```

Copy the D1 `database_id` from the output and paste it into `worker/wrangler.toml`.

### 2. Initialize Database & Deploy

```bash
cd worker && npm install
npm run db:init
npm run deploy
```

## Load Extension

1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `/extension` folder

For Chrome Web Store publishing, zip the `/extension` folder and upload.

## How It Works

1. **On install**: Extension loads bundled `data/ratings.json` into `chrome.storage.local`, indexed by domain for O(1) lookup
2. **On tab change**: Normalizes the current domain, looks up in local cache, updates the toolbar icon
3. **Submissions**: Users rate unrated tools through the popup. Submissions POST to a Cloudflare Worker (no auth needed)
4. **Newsletter**: Users can sign up for a weekly digest of the best new free tools. Emails are stored in a `subscribers` D1 table with no IP or user-agent
5. **Moderation**: Review submissions at `/admin` (protected by Cloudflare Access). Approved rows are copied into `extension/data/ratings.json` by hand and shipped with the next extension release
6. **PII policy**: Neither `submissions` nor `subscribers` retains IP or User-Agent. IPs live only in a short-lived `rate_limits` table that self-purges each request (~1h lifetime)

## Rating Statuses

| Code | Label            |
|------|------------------|
| 0    | Out of scope     |
| 1    | Free             |
| 2    | Free with limits |
| 3    | Paid             |

Status is the money/friction axis. Login and abandoned are orthogonal flags (see schema).

## Categories

| Code | Label          | Code | Label                  |
|------|----------------|------|------------------------|
| 1    | PDF            | 10   | Notes / Docs           |
| 2    | Image          | 11   | SEO                    |
| 3    | Video          | 12   | Security               |
| 4    | Audio          | 13   | VPN                    |
| 5    | AI Generate    | 14   | Browser                |
| 6    | Writing        | 15   | Tasks / Project Mgmt   |
| 7    | Dev            | 16   | Cloud Storage          |
| 8    | Design         | 999  | Other                  |
| 9    | File Convert   |      |                        |

`999` is the catch-all so numbered categories can grow contiguously without renumbering.

## JSON Schema

Fields:
- `d` — normalized domain (lowercase, no `www.`, no subdomain, no path)
- `s` — status code (see Rating Statuses)
- `os` — open source (omit on out-of-scope entries)
- `cat` — category code (omit on out-of-scope entries)
- `n` — display name; optional, populate for any well-known tool
- `rec` — recommended alternative flag; `true` only for curated picks, requires `n`
- `lg` — `true` if the free tier requires signup/account
- `ab` — `true` if the project is sunset / no longer maintained

Typical entry:
```json
{ "d": "smallpdf.com", "s": 3, "os": false, "cat": 1, "n": "SmallPDF" }
```

Recommended alternative:
```json
{ "d": "pdf24.org", "s": 1, "os": true, "cat": 1, "n": "PDF24", "rec": true }
```

Out of scope (not a tool):
```json
{ "d": "amazon.com", "s": 0 }
```

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
