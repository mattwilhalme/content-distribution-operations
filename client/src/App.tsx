import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  CheckPlatform,
  FeedCheck,
  PublisherSummary,
  ScanResponse,
  ScanRunSummary
} from "@content-distribution-operations/shared";

const starterFeed = "https://www.npr.org/rss/rss.php?id=1001";
const publisherStatuses = ["prospect", "reviewing", "ready", "blocked", "approved"];
type ResultChannel = "overall" | "smartnews" | "newsbreak" | "google_news" | "apple_news";
type ViewMode = "dashboard" | "scanner";
type ArticlePreviewMode = "google_news" | "smartnews" | "newsbreak" | "diagnostic";

const sharedPlatforms: CheckPlatform[] = ["general", "media", "content"];

const channelNotes: Record<ResultChannel, string> = {
  overall: "All scan checks across feed health, content, media, and distribution readiness.",
  smartnews: "SmartNews includes shared feed quality checks plus SmartFormat-specific requirements such as full content, author metadata, snf:logo, and media:thumbnail coverage.",
  newsbreak: "NewsBreak includes shared feed quality checks plus full-body and image/media presence checks.",
  google_news: "Google News readiness now emphasizes crawlable article pages, Article/NewsArticle structured data, canonical URLs, dates, authors, images, language, and freshness. Feed signals still help discovery, but Publisher Center-submitted RSS sections are no longer the core path.",
  apple_news: "Apple News is treated as conversion readiness for a later API/ANF integration."
};

const channelLabels: Record<ResultChannel, string> = {
  overall: "Overall",
  smartnews: "SmartNews",
  newsbreak: "NewsBreak",
  google_news: "Google News",
  apple_news: "Apple News"
};

export default function App() {
  const [url, setUrl] = useState(starterFeed);
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<ScanRunSummary[]>([]);
  const [publishers, setPublishers] = useState<PublisherSummary[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [publisherLoading, setPublisherLoading] = useState(false);
  const [selectedScanId, setSelectedScanId] = useState("");
  const [selectedPublisherId, setSelectedPublisherId] = useState("");
  const [selectedChannel, setSelectedChannel] = useState<ResultChannel>("smartnews");
  const [viewMode, setViewMode] = useState<ViewMode>("dashboard");
  const [showPassedChecks, setShowPassedChecks] = useState(false);
  const [articlePreviewMode, setArticlePreviewMode] = useState<ArticlePreviewMode>("smartnews");

  useEffect(() => {
    void refreshOperations();
  }, []);

  useEffect(() => {
    if (selectedChannel === "google_news") {
      setArticlePreviewMode("google_news");
    } else if (selectedChannel === "smartnews") {
      setArticlePreviewMode("smartnews");
    } else if (selectedChannel === "newsbreak") {
      setArticlePreviewMode("newsbreak");
    } else {
      setArticlePreviewMode("diagnostic");
    }
  }, [selectedChannel]);

  const selectedPublisher = useMemo(
    () => publishers.find((publisher) => publisher.id === selectedPublisherId),
    [publishers, selectedPublisherId]
  );

  const visibleHistory = useMemo(() => {
    if (!selectedPublisherId) return history;
    return history.filter((scan) => scan.publisherId === selectedPublisherId);
  }, [history, selectedPublisherId]);

  const metrics = useMemo(() => {
    const scored = publishers.filter((publisher) => publisher.latestFetchedAt);
    const averageScore = scored.length
      ? Math.round(scored.reduce((total, publisher) => total + publisher.latestOverallScore, 0) / scored.length)
      : 0;

    return {
      publishers: publishers.length,
      scans: history.length,
      blocked: publishers.filter((publisher) => publisher.latestCriticalCount > 0 || publisher.status === "blocked").length,
      averageScore
    };
  }, [history.length, publishers]);

  async function refreshOperations() {
    await Promise.all([loadPublishers(), loadHistory()]);
  }

  async function loadPublishers() {
    setPublisherLoading(true);

    try {
      const response = await fetch("/api/publishers");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Publishers failed.");
      setPublishers(data.publishers ?? []);
    } catch (publisherError) {
      setHistoryError(publisherError instanceof Error ? publisherError.message : "Publishers failed.");
    } finally {
      setPublisherLoading(false);
    }
  }

  async function loadHistory() {
    setHistoryLoading(true);
    setHistoryError("");

    try {
      const response = await fetch("/api/scans");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "History failed.");
      setHistory(data.scans ?? []);
    } catch (historyLoadError) {
      setHistoryError(historyLoadError instanceof Error ? historyLoadError.message : "History failed.");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function scanFeed(event: FormEvent) {
    event.preventDefault();
    await runScan(url);
  }

  async function runScan(feedUrl: string) {
    setLoading(true);
    setError("");
    setResult(null);
    setViewMode("scanner");

    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: feedUrl })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Scan failed.");
      setResult(data);
      setSelectedScanId(data.scanRunId ?? "");
      setSelectedPublisherId(data.publisherId ?? selectedPublisherId);
      await refreshOperations();
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Scan failed.");
    } finally {
      setLoading(false);
    }
  }

  async function loadSavedScan(scanRunId: string) {
    setLoading(true);
    setError("");
    setSelectedScanId(scanRunId);
    setViewMode("scanner");

    try {
      const response = await fetch(`/api/scans/${scanRunId}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Saved scan failed.");
      setResult(data);
      setSelectedPublisherId(data.publisherId ?? selectedPublisherId);
    } catch (savedScanError) {
      setError(savedScanError instanceof Error ? savedScanError.message : "Saved scan failed.");
    } finally {
      setLoading(false);
    }
  }

  async function rescan(scan: ScanRunSummary | PublisherSummary) {
    const scanId = "latestScanId" in scan ? scan.latestScanId : scan.id;
    if (!scanId) return;

    setLoading(true);
    setError("");
    setViewMode("scanner");

    try {
      const response = await fetch(`/api/scans/${scanId}/rescan`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Rescan failed.");
      setResult(data);
      setSelectedScanId(data.scanRunId ?? "");
      setSelectedPublisherId(data.publisherId ?? selectedPublisherId);
      await refreshOperations();
    } catch (rescanError) {
      setError(rescanError instanceof Error ? rescanError.message : "Rescan failed.");
    } finally {
      setLoading(false);
    }
  }

  async function updatePublisherField(publisherId: string, values: { status?: string; notes?: string; name?: string }) {
    try {
      const response = await fetch(`/api/publishers/${publisherId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Publisher update failed.");
      await loadPublishers();
    } catch (publisherError) {
      setError(publisherError instanceof Error ? publisherError.message : "Publisher update failed.");
    }
  }

  const selectedChecks = useMemo(() => {
    const checks = result?.checks ?? [];
    if (selectedChannel === "overall") return checks;

    return checks.filter((check) => check.platform === selectedChannel || sharedPlatforms.includes(check.platform));
  }, [result, selectedChannel]);

  const grouped = useMemo(() => {
    const checks = selectedChecks;
    return {
      critical: checks.filter((check) => check.status === "fail" && check.severity === "critical"),
      failed: checks.filter((check) => check.status === "fail" && check.severity !== "critical"),
      warnings: checks.filter((check) => check.status === "warn"),
      passed: checks.filter((check) => check.status === "pass")
    };
  }, [selectedChecks]);

  return (
    <main>
      <section className="hero">
        <div>
          <p className="eyebrow">Content Distribution Operations</p>
          <h1>Operations console</h1>
          <p className="intro">
            Manage publisher feed readiness, scan history, review status, and distribution blockers before public-facing workflows.
          </p>
        </div>
        <form className="scan-form" onSubmit={scanFeed}>
          <label htmlFor="feed-url">Feed URL</label>
          <div className="input-row">
            <input id="feed-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/feed.xml" />
            <button disabled={loading}>{loading ? "Working..." : "Scan"}</button>
          </div>
        </form>
      </section>

      <section className="tabs">
        <button className={viewMode === "dashboard" ? "active" : ""} type="button" onClick={() => setViewMode("dashboard")}>Dashboard</button>
        <button className={viewMode === "scanner" ? "active" : ""} type="button" onClick={() => setViewMode("scanner")}>Scanner</button>
      </section>

      {error && <div className="error">{error}</div>}

      {viewMode === "dashboard" && (
        <>
          <section className="metric-grid">
            <MetricCard label="Publishers" value={metrics.publishers} />
            <MetricCard label="Saved scans" value={metrics.scans} />
            <MetricCard label="Avg score" value={metrics.averageScore} />
            <MetricCard label="Needs attention" value={metrics.blocked} />
          </section>

          <section className="publisher-section">
            <div className="section-head">
              <div>
                <p className="eyebrow">Publisher operations</p>
                <h2>Publisher dashboard</h2>
              </div>
              <button className="secondary-button" type="button" onClick={refreshOperations} disabled={publisherLoading || historyLoading}>
                {publisherLoading || historyLoading ? "Loading" : "Refresh"}
              </button>
            </div>
            <div className="publisher-list">
              {publishers.map((publisher) => (
                <article className={`publisher-row ${selectedPublisherId === publisher.id ? "selected" : ""}`} key={publisher.id}>
                  <button type="button" className="publisher-main" onClick={() => setSelectedPublisherId(selectedPublisherId === publisher.id ? "" : publisher.id)}>
                    <span>
                      <strong>{publisher.name || publisher.domain}</strong>
                      <small>{publisher.latestFeedTitle || publisher.latestFeedUrl || "No scans yet"}</small>
                    </span>
                    <span className="history-meta">
                      <strong>{publisher.latestOverallScore || "-"}</strong>
                      <small>{publisher.scanCount} scans</small>
                    </span>
                    <span className="history-meta">
                      <strong>{publisher.latestCriticalCount}</strong>
                      <small>critical</small>
                    </span>
                    <span className="history-time">{publisher.latestFetchedAt ? formatDate(publisher.latestFetchedAt) : "No runs"}</span>
                  </button>
                  <div className="publisher-controls">
                    <select value={publisher.status} onChange={(event) => void updatePublisherField(publisher.id, { status: event.target.value })}>
                      {publisherStatuses.map((status) => <option key={status} value={status}>{formatStatus(status)}</option>)}
                    </select>
                    <input
                      value={publisher.notes}
                      onChange={(event) => setPublishers((current) => current.map((item) => item.id === publisher.id ? { ...item, notes: event.target.value } : item))}
                      onBlur={(event) => void updatePublisherField(publisher.id, { notes: event.target.value })}
                      placeholder="Internal notes"
                    />
                    <button className="secondary-button" type="button" disabled={!publisher.latestScanId || loading} onClick={() => void rescan(publisher)}>Rescan</button>
                  </div>
                </article>
              ))}
              {!publishers.length && !publisherLoading && <p className="clean">No publishers yet. Run a scan to create the first publisher record.</p>}
            </div>
          </section>
        </>
      )}

      <section className="history-section">
        <div className="section-head">
          <div>
            <p className="eyebrow">Scan history</p>
            <h2>{selectedPublisher ? `${selectedPublisher.domain} runs` : "Recent runs"}</h2>
          </div>
          <button className="secondary-button" type="button" onClick={loadHistory} disabled={historyLoading}>
            {historyLoading ? "Loading" : "Refresh"}
          </button>
        </div>
        {historyError && <div className="error compact">{historyError}</div>}
        <div className="history-list">
          {visibleHistory.map((scan) => (
            <div className={`history-row-shell ${selectedScanId === scan.id ? "selected" : ""}`} key={scan.id}>
              <button className="history-row" onClick={() => void loadSavedScan(scan.id)} type="button">
                <span>
                  <strong>{scan.feedTitle || scan.domain || "Untitled feed"}</strong>
                  <small>{scan.inputUrl}</small>
                </span>
                <span className="history-meta">
                  <strong>{scan.overallScore}</strong>
                  <small>{scan.itemCount} items</small>
                </span>
                <span className="history-meta">
                  <strong>{scan.criticalCount}</strong>
                  <small>critical</small>
                </span>
                <span className="history-time">{formatDate(scan.fetchedAt)}</span>
              </button>
              <button className="secondary-button" type="button" disabled={loading} onClick={() => void rescan(scan)}>Rescan</button>
            </div>
          ))}
          {!visibleHistory.length && !historyLoading && <p className="clean">No saved scans yet.</p>}
        </div>
      </section>

      {viewMode === "scanner" && !result && !error && (
        <section className="empty-state">
          <h2>Ready for the next audit</h2>
          <p>Enter a publisher feed URL, open a saved run, or rescan from history.</p>
        </section>
      )}

      {viewMode === "scanner" && result && (
        <>
          <section className="overview">
            <ScoreCard title="Overall" score={result.overallScore} status={result.feedType.toUpperCase()} selected={selectedChannel === "overall"} onSelect={() => setSelectedChannel("overall")} />
            <ScoreCard title="SmartNews" score={result.platforms.smartnews.score} status={formatStatus(result.platforms.smartnews.status)} selected={selectedChannel === "smartnews"} onSelect={() => setSelectedChannel("smartnews")} />
            <ScoreCard title="NewsBreak" score={result.platforms.newsbreak.score} status={formatStatus(result.platforms.newsbreak.status)} selected={selectedChannel === "newsbreak"} onSelect={() => setSelectedChannel("newsbreak")} />
            <ScoreCard title="Google News" score={result.platforms.googleNews.score} status={formatStatus(result.platforms.googleNews.status)} selected={selectedChannel === "google_news"} onSelect={() => setSelectedChannel("google_news")} />
            <ScoreCard title="Apple News" score={result.platforms.appleNews.score} status={formatStatus(result.platforms.appleNews.status)} selected={selectedChannel === "apple_news"} onSelect={() => setSelectedChannel("apple_news")} />
          </section>

          <section className="summary-bar">
            <span>{result.summary.feedTitle || "Untitled feed"}</span>
            <span>{result.summary.itemCount} items</span>
            <span>{result.summary.critical} critical</span>
            <span>{result.summary.warnings} warnings</span>
            <span>Scanned {new Date(result.fetchedAt).toLocaleString()}</span>
            {result.scanRunId && <span>Run {result.scanRunId.slice(0, 8)}</span>}
          </section>

          <section className="channel-summary panel">
            <div>
              <p className="eyebrow">Selected channel</p>
              <h2>{channelLabels[selectedChannel]} results</h2>
              <p className="note">{channelNotes[selectedChannel]}</p>
            </div>
            <div className="channel-counts">
              <span><strong>{grouped.critical.length}</strong> critical</span>
              <span><strong>{grouped.failed.length + grouped.warnings.length}</strong> warnings</span>
              <span><strong>{grouped.passed.length}</strong> passed</span>
            </div>
          </section>

          <section className="checks-grid">
            <CheckGroup title="Blockers" checks={grouped.critical} />
            <CheckGroup title="Warnings" checks={[...grouped.failed, ...grouped.warnings]} />
            <CheckGroup
              title="Passed checks"
              checks={grouped.passed}
              collapsed={!showPassedChecks}
              onToggle={() => setShowPassedChecks((current) => !current)}
            />
          </section>

          <section className="article-preview-section">
            <div className="article-preview-head">
              <div>
                <p className="eyebrow">Sample article analysis</p>
                <h2>{articlePreviewTitle(articlePreviewMode, result.summary.feedTitle)}</h2>
              </div>
              <div className="preview-toggle" aria-label="Article preview mode">
                <button className={articlePreviewMode === "google_news" ? "active" : ""} type="button" onClick={() => setArticlePreviewMode("google_news")}>Google News Preview</button>
                <button className={articlePreviewMode === "smartnews" ? "active" : ""} type="button" onClick={() => setArticlePreviewMode("smartnews")}>SmartNews Preview</button>
                <button className={articlePreviewMode === "newsbreak" ? "active" : ""} type="button" onClick={() => setArticlePreviewMode("newsbreak")}>NewsBreak Preview</button>
                <button className={articlePreviewMode === "diagnostic" ? "active" : ""} type="button" onClick={() => setArticlePreviewMode("diagnostic")}>Diagnostic Table</button>
              </div>
            </div>

            {articlePreviewMode === "google_news" && <GoogleNewsPreview result={result} />}
            {articlePreviewMode === "smartnews" && <SmartNewsPreview result={result} />}
            {articlePreviewMode === "newsbreak" && <NewsBreakPreview result={result} />}
            {articlePreviewMode === "diagnostic" && <DiagnosticArticleTable items={result.sampleItems} />}
          </section>
        </>
      )}
    </main>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <section className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </section>
  );
}

function ScoreCard({ title, score, status, selected, onSelect }: { title: string; score: number; status: string; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`score-card ${selected ? "selected" : ""}`} onClick={onSelect} type="button" aria-pressed={selected}>
      <div className="score-head">
        <h2>{title}</h2>
        <span>{status}</span>
      </div>
      <div className="score">{score}</div>
      <div className="meter" aria-hidden="true">
        <span style={{ width: `${score}%` }} />
      </div>
    </button>
  );
}

function CheckGroup({
  title,
  checks,
  collapsed = false,
  onToggle
}: {
  title: string;
  checks: FeedCheck[];
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  return (
    <section className="panel check-group">
      <div className="check-group-head">
        <h2>{title}</h2>
        {onToggle && (
          <button className="secondary-button" type="button" onClick={onToggle}>
            {collapsed ? `Show ${checks.length}` : "Hide"}
          </button>
        )}
      </div>
      {collapsed ? (
        <p className="clean">{checks.length} passed checks hidden.</p>
      ) : checks.length ? (
        <div className="check-list">
          {checks.map((check) => (
            <article className={`check ${check.status}`} key={check.id}>
              <div>
                <strong>{check.label}</strong>
              </div>
              <p>{checkMessage(check)}</p>
              <small>{check.recommendation}</small>
            </article>
          ))}
        </div>
      ) : (
        <p className="clean">None</p>
      )}
    </section>
  );
}

function GoogleNewsPreview({ result }: { result: ScanResponse }) {
  const [lead, ...related] = result.sampleItems;
  if (!lead) return <p className="clean">No sample items available.</p>;

  return (
    <section className="google-preview-card" aria-label="Mock Google News preview">
      <div className="mock-label">Mock rendering</div>
      <h3>{result.summary.feedTitle || "Feed"} Google News Preview</h3>
      <div className="google-preview-layout">
        <GoogleStory item={lead} lead />
        <div className="google-related-stack">
          {related.slice(0, 4).map((item) => <GoogleStory item={item} key={`${item.index}-${item.link}`} />)}
        </div>
      </div>
    </section>
  );
}

function GoogleStory({ item, lead = false }: { item: ScanResponse["sampleItems"][number]; lead?: boolean }) {
  const analysis = item.articleAnalysis;
  const imageUrl = analysis?.primaryImageUrl || item.imageUrl;
  const headline = analysis?.headline || item.title || "Missing headline";
  const description = analysis?.description || item.issues.slice(0, 2).join(". ") || "No article description found in page metadata.";
  const source = analysis?.siteName || analysis?.publisher || hostLabel(item.link);

  return (
    <article className={`google-story ${lead ? "lead" : ""}`}>
      {imageUrl && (
        <div className="google-story-image">
          <img src={imageUrl} alt="" />
        </div>
      )}
      <div className="google-story-copy">
        <a href={item.link} target="_blank" rel="noreferrer">{headline}</a>
        {lead && <p>{description}</p>}
        <small>{source} · {formatDate(analysis?.datePublished || item.publishedAt) || "Missing date"}</small>
      </div>
    </article>
  );
}

function SmartNewsPreview({ result }: { result: ScanResponse }) {
  return (
    <section className="smartnews-preview-card" aria-label="Mock SmartNews preview">
      <div className="mock-label">Mock rendering</div>
      <h3>{result.summary.feedTitle || "Feed"} SmartNews Preview</h3>
      <div className="smartnews-list">
        {result.sampleItems.map((item) => <SmartNewsStory item={item} key={`${item.index}-${item.link}`} />)}
      </div>
    </section>
  );
}

function SmartNewsStory({ item }: { item: ScanResponse["sampleItems"][number] }) {
  const analysis = item.articleAnalysis;
  const headline = analysis?.headline || item.title || "Missing headline";
  const source = analysis?.siteName || analysis?.publisher || hostLabel(item.link);
  const hasSmartNewsThumbnail = item.hasThumbnail && Boolean(item.thumbnailUrl);

  return (
    <article className="smartnews-story">
      <div>
        <a href={item.link} target="_blank" rel="noreferrer">{headline}</a>
        <small>{source} · {formatDate(analysis?.datePublished || item.publishedAt) || "Missing date"}</small>
      </div>
      {hasSmartNewsThumbnail ? (
        <img src={item.thumbnailUrl} alt="" />
      ) : (
        <div className="smartnews-missing-thumb" aria-label="SmartNews thumbnail missing">
          <span>thumbnail</span>
          <span>missing</span>
        </div>
      )}
    </article>
  );
}

function NewsBreakPreview({ result }: { result: ScanResponse }) {
  return (
    <section className="newsbreak-preview-card" aria-label="Mock NewsBreak preview">
      <div className="mock-label">Mock rendering</div>
      <h3>{result.summary.feedTitle || "Feed"} NewsBreak Preview</h3>
      <div className="newsbreak-list">
        {result.sampleItems.map((item) => <NewsBreakStory item={item} key={`${item.index}-${item.link}`} />)}
      </div>
    </section>
  );
}

function NewsBreakStory({ item }: { item: ScanResponse["sampleItems"][number] }) {
  const analysis = item.articleAnalysis;
  const headline = analysis?.headline || item.title || "Missing headline";
  const description = analysis?.description || item.issues.slice(0, 2).join(". ") || "No article summary available.";
  const source = analysis?.siteName || analysis?.publisher || hostLabel(item.link);
  const imageUrl = item.thumbnailUrl || analysis?.primaryImageUrl || item.imageUrl;

  return (
    <article className="newsbreak-story">
      {imageUrl && <img src={imageUrl} alt="" />}
      <div className="newsbreak-copy">
        <a href={item.link} target="_blank" rel="noreferrer">{headline}</a>
        <p>{description}</p>
        <small>{source} · {formatDate(analysis?.datePublished || item.publishedAt) || "Missing date"}</small>
      </div>
    </article>
  );
}

function DiagnosticArticleTable({ items }: { items: ScanResponse["sampleItems"] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Title</th>
            <th>Date</th>
            <th>Image</th>
            <th>SmartNews thumbnail</th>
            <th>Article page</th>
            <th>Issues</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={`${item.index}-${item.link}`}>
              <td>{item.index}</td>
              <td>
                <a href={item.link} target="_blank" rel="noreferrer">{item.title || "Missing title"}</a>
              </td>
              <td>{item.publishedAt || "Missing"}</td>
              <td>{item.hasImage ? "Yes" : "No"}</td>
              <td>{item.hasThumbnail ? "Yes" : "No"}</td>
              <td>{articlePageSummary(item)}</td>
              <td>{item.issues.length ? item.issues.join(", ") : "None"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function articlePageSummary(item: ScanResponse["sampleItems"][number]) {
  const analysis = item.articleAnalysis;
  if (!analysis) return "Not checked";
  if (!analysis.reachable) return "Unreachable";
  return [
    analysis.hasArticleStructuredData ? "Schema" : "No schema",
    analysis.canonicalUrl ? "Canonical" : "No canonical",
    analysis.author ? "Author" : "No author",
    analysis.description ? "Description" : "No description"
  ].join(" / ");
}

function articlePreviewTitle(mode: ArticlePreviewMode, feedTitle: string) {
  const title = feedTitle || "Feed";
  if (mode === "google_news") return `${title} Google News Preview`;
  if (mode === "smartnews") return `${title} SmartNews Preview`;
  if (mode === "newsbreak") return `${title} NewsBreak Preview`;
  return "Diagnostic Table";
}

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return <span className={ok ? "badge ok" : "badge warn"}>{label}</span>;
}

function hostLabel(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "Unknown publisher";
  }
}

function checkMessage(check: FeedCheck) {
  return `${checkMarker(check.status)} ${check.message}`;
}

function checkMarker(status: FeedCheck["status"]) {
  if (status === "pass") return "OK";
  return status === "fail" ? "Fail" : "Warn";
}

function formatStatus(status: string) {
  return status.replace("_", " ");
}

function formatDate(value: string) {
  if (!value) return "";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}
