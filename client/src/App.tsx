import { FormEvent, useMemo, useState } from "react";
import type { CheckPlatform, FeedCheck, ScanResponse } from "@content-distribution-operations/shared";

const starterFeed = "https://www.npr.org/rss/rss.php?id=1001";

export default function App() {
  const [url, setUrl] = useState(starterFeed);
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function scanFeed(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Scan failed.");
      setResult(data);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Scan failed.");
    } finally {
      setLoading(false);
    }
  }

  const grouped = useMemo(() => {
    const checks = result?.checks ?? [];
    return {
      critical: checks.filter((check) => check.status === "fail" && check.severity === "critical"),
      failed: checks.filter((check) => check.status === "fail" && check.severity !== "critical"),
      warnings: checks.filter((check) => check.status === "warn"),
      passed: checks.filter((check) => check.status === "pass")
    };
  }, [result]);

  return (
    <main>
      <section className="hero">
        <div>
          <p className="eyebrow">Content Distribution Operations</p>
          <h1>Feed readiness scanner</h1>
          <p className="intro">
            Audit publisher RSS, Atom, and MRSS feeds for operational readiness across key distribution platforms.
          </p>
        </div>
        <form className="scan-form" onSubmit={scanFeed}>
          <label htmlFor="feed-url">Feed URL</label>
          <div className="input-row">
            <input id="feed-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/feed.xml" />
            <button disabled={loading}>{loading ? "Scanning..." : "Scan"}</button>
          </div>
        </form>
      </section>

      {error && <div className="error">{error}</div>}

      {!result && !error && (
        <section className="empty-state">
          <h2>Ready for the first audit</h2>
          <p>Enter a real publisher feed URL to see scoring, issue groups, platform readiness, and sample item details.</p>
        </section>
      )}

      {result && (
        <>
          <section className="overview">
            <ScoreCard title="Overall" score={result.overallScore} status={result.feedType.toUpperCase()} />
            <ScoreCard title="SmartNews" score={result.platforms.smartnews.score} status={formatStatus(result.platforms.smartnews.status)} />
            <ScoreCard title="NewsBreak" score={result.platforms.newsbreak.score} status={formatStatus(result.platforms.newsbreak.status)} />
            <ScoreCard title="Google News" score={result.platforms.googleNews.score} status={formatStatus(result.platforms.googleNews.status)} />
            <ScoreCard title="Apple News" score={result.platforms.appleNews.score} status={formatStatus(result.platforms.appleNews.status)} />
          </section>

          <section className="summary-bar">
            <span>{result.summary.feedTitle || "Untitled feed"}</span>
            <span>{result.summary.itemCount} items</span>
            <span>{result.summary.critical} critical</span>
            <span>{result.summary.warnings} warnings</span>
            <span>Scanned {new Date(result.fetchedAt).toLocaleString()}</span>
          </section>

          <section className="platforms">
            <Platform title="SmartNews" issues={result.platforms.smartnews.issues} />
            <Platform title="NewsBreak" issues={result.platforms.newsbreak.issues} />
            <Platform title="Google News" issues={result.platforms.googleNews.issues} note="Google News readiness now emphasizes crawlable article pages, Article/NewsArticle structured data, canonical URLs, dates, authors, images, language, and freshness. Feed signals still help discovery, but Publisher Center-submitted RSS sections are no longer the core path." />
            <Platform title="Apple News" issues={result.platforms.appleNews.issues} note="Apple News is treated as conversion readiness for a later API/ANF integration." />
          </section>

          <section className="checks-grid">
            <CheckGroup title="Critical" checks={grouped.critical} />
            <CheckGroup title="Warnings" checks={[...grouped.failed, ...grouped.warnings]} />
            <CheckGroup title="Passed" checks={grouped.passed} />
          </section>

          <section className="table-section">
            <h2>Sample item analysis</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Title</th>
                    <th>Date</th>
                    <th>Image</th>
                    <th>Body</th>
                    <th>Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {result.sampleItems.map((item) => (
                    <tr key={`${item.index}-${item.link}`}>
                      <td>{item.index}</td>
                      <td>
                        <a href={item.link} target="_blank" rel="noreferrer">{item.title || "Missing title"}</a>
                      </td>
                      <td>{item.publishedAt || "Missing"}</td>
                      <td>{item.hasImage ? "Yes" : "No"}</td>
                      <td>{item.bodyLength} chars {item.likelyFullText ? "Full" : "Short"}</td>
                      <td>{item.issues.length ? item.issues.join(", ") : "None"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function ScoreCard({ title, score, status }: { title: string; score: number; status: string }) {
  return (
    <article className="score-card">
      <div className="score-head">
        <h2>{title}</h2>
        <span>{status}</span>
      </div>
      <div className="score">{score}</div>
      <div className="meter" aria-hidden="true">
        <span style={{ width: `${score}%` }} />
      </div>
    </article>
  );
}

function Platform({ title, issues, note }: { title: string; issues: string[]; note?: string }) {
  return (
    <article className="panel">
      <h2>{title}</h2>
      {note && <p className="note">{note}</p>}
      {issues.length ? (
        <ul>
          {issues.slice(0, 5).map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      ) : (
        <p className="clean">No readiness issues found.</p>
      )}
    </article>
  );
}

function CheckGroup({ title, checks }: { title: string; checks: FeedCheck[] }) {
  return (
    <section className="panel check-group">
      <h2>{title}</h2>
      {checks.length ? (
        <div className="check-list">
          {checks.map((check) => (
            <article className={`check ${check.status}`} key={check.id}>
              <div>
                <strong>{check.label}</strong>
                <span>{platformLabel(check.platform)} · {check.severity}</span>
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

function checkMessage(check: FeedCheck) {
  return `${checkMarker(check.status)} ${check.message}`;
}

function checkMarker(status: FeedCheck["status"]) {
  if (status === "pass") return "🟢";
  return status === "fail" ? "🔴" : "🟡";
}

function formatStatus(status: string) {
  return status.replace("_", " ");
}

function platformLabel(platform: CheckPlatform) {
  return String(platform).replace("_", " ");
}
