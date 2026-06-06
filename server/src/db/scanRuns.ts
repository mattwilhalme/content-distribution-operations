import type { FeedCheck, ScanResponse, ScanRunSummary } from "@content-distribution-operations/shared";

import { supabase } from "./supabase.js";

interface SaveScanRunInput {
  scan: ScanResponse;
  inputUrl: string;
  finalUrl: string;
  domain: string;
  publisherId: string;
  feedCandidateId: string;
}

export async function saveScanRun({
  scan,
  inputUrl,
  finalUrl,
  domain,
  publisherId,
  feedCandidateId
}: SaveScanRunInput): Promise<string> {
  const { data: scanRun, error: scanRunError } = await supabase
    .from("scan_runs")
    .insert({
      publisher_id: publisherId,
      feed_candidate_id: feedCandidateId,
      input_url: inputUrl,
      final_url: finalUrl,
      domain,
      feed_type: scan.feedType,
      feed_title: scan.summary.feedTitle,
      item_count: scan.summary.itemCount,
      overall_score: scan.overallScore,
      smartnews_score: scan.platforms.smartnews.score,
      newsbreak_score: scan.platforms.newsbreak.score,
      google_news_score: scan.platforms.googleNews.score,
      apple_news_score: scan.platforms.appleNews.score,
      critical_count: scan.summary.critical,
      warning_count: scan.summary.warnings,
      failed_count: scan.summary.failed,
      raw_result: scan,
      fetched_at: scan.fetchedAt
    })
    .select("id")
    .single();

  if (scanRunError) {
    throw new Error(`Failed to save scan run: ${scanRunError.message}`);
  }

  const scanRunId = String(scanRun.id);
  await saveScanChecks(scanRunId, scan.checks);

  return scanRunId;
}

async function saveScanChecks(scanRunId: string, checks: FeedCheck[]) {
  if (checks.length === 0) return;

  const { error } = await supabase.from("scan_checks").insert(
    checks.map((check) => ({
      scan_run_id: scanRunId,
      check_id: check.id,
      label: check.label,
      status: check.status,
      severity: check.severity,
      platform: check.platform,
      message: check.message,
      recommendation: check.recommendation
    }))
  );

  if (error) {
    throw new Error(`Failed to save scan checks: ${error.message}`);
  }
}

interface ScanRunRow {
  id: string;
  publisher_id: string | null;
  feed_candidate_id: string | null;
  input_url: string;
  final_url: string | null;
  domain: string | null;
  feed_type: ScanResponse["feedType"] | null;
  feed_title: string | null;
  item_count: number | null;
  overall_score: number | null;
  smartnews_score: number | null;
  newsbreak_score: number | null;
  google_news_score: number | null;
  apple_news_score: number | null;
  critical_count: number | null;
  warning_count: number | null;
  failed_count: number | null;
  fetched_at: string;
}

interface ScanRunDetailRow extends ScanRunRow {
  raw_result: ScanResponse;
}

export async function listScanRuns(limit = 25): Promise<ScanRunSummary[]> {
  const { data, error } = await supabase
    .from("scan_runs")
    .select("id, publisher_id, feed_candidate_id, input_url, final_url, domain, feed_type, feed_title, item_count, overall_score, smartnews_score, newsbreak_score, google_news_score, apple_news_score, critical_count, warning_count, failed_count, fetched_at")
    .order("fetched_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load scan history: ${error.message}`);
  }

  return (data as ScanRunRow[]).map(toScanRunSummary);
}

export async function getScanRun(scanRunId: string): Promise<ScanResponse | null> {
  const { data, error } = await supabase
    .from("scan_runs")
    .select("id, publisher_id, feed_candidate_id, input_url, final_url, domain, feed_type, feed_title, item_count, overall_score, smartnews_score, newsbreak_score, google_news_score, apple_news_score, critical_count, warning_count, failed_count, fetched_at, raw_result")
    .eq("id", scanRunId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load scan: ${error.message}`);
  }

  if (!data) return null;

  const row = data as ScanRunDetailRow;
  return {
    ...row.raw_result,
    scanRunId: row.id,
    publisherId: row.publisher_id ?? undefined,
    feedCandidateId: row.feed_candidate_id ?? undefined
  };
}

function toScanRunSummary(row: ScanRunRow): ScanRunSummary {
  return {
    id: row.id,
    publisherId: row.publisher_id ?? "",
    feedCandidateId: row.feed_candidate_id ?? "",
    inputUrl: row.input_url,
    finalUrl: row.final_url ?? "",
    domain: row.domain ?? "",
    feedType: row.feed_type ?? "unknown",
    feedTitle: row.feed_title ?? "",
    itemCount: row.item_count ?? 0,
    overallScore: row.overall_score ?? 0,
    smartnewsScore: row.smartnews_score ?? 0,
    newsbreakScore: row.newsbreak_score ?? 0,
    googleNewsScore: row.google_news_score ?? 0,
    appleNewsScore: row.apple_news_score ?? 0,
    criticalCount: row.critical_count ?? 0,
    warningCount: row.warning_count ?? 0,
    failedCount: row.failed_count ?? 0,
    fetchedAt: row.fetched_at
  };
}
