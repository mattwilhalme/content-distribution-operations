interface SaveCrawlAttemptInput {
  publisherId?: string;
  domain: string;
  attemptedUrl: string;
  finalUrl?: string;
  httpStatus?: number;
  contentType?: string | null;
  success: boolean;
  error?: string;
  raw?: Record<string, unknown>;
}

import { supabase } from "./supabase.js";

export async function saveCrawlAttempt(input: SaveCrawlAttemptInput): Promise<void> {
  const { error } = await supabase.from("crawl_attempts").insert({
    publisher_id: input.publisherId,
    domain: input.domain,
    attempted_url: input.attemptedUrl,
    attempt_type: "manual_feed",
    http_status: input.httpStatus,
    content_type: input.contentType,
    final_url: input.finalUrl,
    success: input.success,
    discovered_feed_url: input.success ? input.finalUrl ?? input.attemptedUrl : undefined,
    error: input.error,
    raw: input.raw
  });

  if (error) {
    throw new Error(`Failed to save crawl attempt: ${error.message}`);
  }
}
