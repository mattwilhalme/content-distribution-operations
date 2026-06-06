import cors from "cors";
import express from "express";
import { XMLParser } from "fast-xml-parser";
import type {
  CheckPlatform,
  CheckSeverity,
  CheckStatus,
  FeedCheck,
  PlatformReadiness,
  SampleItem,
  ScanResponse
} from "@content-distribution-operations/shared";

const PORT = Number(process.env.PORT ?? 4000);
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

interface NormalizedItem {
  title: string;
  link: string;
  guid: string;
  publishedAt: string;
  body: string;
  description: string;
  hasContentEncoded: boolean;
  imageUrls: string[];
}

interface NormalizedFeed {
  feedType: ScanResponse["feedType"];
  title: string;
  items: NormalizedItem[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/scan", async (req, res) => {
  const url = String(req.body?.url ?? "").trim();

  if (!url) {
    res.status(400).json({ error: "Feed URL is required." });
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    res.status(400).json({ error: "Enter a valid feed URL." });
    return;
  }

  try {
    const response = await fetch(parsedUrl, {
      headers: {
        "User-Agent": "ContentDistributionOperations/0.1 feed readiness scanner"
      },
      signal: AbortSignal.timeout(15000)
    });

    const xml = await response.text();
    const scan = scanFeed(url, response.ok, parsedUrl.protocol === "https:", xml, response.status);
    res.status(response.ok ? 200 : 502).json(scan);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to fetch feed.";
    res.status(502).json({ error: message });
  }
});

function scanFeed(url: string, reachable: boolean, isHttps: boolean, xml: string, statusCode?: number): ScanResponse {
  const fetchedAt = new Date().toISOString();
  const checks: FeedCheck[] = [];

  addCheck(checks, "url-reachable", "URL reachable", reachable ? "pass" : "fail", "critical", "general", reachable ? "The feed URL returned a successful response." : `The feed URL returned HTTP ${statusCode ?? "error"}.`, "Confirm the feed URL is public and returns a 200-level response.");
  addCheck(checks, "https", "HTTPS feed URL", isHttps ? "pass" : "warn", "medium", "general", isHttps ? "The feed uses HTTPS." : "The feed URL is not HTTPS.", "Use HTTPS for feed URLs and media assets.");

  if (!reachable) {
    return buildResponse(url, fetchedAt, { feedType: "unknown", title: "", items: [] }, checks);
  }

  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
    addCheck(checks, "xml-parseable", "XML parseable", "pass", "critical", "general", "The feed XML parsed successfully.", "Keep feed markup valid and escape unsafe characters.");
  } catch {
    addCheck(checks, "xml-parseable", "XML parseable", "fail", "critical", "general", "The feed XML could not be parsed.", "Fix malformed XML before submitting to aggregators.");
    return buildResponse(url, fetchedAt, { feedType: "unknown", title: "", items: [] }, checks);
  }

  const feed = normalizeFeed(parsed);
  const itemCount = feed.items.length;
  const duplicateLinks = duplicates(feed.items.map((item) => item.link).filter(Boolean));
  const duplicateGuids = duplicates(feed.items.map((item) => item.guid).filter(Boolean));
  const missingTitles = feed.items.filter((item) => !item.title).length;
  const missingLinks = feed.items.filter((item) => !item.link).length;
  const missingGuids = feed.items.filter((item) => !item.guid).length;
  const missingDates = feed.items.filter((item) => !item.publishedAt).length;
  const invalidDates = feed.items.filter((item) => item.publishedAt && Number.isNaN(Date.parse(item.publishedAt))).length;
  const itemsWithImages = feed.items.filter((item) => item.imageUrls.length > 0).length;
  const nonHttpsImages = feed.items.flatMap((item) => item.imageUrls).filter((imageUrl) => imageUrl && !imageUrl.startsWith("https://")).length;
  const itemsWithContentEncoded = feed.items.filter((item) => item.hasContentEncoded).length;
  const itemsWithDescription = feed.items.filter((item) => item.description).length;
  const fullTextItems = feed.items.filter((item) => likelyFullText(item.body)).length;
  const shortBodies = feed.items.filter((item) => bodyLength(item.body) > 0 && bodyLength(item.body) < 300).length;
  const freshItems = feed.items.filter((item) => isFreshDate(item.publishedAt)).length;

  addCheck(checks, "feed-type", "RSS or Atom detected", feed.feedType !== "unknown" ? "pass" : "fail", "critical", "general", feed.feedType !== "unknown" ? `Detected ${feed.feedType.toUpperCase()} feed format.` : "Could not detect RSS or Atom format.", "Publish a valid RSS 2.0, Atom, or MRSS feed.");
  addCheck(checks, "feed-title", "Feed title", feed.title ? "pass" : "fail", "high", "general", feed.title ? `Feed title found: ${feed.title}` : "The feed is missing a channel/feed title.", "Add a clear publisher or section title to the feed.");
  addCheck(checks, "item-count", "At least 10 items", itemCount >= 10 ? "pass" : "warn", "medium", "general", `${itemCount} item${itemCount === 1 ? "" : "s"} found.`, "Keep at least 10 recent entries in the feed for evaluator confidence.");
  addCountCheck(checks, "item-title", "Each item has title", missingTitles, "critical", "general", "Add a title to every feed item.");
  addCountCheck(checks, "item-link", "Each item has link", missingLinks, "critical", "general", "Add canonical article links to every feed item.");
  addCountCheck(checks, "item-guid", "Each item has GUID or stable ID", missingGuids, "high", "general", "Add stable GUIDs or Atom IDs that do not change between fetches.");
  addCountCheck(checks, "item-date", "Each item has pubDate/updated", missingDates, "high", "general", "Add pubDate, published, or updated values for every item.");
  addCheck(checks, "duplicate-links", "Duplicate links", duplicateLinks.length === 0 ? "pass" : "fail", "high", "general", duplicateLinks.length === 0 ? "No duplicate links found." : `${duplicateLinks.length} duplicate link value${duplicateLinks.length === 1 ? "" : "s"} found.`, "Ensure each feed item points to a unique canonical article URL.");
  addCheck(checks, "duplicate-guids", "Duplicate GUIDs", duplicateGuids.length === 0 ? "pass" : "fail", "high", "general", duplicateGuids.length === 0 ? "No duplicate GUIDs found." : `${duplicateGuids.length} duplicate GUID value${duplicateGuids.length === 1 ? "" : "s"} found.`, "Generate stable and unique item identifiers.");
  addCheck(checks, "date-parse", "Dates parse correctly", invalidDates === 0 ? "pass" : "fail", "high", "general", invalidDates === 0 ? "All present dates parse successfully." : `${invalidDates} date value${invalidDates === 1 ? "" : "s"} could not be parsed.`, "Use RFC 822 dates for RSS or ISO 8601 dates for Atom.");

  addCheck(checks, "media-content", "Detect media:content", xml.includes("<media:content") ? "pass" : "warn", "medium", "media", xml.includes("<media:content") ? "media:content tags detected." : "No media:content tags detected.", "Add MRSS media:content for primary article images or videos.");
  addCheck(checks, "media-thumbnail", "Detect media:thumbnail", xml.includes("<media:thumbnail") ? "pass" : "warn", "low", "media", xml.includes("<media:thumbnail") ? "media:thumbnail tags detected." : "No media:thumbnail tags detected.", "Add media thumbnails when possible.");
  addCheck(checks, "enclosure-media", "Detect enclosure images/videos", xml.includes("<enclosure") ? "pass" : "warn", "low", "media", xml.includes("<enclosure") ? "Enclosure tags detected." : "No enclosure media detected.", "Use enclosures for media assets when the feed format supports them.");
  addCheck(checks, "missing-images", "Items include images", itemsWithImages === itemCount && itemCount > 0 ? "pass" : "warn", "high", "media", `${itemsWithImages} of ${itemCount} items include image or media URLs.`, "Include a primary image for every article item.");
  addCheck(checks, "https-images", "Image URLs use HTTPS", nonHttpsImages === 0 ? "pass" : "warn", "medium", "media", nonHttpsImages === 0 ? "No non-HTTPS image URLs found." : `${nonHttpsImages} image URL${nonHttpsImages === 1 ? "" : "s"} are not HTTPS.`, "Serve all images over HTTPS.");

  addCheck(checks, "content-encoded", "Detect content:encoded", itemsWithContentEncoded > 0 ? "pass" : "warn", "high", "content", `${itemsWithContentEncoded} of ${itemCount} items include content:encoded.`, "Provide full article HTML in content:encoded for platforms that prefer full text.");
  addCheck(checks, "description-summary", "Detect description/summary", itemsWithDescription > 0 ? "pass" : "warn", "medium", "content", `${itemsWithDescription} of ${itemCount} items include description or summary text.`, "Include a useful summary for each item.");
  addCheck(checks, "full-text-estimate", "Likely full text feed", fullTextItems >= Math.ceil(itemCount * 0.6) && itemCount > 0 ? "pass" : "warn", "high", "content", `${fullTextItems} of ${itemCount} items look like full-text entries.`, "Use full article bodies, not only excerpts, for aggregator readiness.");
  addCheck(checks, "short-bodies", "Very short item bodies", shortBodies === 0 ? "pass" : "warn", "medium", "content", shortBodies === 0 ? "No very short item bodies detected." : `${shortBodies} item bod${shortBodies === 1 ? "y is" : "ies are"} under 300 characters.`, "Expand short feed bodies or provide full text in content:encoded.");

  const completeCoreItems = feed.items.filter((item) => item.title && item.link && item.guid && item.publishedAt).length;
  addCheck(checks, "smartnews-core", "SmartNews core fields", completeCoreItems === itemCount && itemCount > 0 ? "pass" : "fail", "critical", "smartnews", `${completeCoreItems} of ${itemCount} items have title, link, date, and stable ID.`, "Fix missing core fields before SmartNews review.");
  addCheck(checks, "smartnews-content-media", "SmartNews content and media preference", fullTextItems > 0 && itemsWithImages > 0 ? "pass" : "warn", "high", "smartnews", "SmartNews strongly prefers full article content and images.", "Add content:encoded and primary media fields to each item.");

  addCheck(checks, "newsbreak-full-body", "NewsBreak full article body", fullTextItems >= Math.ceil(itemCount * 0.75) && itemCount > 0 ? "pass" : "fail", "critical", "newsbreak", `${fullTextItems} of ${itemCount} items look like full article bodies.`, "Provide full text rather than snippet-only feed items.");
  addCheck(checks, "newsbreak-media", "NewsBreak image/media presence", itemsWithImages >= Math.ceil(itemCount * 0.75) && itemCount > 0 ? "pass" : "fail", "critical", "newsbreak", `${itemsWithImages} of ${itemCount} items include media.`, "Include primary article images in media:content, media:thumbnail, enclosure, or content markup.");

  addCheck(checks, "google-fresh-dates", "Google News fresh dates", freshItems > 0 ? "pass" : "warn", "medium", "google_news", `${freshItems} item${freshItems === 1 ? "" : "s"} published in the last 7 days.`, "Keep recent articles in the feed and use accurate publication dates.");
  addCheck(checks, "google-canonical-links", "Google News canonical links", missingLinks === 0 && duplicateLinks.length === 0 ? "pass" : "fail", "high", "google_news", "Google News readiness depends on clean, unique canonical article links.", "Use permanent article URLs and avoid duplicate feed entries.");

  addCheck(checks, "apple-structured-data", "Apple News conversion readiness", completeCoreItems === itemCount && fullTextItems > 0 && itemsWithImages > 0 ? "pass" : "warn", "high", "apple_news", "Checks whether the feed has enough structured article data to convert later into Apple News Format.", "For later Apple News API/ANF publishing, preserve title, body, image, date, and canonical URL fields.");

  return buildResponse(url, fetchedAt, feed, checks);
}

function normalizeFeed(parsed: unknown): NormalizedFeed {
  const root = parsed as Record<string, unknown>;

  if (isRecord(root.rss)) {
    const channel = firstObject(root.rss.channel);
    const rawItems = arrayOf(channel?.item);
    return {
      feedType: "rss",
      title: textValue(channel?.title),
      items: rawItems.map(normalizeRssItem)
    };
  }

  if (isRecord(root.feed)) {
    const feed = root.feed;
    const rawItems = arrayOf(feed.entry);
    return {
      feedType: "atom",
      title: textValue(feed.title),
      items: rawItems.map(normalizeAtomItem)
    };
  }

  return { feedType: "unknown", title: "", items: [] };
}

function normalizeRssItem(raw: unknown): NormalizedItem {
  const item = isRecord(raw) ? raw : {};
  const body = textValue(item["content:encoded"]) || textValue(item.encoded) || textValue(item.description);

  return {
    title: textValue(item.title),
    link: textValue(item.link),
    guid: textValue(item.guid),
    publishedAt: textValue(item.pubDate) || textValue(item.published) || textValue(item.updated) || textValue(item["dc:date"]),
    body,
    description: textValue(item.description),
    hasContentEncoded: Boolean(textValue(item["content:encoded"]) || textValue(item.encoded)),
    imageUrls: extractImageUrls(item, body)
  };
}

function normalizeAtomItem(raw: unknown): NormalizedItem {
  const item = isRecord(raw) ? raw : {};
  const body = textValue(item.content) || textValue(item.summary);

  return {
    title: textValue(item.title),
    link: atomLink(item.link),
    guid: textValue(item.id),
    publishedAt: textValue(item.published) || textValue(item.updated),
    body,
    description: textValue(item.summary),
    hasContentEncoded: Boolean(textValue(item.content)),
    imageUrls: extractImageUrls(item, body)
  };
}

function extractImageUrls(item: Record<string, unknown>, body: string): string[] {
  const urls = new Set<string>();
  const mediaNodes = [
    ...arrayOf(item["media:content"]),
    ...arrayOf(item["media:thumbnail"]),
    ...arrayOf(item.enclosure),
    ...arrayOf(item.thumbnail)
  ];

  for (const node of mediaNodes) {
    if (!isRecord(node)) continue;
    const url = textValue(node["@_url"]) || textValue(node.url) || textValue(node.href);
    const type = textValue(node["@_type"]);
    if (url && (!type || type.startsWith("image/") || type.startsWith("video/"))) {
      urls.add(url);
    }
  }

  const imageMatches = body.matchAll(/<img[^>]+src=["']([^"']+)["']/gi);
  for (const match of imageMatches) {
    urls.add(match[1]);
  }

  return Array.from(urls);
}

function buildResponse(url: string, fetchedAt: string, feed: NormalizedFeed, checks: FeedCheck[]): ScanResponse {
  const overallScore = scoreChecks(checks);
  const failed = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  const critical = checks.filter((check) => check.status === "fail" && check.severity === "critical").length;

  return {
    url,
    fetchedAt,
    feedType: feed.feedType,
    overallScore,
    summary: {
      totalChecks: checks.length,
      passed: checks.filter((check) => check.status === "pass").length,
      warnings,
      failed,
      critical,
      itemCount: feed.items.length,
      feedTitle: feed.title
    },
    checks,
    platforms: {
      smartnews: platformReadiness(checks, "smartnews"),
      newsbreak: platformReadiness(checks, "newsbreak"),
      googleNews: platformReadiness(checks, "google_news"),
      appleNews: platformReadiness(checks, "apple_news")
    },
    sampleItems: feed.items.slice(0, 5).map(toSampleItem)
  };
}

function platformReadiness(checks: FeedCheck[], platform: CheckPlatform): PlatformReadiness {
  const sharedPlatforms: CheckPlatform[] = ["general", "media", "content"];
  const platformChecks = checks.filter((check) => check.platform === platform || sharedPlatforms.includes(check.platform));
  const score = scoreChecks(platformChecks);
  const issues = platformChecks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.label}: ${check.message}`);

  return {
    score,
    status: platformChecks.some((check) => check.status === "fail" && check.severity === "critical") ? "blocked" : score >= 80 ? "ready" : "needs_work",
    issues
  };
}

function scoreChecks(checks: FeedCheck[]): number {
  if (checks.length === 0) return 0;
  const severityWeight: Record<CheckSeverity, number> = { low: 3, medium: 6, high: 10, critical: 16 };
  const max = checks.reduce((total, check) => total + severityWeight[check.severity], 0);
  const lost = checks.reduce((total, check) => {
    if (check.status === "fail") return total + severityWeight[check.severity];
    if (check.status === "warn") return total + severityWeight[check.severity] * 0.45;
    return total;
  }, 0);
  return Math.max(0, Math.round(((max - lost) / max) * 100));
}

function toSampleItem(item: NormalizedItem, index: number): SampleItem {
  const issues = [
    !item.title ? "Missing title" : "",
    !item.link ? "Missing link" : "",
    !item.guid ? "Missing GUID/stable ID" : "",
    !item.publishedAt ? "Missing date" : "",
    item.imageUrls.length === 0 ? "Missing image" : "",
    bodyLength(item.body) > 0 && bodyLength(item.body) < 300 ? "Very short body" : ""
  ].filter(Boolean);

  return {
    index: index + 1,
    title: item.title,
    link: item.link,
    guid: item.guid,
    publishedAt: item.publishedAt,
    hasImage: item.imageUrls.length > 0,
    imageUrl: item.imageUrls[0] ?? "",
    hasContentEncoded: item.hasContentEncoded,
    bodyLength: bodyLength(item.body),
    likelyFullText: likelyFullText(item.body),
    issues
  };
}

function addCheck(checks: FeedCheck[], id: string, label: string, status: CheckStatus, severity: CheckSeverity, platform: CheckPlatform, message: string, recommendation: string) {
  checks.push({ id, label, status, severity, platform, message, recommendation });
}

function addCountCheck(checks: FeedCheck[], id: string, label: string, missingCount: number, severity: CheckSeverity, platform: CheckPlatform, recommendation: string) {
  addCheck(checks, id, label, missingCount === 0 ? "pass" : "fail", severity, platform, missingCount === 0 ? "All items pass this check." : `${missingCount} item${missingCount === 1 ? "" : "s"} failed this check.`, recommendation);
}

function arrayOf(value: unknown): unknown[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function firstObject(value: unknown): Record<string, unknown> {
  const first = arrayOf(value)[0];
  return isRecord(first) ? first : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (isRecord(value)) {
    return textValue(value["#cdata"]) || textValue(value["#text"]);
  }
  return "";
}

function atomLink(value: unknown): string {
  const links = arrayOf(value);
  const alternate = links.find((link) => isRecord(link) && (!link["@_rel"] || link["@_rel"] === "alternate"));
  const target = alternate ?? links[0];
  if (isRecord(target)) return textValue(target["@_href"]) || textValue(target.href);
  return textValue(target);
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicateValues = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicateValues.add(value);
    seen.add(value);
  }
  return Array.from(duplicateValues);
}

function bodyLength(body: string): number {
  return stripHtml(body).length;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function likelyFullText(body: string): boolean {
  return bodyLength(body) >= 1200;
}

function isFreshDate(value: string): boolean {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return false;
  return Date.now() - time <= 7 * 24 * 60 * 60 * 1000;
}

app.listen(PORT, () => {
  console.log(`Content Distribution Operations API running at http://localhost:${PORT}`);
});
