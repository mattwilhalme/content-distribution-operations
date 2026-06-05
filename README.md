# Content Distribution Operations

Local MVP for auditing publisher RSS, Atom, and MRSS feeds for readiness across general feed health, SmartNews, NewsBreak, Google News, and Apple News conversion readiness.

## Run Locally

```bash
npm install
npm run dev
```

The app runs at:

- Frontend: http://localhost:5173
- Backend API: http://localhost:4000

## API

`POST /api/scan`

```json
{
  "url": "https://example.com/feed.xml"
}
```

## What This MVP Checks

- Feed reachability, HTTPS, XML parsing, and RSS/Atom detection
- Feed title and minimum item count
- Required item fields: title, link, GUID/stable ID, and date
- Duplicate links and duplicate GUIDs
- Date parsing and freshness signals
- MRSS/media fields, enclosures, missing item images, and non-HTTPS images
- `content:encoded`, description/summary, short bodies, and likely full-text coverage
- Platform readiness sections for SmartNews, NewsBreak, Google News, and Apple News conversion readiness

This is local-only and intentionally does not include auth, billing, database storage, exports, or deployment.
