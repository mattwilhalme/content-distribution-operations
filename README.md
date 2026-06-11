# Content Distribution Operations

Internal operations console for auditing publisher RSS, Atom, and MRSS feeds before external publisher-facing workflows. The app tracks publisher readiness across general feed health, SmartNews, NewsBreak, Google News, and Apple News conversion readiness.

This is currently an internal tool. It is intended to help operators intake publisher prospects, discover or scan feeds, review blockers, manage publisher status, and preserve scan history while the future external product is designed separately.

## Run Locally

```bash
npm install
npm run dev
```

The app runs at:

- Frontend: http://localhost:5173
- Backend API: http://localhost:4000

The backend expects Supabase credentials in the server environment:

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

## API

`POST /api/scan`

```json
{
  "url": "https://example.com/feed.xml"
}
```

`POST /api/bulk-intake`

```json
{
  "entries": [
    "https://example.com/feed.xml",
    "example.org"
  ]
}
```

Bulk intake accepts feed URLs or publisher domains. Domains are resolved by checking homepage RSS/Atom alternate links first, then common feed paths such as `/feed`, `/rss`, `/rss.xml`, `/feed.xml`, and `/atom.xml`.

## What This MVP Checks

- Feed reachability, HTTPS, XML parsing, and RSS/Atom detection
- Feed title and minimum item count
- Required item fields: title, link, GUID/stable ID, and date
- Duplicate links and duplicate GUIDs
- Date parsing and freshness signals
- MRSS/media fields, enclosures, missing item images, and non-HTTPS images
- `content:encoded`, description/summary, short bodies, and likely full-text coverage
- Platform readiness sections for SmartNews, NewsBreak, Google News, and Apple News conversion readiness

## Current Internal Workflows

- Single-feed scan from a known RSS, Atom, or MRSS URL
- Bulk intake for lists of feed URLs or publisher domains
- Homepage feed discovery for domain-only intake
- Supabase-backed publisher records, feed candidates, scan runs, scan checks, article checks, and crawl attempts
- Publisher dashboard with readiness status, notes, scan counts, latest scores, and rescans
- Saved scan history with per-platform scoring and sample article previews

## Not In Scope Yet

- Public publisher-facing accounts or authentication
- Billing
- External self-serve onboarding
- Background scheduled rescans
- Publisher-facing PDF/CSV exports
- Deployment hardening
