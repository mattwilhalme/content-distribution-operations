import type { PublisherSummary } from "@content-distribution-operations/shared";

import { supabase } from "./supabase.js";

interface PublisherRow {
  id: string;
  name: string | null;
  domain: string;
  homepage_url: string | null;
  status: string;
  notes: string | null;
}

interface LatestScanRow {
  id: string;
  publisher_id: string | null;
  input_url: string;
  feed_title: string | null;
  overall_score: number | null;
  critical_count: number | null;
  warning_count: number | null;
  failed_count: number | null;
  fetched_at: string;
}

export async function upsertPublisher(domain: string, homepageUrl: string): Promise<string> {
  const { data, error } = await supabase
    .from("publishers")
    .upsert(
      {
        domain,
        homepage_url: homepageUrl,
        updated_at: new Date().toISOString()
      },
      { onConflict: "domain" }
    )
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to save publisher: ${error.message}`);
  }

  return String(data.id);
}

export async function listPublishers(): Promise<PublisherSummary[]> {
  const { data: publishers, error: publisherError } = await supabase
    .from("publishers")
    .select("id, name, domain, homepage_url, status, notes")
    .order("updated_at", { ascending: false });

  if (publisherError) {
    throw new Error(`Failed to load publishers: ${publisherError.message}`);
  }

  const publisherRows = publishers as PublisherRow[];
  if (publisherRows.length === 0) return [];

  const publisherIds = publisherRows.map((publisher) => publisher.id);
  const { data: scans, error: scanError } = await supabase
    .from("scan_runs")
    .select("id, publisher_id, input_url, feed_title, overall_score, critical_count, warning_count, failed_count, fetched_at")
    .in("publisher_id", publisherIds)
    .order("fetched_at", { ascending: false });

  if (scanError) {
    throw new Error(`Failed to load publisher scans: ${scanError.message}`);
  }

  const latestByPublisher = new Map<string, LatestScanRow>();
  const countsByPublisher = new Map<string, number>();

  for (const scan of scans as LatestScanRow[]) {
    if (!scan.publisher_id) continue;
    countsByPublisher.set(scan.publisher_id, (countsByPublisher.get(scan.publisher_id) ?? 0) + 1);
    if (!latestByPublisher.has(scan.publisher_id)) {
      latestByPublisher.set(scan.publisher_id, scan);
    }
  }

  return publisherRows.map((publisher) => {
    const latest = latestByPublisher.get(publisher.id);

    return {
      id: publisher.id,
      name: publisher.name ?? "",
      domain: publisher.domain,
      homepageUrl: publisher.homepage_url ?? "",
      status: publisher.status,
      notes: publisher.notes ?? "",
      latestScanId: latest?.id ?? "",
      latestFeedUrl: latest?.input_url ?? "",
      latestFeedTitle: latest?.feed_title ?? "",
      latestOverallScore: latest?.overall_score ?? 0,
      latestCriticalCount: latest?.critical_count ?? 0,
      latestWarningCount: latest?.warning_count ?? 0,
      latestFailedCount: latest?.failed_count ?? 0,
      latestFetchedAt: latest?.fetched_at ?? "",
      scanCount: countsByPublisher.get(publisher.id) ?? 0
    };
  });
}

export async function updatePublisher(
  publisherId: string,
  values: { status?: string; notes?: string; name?: string }
): Promise<void> {
  const updates = {
    ...values,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase.from("publishers").update(updates).eq("id", publisherId);

  if (error) {
    throw new Error(`Failed to update publisher: ${error.message}`);
  }
}
