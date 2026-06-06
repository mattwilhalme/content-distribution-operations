import type { ScanResponse } from "@content-distribution-operations/shared";

import { supabase } from "./supabase.js";

interface SaveFeedCandidateInput {
  publisherId: string;
  domain: string;
  feedUrl: string;
  scan: ScanResponse;
}

export async function saveFeedCandidate({
  publisherId,
  domain,
  feedUrl,
  scan
}: SaveFeedCandidateInput): Promise<string> {
  const payload = {
    publisher_id: publisherId,
    domain,
    feed_url: feedUrl,
    feed_type: scan.feedType,
    source: "manual_scan",
    is_valid_xml: scan.feedType !== "unknown",
    item_count: scan.summary.itemCount,
    score: scan.overallScore,
    selected: true,
    raw: scan,
    updated_at: new Date().toISOString()
  };
  const { data: existing, error: existingError } = await supabase
    .from("feed_candidates")
    .select("id")
    .eq("domain", domain)
    .eq("feed_url", feedUrl)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Failed to load feed candidate: ${existingError.message}`);
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from("feed_candidates")
      .update(payload)
      .eq("id", existing.id);

    if (updateError) {
      throw new Error(`Failed to update feed candidate: ${updateError.message}`);
    }

    return String(existing.id);
  }

  const { data, error } = await supabase
    .from("feed_candidates")
    .insert(payload)
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to save feed candidate: ${error.message}`);
  }

  return String(data.id);
}
