import "dotenv/config";

import cors from "cors";
import express from "express";
import { XMLParser } from "fast-xml-parser";

import { saveArticleChecks } from "./db/articleChecks.js";
import { saveCrawlAttempt } from "./db/crawlAttempts.js";
import { saveFeedCandidate } from "./db/feedCandidates.js";
import { listPublishers, updatePublisher, upsertPublisher } from "./db/publishers.js";
import { getScanRun, listScanRuns, saveScanRun } from "./db/scanRuns.js";

import type {
  ArticleAnalysis,
  BulkIntakeResult,
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
  author: string;
  categories: string[];
  body: string;
  description: string;
  hasContentEncoded: boolean;
  hasLeadImageInContent: boolean;
  imageUrls: string[];
  thumbnailUrls: string[];
  pageAnalysis?: ArticlePageAnalysis;
}

interface NormalizedFeed {
  feedType: ScanResponse["feedType"];
  title: string;
  link: string;
  description: string;
  publishedAt: string;
  language: string;
  logoUrl: string;
  ttl: string;
  items: NormalizedItem[];
}

interface ArticlePageAnalysis {
  reachable: boolean;
  statusCode?: number;
  hasArticleStructuredData: boolean;
  headline: string;
  description: string;
  siteName: string;
  imageUrls: string[];
  primaryImageUrl: string;
  datePublished: string;
  dateModified: string;
  author: string;
  publisher: string;
  canonicalUrl: string;
  hasLargeImageHint: boolean;
  hasMaxImagePreviewLarge: boolean;
}

interface PersistedScan {
  scan: ScanResponse;
  statusCode: number;
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

app.get("/api/publishers", async (_req, res) => {
  try {
    const publishers = await listPublishers();
    res.json({ publishers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load publishers.";
    res.status(500).json({ error: message });
  }
});

app.patch("/api/publishers/:id", async (req, res) => {
  try {
    await updatePublisher(req.params.id, {
      name: typeof req.body?.name === "string" ? req.body.name : undefined,
      status: typeof req.body?.status === "string" ? req.body.status : undefined,
      notes: typeof req.body?.notes === "string" ? req.body.notes : undefined
    });
    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update publisher.";
    res.status(500).json({ error: message });
  }
});

app.get("/api/scans", async (_req, res) => {
  try {
    const scans = await listScanRuns();
    res.json({ scans });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load scan history.";
    res.status(500).json({ error: message });
  }
});

app.get("/api/scans/:id", async (req, res) => {
  try {
    const scan = await getScanRun(req.params.id);

    if (!scan) {
      res.status(404).json({ error: "Scan not found." });
      return;
    }

    res.json(scan);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load scan.";
    res.status(500).json({ error: message });
  }
});

app.post("/api/scan", async (req, res) => {
  const url = String(req.body?.url ?? "").trim();

  if (!url) {
    res.status(400).json({ error: "Feed URL is required." });
    return;
  }

  if (!parseHttpUrl(url)) {
    res.status(400).json({ error: "Enter a valid feed URL." });
    return;
  }

  try {
    const { scan, statusCode } = await runAndPersistScan(url);
    res.status(statusCode).json(scan);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to fetch feed.";
    res.status(502).json({ error: message });
  }
});

app.post("/api/bulk-intake", async (req, res) => {
  const entries = normalizeBulkEntries(req.body?.entries);

  if (entries.length === 0) {
    res.status(400).json({ error: "Add at least one feed URL or publisher domain." });
    return;
  }

  const results: BulkIntakeResult[] = [];

  for (const entry of entries) {
    try {
      const feedUrl = await resolveFeedUrl(entry);
      const { scan, statusCode } = await runAndPersistScan(feedUrl);

      results.push({
        input: entry,
        status: statusCode === 200 ? "scanned" : "failed",
        feedUrl,
        scanRunId: scan.scanRunId ?? "",
        publisherId: scan.publisherId ?? "",
        feedTitle: scan.summary.feedTitle,
        overallScore: scan.overallScore,
        criticalCount: scan.summary.critical,
        error: statusCode === 200 ? "" : "Feed URL returned a non-success response."
      });
    } catch (error) {
      results.push({
        input: entry,
        status: "failed",
        feedUrl: "",
        scanRunId: "",
        publisherId: "",
        feedTitle: "",
        overallScore: 0,
        criticalCount: 0,
        error: error instanceof Error ? error.message : "Bulk intake failed."
      });
    }
  }

  res.json({
    results,
    summary: {
      total: results.length,
      scanned: results.filter((result) => result.status === "scanned").length,
      failed: results.filter((result) => result.status === "failed").length
    }
  });
});

app.post("/api/scans/:id/rescan", async (req, res) => {
  try {
    const savedScan = await getScanRun(req.params.id);

    if (!savedScan) {
      res.status(404).json({ error: "Scan not found." });
      return;
    }

    const { scan, statusCode } = await runAndPersistScan(savedScan.url);
    res.status(statusCode).json(scan);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to rescan feed.";
    res.status(502).json({ error: message });
  }
});

async function runAndPersistScan(url: string): Promise<PersistedScan> {
  const parsedUrl = new URL(url);
  const homepageUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}`;
  let publisherId: string | undefined;

  try {
    publisherId = await upsertPublisher(parsedUrl.hostname, homepageUrl);

    const response = await fetch(parsedUrl, {
      headers: {
        "User-Agent": "ContentDistributionOperations/0.1 feed readiness scanner"
      },
      signal: AbortSignal.timeout(15000)
    });

    const xml = await response.text();
    const scan = await scanFeed(url, response.ok, parsedUrl.protocol === "https:", xml, response.status);
    const feedCandidateId = await saveFeedCandidate({
      publisherId,
      domain: parsedUrl.hostname,
      feedUrl: response.url,
      scan
    });
    const scanRunId = await saveScanRun({
      scan,
      inputUrl: url,
      finalUrl: response.url,
      domain: parsedUrl.hostname,
      publisherId,
      feedCandidateId
    });

    await saveArticleChecks(scanRunId, publisherId, scan.sampleItems);
    await saveCrawlAttempt({
      publisherId,
      domain: parsedUrl.hostname,
      attemptedUrl: url,
      finalUrl: response.url,
      httpStatus: response.status,
      contentType: response.headers.get("content-type"),
      success: response.ok,
      raw: { feedType: scan.feedType, itemCount: scan.summary.itemCount }
    });

    return {
      scan: { ...scan, scanRunId, publisherId, feedCandidateId },
      statusCode: response.ok ? 200 : 502
    };
  } catch (error) {
    await saveCrawlAttempt({
      publisherId,
      domain: parsedUrl.hostname,
      attemptedUrl: url,
      success: false,
      error: error instanceof Error ? error.message : "Unknown crawl error"
    });
    throw error;
  }
}

async function scanFeed(url: string, reachable: boolean, isHttps: boolean, xml: string, statusCode?: number): Promise<ScanResponse> {
  const fetchedAt = new Date().toISOString();
  const checks: FeedCheck[] = [];

  addCheck(checks, "url-reachable", "URL reachable", reachable ? "pass" : "fail", "critical", "general", reachable ? "The feed URL returned a successful response." : `The feed URL returned HTTP ${statusCode ?? "error"}.`, "Confirm the feed URL is public and returns a 200-level response.");
  addCheck(checks, "https", "HTTPS feed URL", isHttps ? "pass" : "warn", "medium", "general", isHttps ? "The feed uses HTTPS." : "The feed URL is not HTTPS.", "Use HTTPS for feed URLs and media assets.");

  if (!reachable) {
    return buildResponse(url, fetchedAt, emptyFeed(), checks);
  }

  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
    addCheck(checks, "xml-parseable", "XML parseable", "pass", "critical", "general", "The feed XML parsed successfully.", "Keep feed markup valid and escape unsafe characters.");
  } catch {
    addCheck(checks, "xml-parseable", "XML parseable", "fail", "critical", "general", "The feed XML could not be parsed.", "Fix malformed XML before submitting to aggregators.");
    return buildResponse(url, fetchedAt, emptyFeed(), checks);
  }

  const feed = normalizeFeed(parsed);
  await attachArticlePageAnalysis(feed.items.slice(0, 5));
  const itemCount = feed.items.length;
  const duplicateLinks = duplicates(feed.items.map((item) => item.link).filter(Boolean));
  const duplicateGuids = duplicates(feed.items.map((item) => item.guid).filter(Boolean));
  const missingTitles = feed.items.filter((item) => !item.title).length;
  const missingLinks = feed.items.filter((item) => !item.link).length;
  const missingGuids = feed.items.filter((item) => !item.guid).length;
  const missingDates = feed.items.filter((item) => !item.publishedAt).length;
  const invalidDates = feed.items.filter((item) => item.publishedAt && Number.isNaN(Date.parse(item.publishedAt))).length;
  const itemsWithImages = feed.items.filter((item) => item.imageUrls.length > 0).length;
  const itemsWithThumbnails = feed.items.filter((item) => item.thumbnailUrls.length > 0).length;
  const missingThumbnails = itemCount - itemsWithThumbnails;
  const nonHttpsImages = feed.items.flatMap((item) => item.imageUrls).filter((imageUrl) => imageUrl && !imageUrl.startsWith("https://")).length;
  const itemsWithContentEncoded = feed.items.filter((item) => item.hasContentEncoded).length;
  const missingFullContent = itemCount - itemsWithContentEncoded;
  const itemsWithDescription = feed.items.filter((item) => item.description).length;
  const fullTextItems = feed.items.filter((item) => likelyFullText(item.body)).length;
  const shortOrPartialContent = itemCount - fullTextItems;
  const shortBodies = feed.items.filter((item) => bodyLength(item.body) > 0 && bodyLength(item.body) < 300).length;
  const freshItems = feed.items.filter((item) => isFreshDate(item.publishedAt)).length;
  const recentNewsItems = feed.items.filter((item) => isRecentNewsDate(item.publishedAt)).length;
  const futureDates = feed.items.filter((item) => isFutureDate(item.publishedAt)).length;
  const missingAuthors = feed.items.filter((item) => !item.author).length;
  const itemsWithLeadImages = feed.items.filter((item) => item.hasLeadImageInContent).length;
  const linksWithUtm = feed.items.filter((item) => hasUtmParameters(item.link)).length;
  const titlesWithFeedNoise = feed.items.filter((item) => titleIncludesSourceOrDate(item.title, feed.title)).length;
  const feedSizeBytes = Buffer.byteLength(xml, "utf8");
  const smartNewsThumbnailStatus: CheckStatus = missingThumbnails === 0 ? "pass" : missingThumbnails > 3 || missingThumbnails / Math.max(itemCount, 1) > 0.2 ? "fail" : "warn";
  const newsBreakRequiredItems = feed.items.filter((item) => item.title && item.link && item.publishedAt && item.author && item.description && item.hasContentEncoded).length;
  const newsBreakCleanLinks = feed.items.filter((item) => item.link && !hasUtmParameters(item.link)).length;
  const newsBreakImageFallbackItems = feed.items.filter((item) => item.thumbnailUrls.length > 0 || item.hasLeadImageInContent).length;
  const contentImagesWithoutCaptions = feed.items.filter((item) => hasImageTag(item.body) && !hasFigureCaption(item.body)).length;
  const iframeItems = feed.items.filter((item) => hasIframe(item.body)).length;
  const iframesMissingNewsBreakClass = feed.items.filter((item) => hasIframe(item.body) && !hasNewsBreakIframeClass(item.body)).length;
  const guidUrlItems = feed.items.filter((item) => !item.guid || isHttpUrl(item.guid)).length;
  const hasNewsBreakNamespace = xml.includes('xmlns:nb="https://www.newsbreak.com/"') || xml.includes("xmlns:nb='https://www.newsbreak.com/'");
  const hasDcNamespace = xml.includes('xmlns:dc="http://purl.org/dc/elements/1.1/"') || xml.includes("xmlns:dc='http://purl.org/dc/elements/1.1/'");
  const hasContentNamespace = xml.includes('xmlns:content="http://purl.org/rss/1.0/modules/content/"') || xml.includes("xmlns:content='http://purl.org/rss/1.0/modules/content/'");
  const sampledItems = feed.items.slice(0, 5);
  const analyzedPages = sampledItems.filter((item) => item.pageAnalysis);
  const reachablePages = analyzedPages.filter((item) => item.pageAnalysis?.reachable).length;
  const pagesWithArticleSchema = analyzedPages.filter((item) => item.pageAnalysis?.hasArticleStructuredData).length;
  const pagesWithHeadline = analyzedPages.filter((item) => item.pageAnalysis?.headline || item.title).length;
  const pagesWithImages = analyzedPages.filter((item) => (item.pageAnalysis?.imageUrls.length ?? 0) > 0 || item.imageUrls.length > 0).length;
  const pagesWithDates = analyzedPages.filter((item) => item.pageAnalysis?.datePublished || item.publishedAt).length;
  const pagesWithAuthors = analyzedPages.filter((item) => item.pageAnalysis?.author || item.author).length;
  const pagesWithModifiedDates = analyzedPages.filter((item) => item.pageAnalysis?.dateModified).length;
  const pagesWithCanonical = analyzedPages.filter((item) => item.pageAnalysis?.canonicalUrl).length;
  const pagesWithLargeImageHints = analyzedPages.filter((item) => item.pageAnalysis?.hasLargeImageHint).length;
  const pagesWithMaxImagePreviewLarge = analyzedPages.filter((item) => item.pageAnalysis?.hasMaxImagePreviewLarge).length;

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
  addCheck(checks, "smartnews-feed-description", "SmartNews feed description", feed.description ? "pass" : "fail", "critical", "smartnews", feed.description ? "Feed-level description/subtitle found." : "SmartFormat requires a feed description for RSS or subtitle for Atom.", "Add a short feed description/subtitle for SmartNews.");
  addCheck(checks, "smartnews-feed-link", "SmartNews feed link", feed.link ? "pass" : "fail", "critical", "smartnews", feed.link ? "Feed-level website link found." : "SmartFormat requires a feed-level website link.", "Add the publisher or section URL at the feed/channel level.");
  addCheck(checks, "smartnews-feed-date", "SmartNews feed publish date", feed.publishedAt && !Number.isNaN(Date.parse(feed.publishedAt)) ? "pass" : "fail", "critical", "smartnews", feed.publishedAt ? "Feed-level publication/update date found." : "SmartFormat requires a feed-level pubDate/updated value.", feed.feedType === "atom" ? "Add an Atom updated value in W3CDTF format." : "Add a channel pubDate in RFC 822 format.");
  addCheck(checks, "smartnews-feed-language", "SmartNews feed language", feed.language ? "pass" : "fail", "critical", "smartnews", feed.language ? `Feed language found: ${feed.language}` : "SmartFormat requires a feed/channel language value.", "Add language for RSS or xml:lang/dc:language for Atom.");
  addCheck(checks, "smartnews-logo", "SmartNews logo", feed.logoUrl ? "pass" : "fail", "critical", "smartnews", feed.logoUrl ? "SmartNews logo found." : "SmartFormat requires snf:logo at the feed/channel level.", "Add snf:logo with a 700 x 100 PNG logo URL.");
  addCheck(checks, "smartnews-core", "SmartNews core fields", completeCoreItems === itemCount && itemCount > 0 ? "pass" : "fail", "critical", "smartnews", `${completeCoreItems} of ${itemCount} items have title, link, date, and stable ID.`, "Fix missing core fields before SmartNews review.");
  addCheck(checks, "smartnews-author", "SmartNews item author", missingAuthors === 0 && itemCount > 0 ? "pass" : "fail", "critical", "smartnews", missingAuthors === 0 ? "All items include author metadata." : `${missingAuthors} item${missingAuthors === 1 ? "" : "s"} missing dc:creator/author.`, "Add dc:creator for RSS items or author for Atom entries.");
  addCheck(checks, "smartnews-full-content", "SmartNews full content", missingFullContent === 0 && itemCount > 0 ? "pass" : "fail", "critical", "smartnews", missingFullContent === 0 ? "All items include the required full-content field." : `${missingFullContent} item${missingFullContent === 1 ? "" : "s"} missing ${feed.feedType === "atom" ? "content" : "content:encoded"}.`, "Put the full article, not partial text or pagination, in content:encoded for RSS or content for Atom.");
  addCheck(checks, "smartnews-full-text-depth", "SmartNews full-text depth", shortOrPartialContent === 0 && itemCount > 0 ? "pass" : shortOrPartialContent > 3 ? "fail" : "warn", shortOrPartialContent > 3 ? "critical" : "high", "smartnews", shortOrPartialContent === 0 ? "All item bodies look full length." : `${shortOrPartialContent} item${shortOrPartialContent === 1 ? "" : "s"} look shorter than full article text.`, "Avoid excerpt-only or paginated content in SmartNews full-content fields.");
  addCheck(checks, "smartnews-thumbnails", "SmartNews media:thumbnail coverage", smartNewsThumbnailStatus, smartNewsThumbnailStatus === "fail" ? "critical" : "high", "smartnews", `${itemsWithThumbnails} of ${itemCount} items include media:thumbnail.`, "Add media:thumbnail to every SmartNews item; use large thumbnail images, ideally with a long dimension of at least 1,500 px.");
  addCheck(checks, "smartnews-lead-image", "SmartNews lead image in content", itemsWithLeadImages === itemCount && itemCount > 0 ? "pass" : "warn", "high", "smartnews", `${itemsWithLeadImages} of ${itemCount} items include an image inside the full-content field.`, "Include the lead image in content:encoded/content so SmartView can place in-article media correctly.");
  addCheck(checks, "smartnews-canonical-urls", "SmartNews clean canonical URLs", linksWithUtm === 0 ? "pass" : "warn", "medium", "smartnews", linksWithUtm === 0 ? "No UTM parameters found in item links." : `${linksWithUtm} item link${linksWithUtm === 1 ? "" : "s"} include UTM parameters.`, "Use redirected canonical article URLs and remove UTM tracking parameters from feed links.");
  addCheck(checks, "smartnews-feed-size", "SmartNews feed size", feedSizeBytes < 1_000_000 ? "pass" : "warn", "medium", "smartnews", `Feed XML is ${Math.round(feedSizeBytes / 1024)} KB.`, "Keep the feed file under 1 MB for SmartFormat.");
  addCheck(checks, "smartnews-item-limit", "SmartNews item count ceiling", itemCount <= 100 ? "pass" : "warn", "medium", "smartnews", `${itemCount} item${itemCount === 1 ? "" : "s"} found.`, "Keep SmartFormat feeds to roughly 100 items or fewer.");
  addCheck(checks, "smartnews-ttl", "SmartNews RSS ttl", feed.feedType !== "rss" || feed.ttl ? "pass" : "warn", "low", "smartnews", feed.feedType === "rss" ? feed.ttl ? `RSS ttl found: ${feed.ttl} minute${feed.ttl === "1" ? "" : "s"}.` : "No RSS ttl value found." : "Atom feeds do not use ttl.", "For RSS SmartFormat feeds, set ttl when you want to control fetch interval; 1 minute is the minimum.");

  addCheck(checks, "newsbreak-feed-format", "NewsBreak accepted feed format", feed.feedType !== "unknown" ? "pass" : "fail", "critical", "newsbreak", feed.feedType !== "unknown" ? `Detected ${feed.feedType.toUpperCase()}, which NewsBreak accepts.` : "Could not detect an accepted RSS 2.0 or Atom 1.0 feed.", "Publish a valid RSS 2.0 or Atom 1.0 feed.");
  addCheck(checks, "newsbreak-rss-namespaces", "NewsBreak RSS namespaces", feed.feedType !== "rss" || (hasNewsBreakNamespace && hasDcNamespace && hasContentNamespace) ? "pass" : "warn", "medium", "newsbreak", feed.feedType !== "rss" ? "Atom feed detected; RSS namespace check skipped." : `${[hasNewsBreakNamespace ? "" : "nb", hasDcNamespace ? "" : "dc", hasContentNamespace ? "" : "content"].filter(Boolean).join(", ") || "Required"} namespace signal${hasNewsBreakNamespace && hasDcNamespace && hasContentNamespace ? "s are present." : " missing."}`, "Declare xmlns:nb, xmlns:dc, and xmlns:content on RSS feeds intended for NewsBreak.");
  addCheck(checks, "newsbreak-required-fields", "NewsBreak required item fields", newsBreakRequiredItems === itemCount && itemCount > 0 ? "pass" : "fail", "critical", "newsbreak", `${newsBreakRequiredItems} of ${itemCount} items include title, link, publication date, author, description, and full content.`, "Every NewsBreak item should include title, canonical link, pubDate, dc:creator, description, and content:encoded.");
  addCheck(checks, "newsbreak-description", "NewsBreak item summaries", itemsWithDescription === itemCount && itemCount > 0 ? "pass" : "fail", "high", "newsbreak", `${itemsWithDescription} of ${itemCount} items include description/summary text.`, "Add a useful description summary to every article item.");
  addCheck(checks, "newsbreak-author", "NewsBreak item author", missingAuthors === 0 && itemCount > 0 ? "pass" : "fail", "critical", "newsbreak", missingAuthors === 0 ? "All items include author metadata." : `${missingAuthors} item${missingAuthors === 1 ? "" : "s"} missing dc:creator/author.`, "Add dc:creator for each RSS item or author for Atom entries.");
  addCheck(checks, "newsbreak-full-content", "NewsBreak content:encoded coverage", missingFullContent === 0 && itemCount > 0 ? "pass" : "fail", "critical", "newsbreak", missingFullContent === 0 ? "All items include full HTML content." : `${missingFullContent} item${missingFullContent === 1 ? "" : "s"} missing full HTML content.`, "Provide the full article HTML in content:encoded, including media, captions, and hyperlinks.");
  addCheck(checks, "newsbreak-full-body", "NewsBreak full article body", fullTextItems >= Math.ceil(itemCount * 0.75) && itemCount > 0 ? "pass" : "fail", "critical", "newsbreak", `${fullTextItems} of ${itemCount} items look like full article bodies.`, "Provide full text rather than snippet-only feed items.");
  addCheck(checks, "newsbreak-clean-links", "NewsBreak canonical article links", newsBreakCleanLinks === itemCount && duplicateLinks.length === 0 && itemCount > 0 ? "pass" : "warn", "high", "newsbreak", `${newsBreakCleanLinks} of ${itemCount} item links are free of tracking parameters; ${duplicateLinks.length} duplicate link${duplicateLinks.length === 1 ? "" : "s"} found.`, "Use canonical article URLs and avoid NewsBreak-specific or tracking parameters.");
  addCheck(checks, "newsbreak-guid-url", "NewsBreak GUID URL format", guidUrlItems === itemCount ? "pass" : "warn", "low", "newsbreak", `${guidUrlItems} of ${itemCount} items have a blank GUID or URL-formatted GUID.`, "If NewsBreak agrees to use GUID as article URL, keep GUID values as URL permalinks and use consistent generation logic across feeds.");
  addCheck(checks, "newsbreak-media", "NewsBreak image/media presence", itemsWithImages >= Math.ceil(itemCount * 0.75) && itemCount > 0 ? "pass" : "fail", "critical", "newsbreak", `${itemsWithImages} of ${itemCount} items include media.`, "Include primary article images in media:content, media:thumbnail, enclosure, or content markup.");
  addCheck(checks, "newsbreak-thumbnail-fallback", "NewsBreak thumbnail or content image", newsBreakImageFallbackItems === itemCount && itemCount > 0 ? "pass" : "warn", "medium", "newsbreak", `${newsBreakImageFallbackItems} of ${itemCount} items include media:thumbnail or a lead image in content.`, "Use media:thumbnail when available; otherwise ensure the first image in content:encoded is the intended thumbnail.");
  addCheck(checks, "newsbreak-image-captions", "NewsBreak image captions", contentImagesWithoutCaptions === 0 ? "pass" : "warn", "medium", "newsbreak", contentImagesWithoutCaptions === 0 ? "No content images missing figure/figcaption structure were detected." : `${contentImagesWithoutCaptions} item${contentImagesWithoutCaptions === 1 ? "" : "s"} include content images without figure/figcaption structure.`, "Wrap content images in figure tags and include figcaption text when captions are available.");
  addCheck(checks, "newsbreak-iframe-classes", "NewsBreak video/audio iframe classes", iframesMissingNewsBreakClass === 0 ? "pass" : "warn", "medium", "newsbreak", iframeItems === 0 ? "No content iframes detected." : `${iframesMissingNewsBreakClass} of ${iframeItems} item${iframeItems === 1 ? "" : "s"} with iframes are missing nb-video or nb-audio class markers.`, "For embedded video/audio iframes inside content:encoded, add class=\"nb-video\" or class=\"nb-audio\".");

  addCheck(checks, "google-fresh-dates", "Google News fresh dates", freshItems > 0 ? "pass" : "warn", "medium", "google_news", `${freshItems} item${freshItems === 1 ? "" : "s"} published in the last 7 days.`, "Keep recent articles in the feed and use accurate publication dates.");
  addCheck(checks, "google-canonical-links", "Google News canonical links", missingLinks === 0 && duplicateLinks.length === 0 ? "pass" : "fail", "high", "google_news", "Google News readiness depends on clean, unique canonical article links.", "Use permanent article URLs and avoid duplicate feed entries.");
  addCheck(checks, "google-news-transition", "Google News crawl-based eligibility", "pass", "medium", "google_news", "Google News now relies on automated web crawling for publication pages rather than Publisher Center-submitted RSS sections.", "Use the feed as a discovery aid, but make article pages crawlable, indexable, and well structured.");
  addCheck(checks, "google-sample-pages-reachable", "Google News sample article pages reachable", analyzedPages.length > 0 && reachablePages === analyzedPages.length ? "pass" : "fail", "critical", "google_news", `${reachablePages} of ${sampledItems.length} sampled article pages were reachable for metadata inspection.`, "Make every article URL a public, crawlable HTML page with a stable 200-level response.");
  addCheck(checks, "google-article-schema", "Google Article structured data", pagesWithArticleSchema === analyzedPages.length && analyzedPages.length > 0 ? "pass" : "warn", "high", "google_news", `${pagesWithArticleSchema} of ${analyzedPages.length} sampled article pages expose Article, NewsArticle, or BlogPosting structured data.`, "Add JSON-LD Article or NewsArticle structured data to article pages so Google can identify headline, image, author, and dates.");
  addCheck(checks, "google-headline", "Google headline/title", pagesWithHeadline === sampledItems.length && titlesWithFeedNoise === 0 ? "pass" : "warn", "high", "google_news", titlesWithFeedNoise === 0 ? `${pagesWithHeadline} of ${sampledItems.length} sampled items have article titles/headlines.` : `${titlesWithFeedNoise} feed title${titlesWithFeedNoise === 1 ? "" : "s"} appear to include source/date noise.`, "Use concise article headlines; do not append author, publication name, or publication date to the article title.");
  addCheck(checks, "google-article-images", "Google article images", pagesWithImages === sampledItems.length && sampledItems.length > 0 ? "pass" : "warn", "high", "google_news", `${pagesWithImages} of ${sampledItems.length} sampled items expose an article image via structured data, page metadata, or feed media.`, "Provide relevant representative images through Article image, og:image, media tags, or image markup.");
  addCheck(checks, "google-large-image-hints", "Google large image hints", pagesWithLargeImageHints > 0 ? "pass" : "warn", "medium", "google_news", `${pagesWithLargeImageHints} of ${analyzedPages.length} sampled article pages include multiple/high-quality image hints.`, "For best results, provide multiple high-resolution article images, ideally 16x9, 4x3, and 1x1 variants.");
  addCheck(checks, "google-max-image-preview", "Google max-image-preview", pagesWithMaxImagePreviewLarge > 0 ? "pass" : "warn", "medium", "google_news", `${pagesWithMaxImagePreviewLarge} of ${analyzedPages.length} sampled article pages allow large image previews.`, "Use max-image-preview:large unless the site intentionally limits image previews.");
  addCheck(checks, "google-article-dates", "Google article dates", pagesWithDates === sampledItems.length && futureDates === 0 ? "pass" : "fail", "critical", "google_news", futureDates === 0 ? `${pagesWithDates} of ${sampledItems.length} sampled items expose publication dates.` : `${futureDates} item date${futureDates === 1 ? " is" : "s are"} in the future.`, "Expose accurate publication dates and never use future dates for article publication time.");
  addCheck(checks, "google-date-format", "Google date format precision", invalidDates === 0 ? "pass" : "fail", "high", "google_news", invalidDates === 0 ? "All feed dates are parseable." : `${invalidDates} feed date value${invalidDates === 1 ? "" : "s"} could not be parsed.`, "Use parseable publication dates; page structured data should use ISO 8601 with timezone when possible.");
  addCheck(checks, "google-recent-news-window", "Google News recent article window", recentNewsItems > 0 ? "pass" : "warn", "medium", "google_news", `${recentNewsItems} item${recentNewsItems === 1 ? "" : "s"} published in the last 2 days.`, "For News sitemap-style discovery, keep the most recent two days of news URLs current.");
  addCheck(checks, "google-author", "Google author metadata", pagesWithAuthors === sampledItems.length && sampledItems.length > 0 ? "pass" : "warn", "medium", "google_news", `${pagesWithAuthors} of ${sampledItems.length} sampled items expose author information.`, "Add author data in Article structured data or feed metadata for clearer article attribution.");
  addCheck(checks, "google-date-modified", "Google modified date metadata", pagesWithModifiedDates > 0 ? "pass" : "warn", "low", "google_news", `${pagesWithModifiedDates} of ${analyzedPages.length} sampled article pages expose dateModified.`, "Add dateModified when applicable to help Google understand meaningful article updates.");
  addCheck(checks, "google-canonical-page", "Google page canonical URL", pagesWithCanonical > 0 ? "pass" : "warn", "medium", "google_news", `${pagesWithCanonical} of ${analyzedPages.length} sampled article pages expose a canonical URL.`, "Use rel=canonical on article pages and keep feed links aligned to the canonical article URL.");
  addCheck(checks, "google-language", "Google language signal", feed.language ? "pass" : "warn", "medium", "google_news", feed.language ? `Feed language found: ${feed.language}.` : "No feed-level language found.", "Use a clear language signal for news content and avoid mixing multiple languages in a single article.");
  addCheck(checks, "google-publication-name", "Google publication name", feed.title ? "pass" : "warn", "medium", "google_news", feed.title ? `Publication/feed name found: ${feed.title}.` : "No publication/feed name found.", "Keep the publication name consistent with the site name used on article pages and Google News surfaces.");

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
      link: textValue(channel?.link),
      description: textValue(channel?.description),
      publishedAt: textValue(channel?.pubDate) || textValue(channel?.lastBuildDate),
      language: textValue(channel?.language) || textValue(channel?.["dc:language"]),
      logoUrl: snfLogoUrl(channel?.["snf:logo"]),
      ttl: textValue(channel?.ttl),
      items: rawItems.map(normalizeRssItem)
    };
  }

  if (isRecord(root.feed)) {
    const feed = root.feed;
    const rawItems = arrayOf(feed.entry);
    return {
      feedType: "atom",
      title: textValue(feed.title),
      link: atomLink(feed.link),
      description: textValue(feed.subtitle),
      publishedAt: textValue(feed.updated) || textValue(feed.pubDate),
      language: textValue(feed["@_xml:lang"]) || textValue(feed["dc:language"]),
      logoUrl: snfLogoUrl(feed["snf:logo"]) || textValue(feed.logo),
      ttl: "",
      items: rawItems.map(normalizeAtomItem)
    };
  }

  return emptyFeed();
}

function normalizeRssItem(raw: unknown): NormalizedItem {
  const item = isRecord(raw) ? raw : {};
  const contentEncoded = textValue(item["content:encoded"]) || textValue(item.encoded);
  const body = contentEncoded || textValue(item.description);
  const thumbnailUrls = extractThumbnailUrls(item);

  return {
    title: textValue(item.title),
    link: textValue(item.link),
    guid: textValue(item.guid),
    publishedAt: textValue(item.pubDate) || textValue(item.published) || textValue(item.updated) || textValue(item["dc:date"]),
    author: textValue(item["dc:creator"]) || textValue(item.author),
    categories: categoryValues(item.category),
    body,
    description: textValue(item.description),
    hasContentEncoded: Boolean(contentEncoded),
    hasLeadImageInContent: hasImageTag(contentEncoded),
    imageUrls: extractImageUrls(item, body),
    thumbnailUrls
  };
}

function normalizeAtomItem(raw: unknown): NormalizedItem {
  const item = isRecord(raw) ? raw : {};
  const content = textValue(item.content);
  const body = content || textValue(item.summary);
  const thumbnailUrls = extractThumbnailUrls(item);

  return {
    title: textValue(item.title),
    link: atomLink(item.link),
    guid: textValue(item.id),
    publishedAt: textValue(item.published) || textValue(item.updated),
    author: authorValue(item.author) || textValue(item["dc:creator"]),
    categories: categoryValues(item.category),
    body,
    description: textValue(item.summary),
    hasContentEncoded: Boolean(content),
    hasLeadImageInContent: hasImageTag(content),
    imageUrls: extractImageUrls(item, body),
    thumbnailUrls
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

function extractThumbnailUrls(item: Record<string, unknown>): string[] {
  return arrayOf(item["media:thumbnail"])
    .map((node) => {
      if (isRecord(node)) return textValue(node["@_url"]) || textValue(node.url) || textValue(node.href);
      return textValue(node);
    })
    .filter(Boolean);
}

async function attachArticlePageAnalysis(items: NormalizedItem[]) {
  await Promise.all(items.map(async (item) => {
    item.pageAnalysis = await inspectArticlePage(item.link);
  }));
}

async function inspectArticlePage(url: string): Promise<ArticlePageAnalysis | undefined> {
  if (!isHttpUrl(url)) return undefined;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "ContentDistributionOperations/0.1 Google News metadata scanner"
      },
      signal: AbortSignal.timeout(8000)
    });
    const html = await response.text();
    const metadata = extractArticlePageMetadata(html);

    return {
      ...metadata,
      reachable: response.ok,
      statusCode: response.status
    };
  } catch {
    return {
      reachable: false,
      hasArticleStructuredData: false,
      headline: "",
      description: "",
      siteName: "",
      imageUrls: [],
      primaryImageUrl: "",
      datePublished: "",
      dateModified: "",
      author: "",
      publisher: "",
      canonicalUrl: "",
      hasLargeImageHint: false,
      hasMaxImagePreviewLarge: false
    };
  }
}

function extractArticlePageMetadata(html: string): Omit<ArticlePageAnalysis, "reachable" | "statusCode"> {
  const jsonLdNodes = extractJsonLdNodes(html);
  const articleNode = jsonLdNodes.find(isArticleSchemaNode);
  const imageUrls = uniqueStrings([
    ...extractSchemaImageUrls(articleNode),
    metaContent(html, "property", "og:image"),
    metaContent(html, "name", "twitter:image")
  ]);

  return {
    hasArticleStructuredData: Boolean(articleNode),
    headline: textValue(readSchemaField(articleNode, "headline")) || metaContent(html, "property", "og:title") || htmlTitle(html),
    description: textValue(readSchemaField(articleNode, "description")) || metaContent(html, "property", "og:description") || metaContent(html, "name", "twitter:description") || metaContent(html, "name", "description"),
    siteName: metaContent(html, "property", "og:site_name") || schemaPublisher(articleNode),
    imageUrls,
    primaryImageUrl: imageUrls[0] ?? "",
    datePublished: textValue(readSchemaField(articleNode, "datePublished")) || metaContent(html, "property", "article:published_time"),
    dateModified: textValue(readSchemaField(articleNode, "dateModified")) || metaContent(html, "property", "article:modified_time"),
    author: schemaAuthor(articleNode) || metaContent(html, "name", "author"),
    publisher: schemaPublisher(articleNode),
    canonicalUrl: canonicalUrl(html),
    hasLargeImageHint: imageUrls.length >= 2 || hasImageDimensionHint(html, 1200),
    hasMaxImagePreviewLarge: /max-image-preview\s*:\s*large/i.test(html)
  };
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
    .map((check) => `🔴 ${check.message}`);

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
    !item.author ? "Missing SmartNews author" : "",
    !item.hasContentEncoded ? "Missing SmartNews full content" : "",
    item.thumbnailUrls.length === 0 ? "Missing SmartNews thumbnail" : "",
    item.imageUrls.length === 0 ? "Missing image" : "",
    bodyLength(item.body) > 0 && bodyLength(item.body) < 300 ? "Very short body" : ""
  ].filter(Boolean);

  return {
    index: index + 1,
    title: item.title,
    link: item.link,
    guid: item.guid,
    publishedAt: item.publishedAt,
    author: item.author,
    categories: item.categories,
    description: stripHtml(item.description),
    bodyText: stripHtml(item.body),
    hasImage: item.imageUrls.length > 0,
    imageUrl: item.imageUrls[0] ?? "",
    hasThumbnail: item.thumbnailUrls.length > 0,
    thumbnailUrl: item.thumbnailUrls[0] ?? "",
    hasContentEncoded: item.hasContentEncoded,
    bodyLength: bodyLength(item.body),
    likelyFullText: likelyFullText(item.body),
    issues,
    articleAnalysis: item.pageAnalysis ? toArticleAnalysis(item.pageAnalysis) : undefined
  };
}

function toArticleAnalysis(analysis: ArticlePageAnalysis): ArticleAnalysis {
  return {
    reachable: analysis.reachable,
    statusCode: analysis.statusCode,
    hasArticleStructuredData: analysis.hasArticleStructuredData,
    headline: analysis.headline,
    description: analysis.description,
    siteName: analysis.siteName,
    imageUrls: analysis.imageUrls,
    primaryImageUrl: analysis.primaryImageUrl,
    datePublished: analysis.datePublished,
    dateModified: analysis.dateModified,
    author: analysis.author,
    publisher: analysis.publisher,
    canonicalUrl: analysis.canonicalUrl,
    hasLargeImageHint: analysis.hasLargeImageHint,
    hasMaxImagePreviewLarge: analysis.hasMaxImagePreviewLarge
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

function emptyFeed(): NormalizedFeed {
  return {
    feedType: "unknown",
    title: "",
    link: "",
    description: "",
    publishedAt: "",
    language: "",
    logoUrl: "",
    ttl: "",
    items: []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return textValue(value[0]);
  if (isRecord(value)) {
    return textValue(value["#cdata"]) || textValue(value["#text"]);
  }
  return "";
}

function authorValue(value: unknown): string {
  const author = firstObject(value);
  return textValue(author.name) || textValue(author);
}

function categoryValues(value: unknown): string[] {
  return arrayOf(value)
    .map((category) => {
      if (isRecord(category)) return textValue(category["@_term"]) || textValue(category);
      return textValue(category);
    })
    .filter(Boolean);
}

function snfLogoUrl(value: unknown): string {
  const logo = firstObject(value);
  return textValue(logo.url) || textValue(logo["@_url"]) || textValue(logo);
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

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
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

function hasImageTag(body: string): boolean {
  return /<img\b[^>]*\bsrc=["'][^"']+["']/i.test(body);
}

function hasFigureCaption(body: string): boolean {
  return /<figure\b[\s\S]*?<img\b[\s\S]*?<figcaption\b[\s\S]*?<\/figcaption>[\s\S]*?<\/figure>/i.test(body);
}

function hasIframe(body: string): boolean {
  return /<iframe\b/i.test(body);
}

function hasNewsBreakIframeClass(body: string): boolean {
  return /<iframe\b(?=[^>]*\bclass=["'][^"']*\bnb-(?:video|audio)\b[^"']*["'])[^>]*>/i.test(body);
}

function hasUtmParameters(value: string): boolean {
  try {
    const url = new URL(value);
    return Array.from(url.searchParams.keys()).some((key) => key.toLowerCase().startsWith("utm_"));
  } catch {
    return false;
  }
}

function normalizeBulkEntries(value: unknown): string[] {
  const rawEntries = Array.isArray(value) ? value : [];
  return uniqueStrings(
    rawEntries
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean)
  ).slice(0, 25);
}

async function resolveFeedUrl(input: string): Promise<string> {
  const url = parseHttpUrl(input) ?? parseHttpUrl(`https://${input}`);

  if (!url) {
    throw new Error("Enter a valid feed URL or domain.");
  }

  const isLikelyHomepage = url.pathname === "/" && !url.search;
  if (!isLikelyHomepage) return url.toString();

  return discoverFeedUrl(url);
}

async function discoverFeedUrl(homepageUrl: URL): Promise<string> {
  let baseUrl = homepageUrl.toString();

  try {
    const homepage = await fetchText(homepageUrl.toString(), 10000);
    baseUrl = homepage.responseUrl;
    const alternateFeed = firstAlternateFeedUrl(homepage.body, homepage.responseUrl);

    if (alternateFeed && await looksLikeFeedUrl(alternateFeed)) {
      return alternateFeed;
    }
  } catch {
    // Fall back to common feed paths when the homepage itself is blocked or unavailable.
  }

  const candidates = [
    "/feed",
    "/rss",
    "/rss.xml",
    "/feed.xml",
    "/atom.xml"
  ].map((path) => new URL(path, baseUrl).toString());

  for (const candidate of candidates) {
    if (await looksLikeFeedUrl(candidate)) return candidate;
  }

  throw new Error("No RSS or Atom feed discovered for this domain.");
}

async function looksLikeFeedUrl(url: string): Promise<boolean> {
  try {
    const { body } = await fetchText(url, 8000);
    return normalizeFeed(parser.parse(body)).feedType !== "unknown";
  } catch {
    return false;
  }
}

async function fetchText(url: string, timeoutMs: number): Promise<{ body: string; responseUrl: string }> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ContentDistributionOperations/0.1 feed discovery"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Discovery returned HTTP ${response.status}.`);
  }

  return {
    body: await response.text(),
    responseUrl: response.url
  };
}

function firstAlternateFeedUrl(html: string, baseUrl: string): string {
  const linkMatches = html.matchAll(/<link\b[^>]*>/gi);

  for (const match of linkMatches) {
    const tag = match[0];
    const rel = attributeValue(tag, "rel").toLowerCase();
    const type = attributeValue(tag, "type").toLowerCase();
    const href = attributeValue(tag, "href");

    if (!href || !rel.includes("alternate")) continue;
    if (!["application/rss+xml", "application/atom+xml", "application/feed+json", "text/xml", "application/xml"].includes(type)) continue;

    try {
      return new URL(decodeHtmlEntities(href), baseUrl).toString();
    } catch {
      return "";
    }
  }

  return "";
}

function attributeValue(tag: string, name: string): string {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}=["']([^"']+)["']`, "i");
  return decodeHtmlEntities(tag.match(pattern)?.[1]?.trim() ?? "");
}

function isHttpUrl(value: string): boolean {
  return Boolean(parseHttpUrl(value));
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url;
    return undefined;
  } catch {
    return undefined;
  }
}

function isFutureDate(value: string): boolean {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return false;
  return time > Date.now() + 5 * 60 * 1000;
}

function isFreshDate(value: string): boolean {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return false;
  return Date.now() - time <= 7 * 24 * 60 * 60 * 1000;
}

function isRecentNewsDate(value: string): boolean {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return false;
  return Date.now() - time <= 2 * 24 * 60 * 60 * 1000;
}

function titleIncludesSourceOrDate(title: string, feedTitle: string): boolean {
  if (!title) return false;
  const lowerTitle = title.toLowerCase();
  const lowerFeedTitle = feedTitle.toLowerCase();
  const containsFeedTitle = Boolean(lowerFeedTitle && lowerTitle.includes(lowerFeedTitle));
  const containsDate = /\b(?:19|20)\d{2}\b|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\.? \d{1,2}/i.test(title);
  return containsFeedTitle || containsDate;
}

function extractJsonLdNodes(html: string): unknown[] {
  const scripts = html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  return Array.from(scripts).flatMap((match) => {
    const content = decodeHtmlEntities(stripHtmlComments(match[1]).trim());
    try {
      const parsed = JSON.parse(content);
      return flattenJsonLd(parsed);
    } catch {
      return [];
    }
  });
}

function flattenJsonLd(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (!isRecord(value)) return [];
  const graph = value["@graph"];
  return [value, ...flattenJsonLd(graph)];
}

function isArticleSchemaNode(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return arrayOf(value["@type"]).some((type) => ["Article", "NewsArticle", "BlogPosting"].includes(textValue(type)));
}

function readSchemaField(node: unknown, field: string): unknown {
  return isRecord(node) ? node[field] : undefined;
}

function extractSchemaImageUrls(node: unknown): string[] {
  return arrayOf(readSchemaField(node, "image")).flatMap((image) => {
    if (typeof image === "string") return [image];
    if (isRecord(image)) return [textValue(image.url), textValue(image.contentUrl)];
    return [];
  }).filter(Boolean);
}

function schemaAuthor(node: unknown): string {
  return arrayOf(readSchemaField(node, "author"))
    .map((author) => isRecord(author) ? textValue(author.name) : textValue(author))
    .filter(Boolean)
    .join(", ");
}

function schemaPublisher(node: unknown): string {
  const publisher = readSchemaField(node, "publisher");
  if (isRecord(publisher)) return textValue(publisher.name);
  return textValue(publisher);
}

function metaContent(html: string, attrName: "name" | "property", attrValue: string): string {
  const escaped = escapeRegExp(attrValue);
  const patterns = [
    new RegExp(`<meta\\b(?=[^>]*\\b${attrName}=["']${escaped}["'])(?=[^>]*\\bcontent=["']([^"']+)["'])[^>]*>`, "i"),
    new RegExp(`<meta\\b(?=[^>]*\\bcontent=["']([^"']+)["'])(?=[^>]*\\b${attrName}=["']${escaped}["'])[^>]*>`, "i")
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1].trim());
  }

  return "";
}

function htmlTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? decodeHtmlEntities(stripHtml(match[1])) : "";
}

function canonicalUrl(html: string): string {
  const match = html.match(/<link\b(?=[^>]*\brel=["'][^"']*\bcanonical\b[^"']*["'])(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>/i);
  return match?.[1] ? decodeHtmlEntities(match[1].trim()) : "";
}

function hasImageDimensionHint(html: string, minWidth: number): boolean {
  const imageMatches = html.matchAll(/<(?:meta|img)\b[^>]*(?:width=["']?(\d+)["']?|content=["'][^"']*(?:[?&](?:w|width)=(\d+)|[-_](\d{3,5})x\d{3,5})[^"']*["'])[^>]*>/gi);
  for (const match of imageMatches) {
    const width = Number(match[1] || match[2] || match[3] || 0);
    if (width >= minWidth) return true;
  }
  return false;
}

function stripHtmlComments(value: string): string {
  return value.replace(/<!--[\s\S]*?-->/g, "");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

app.listen(PORT, () => {
  console.log(`Content Distribution Operations API running at http://localhost:${PORT}`);
});
