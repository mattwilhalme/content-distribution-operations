import type { SampleItem } from "@content-distribution-operations/shared";

import { supabase } from "./supabase.js";

export async function saveArticleChecks(scanRunId: string, publisherId: string, sampleItems: SampleItem[]): Promise<void> {
  const rows = sampleItems
    .filter((item) => item.link)
    .map((item) => {
      const analysis = item.articleAnalysis;

      return {
        scan_run_id: scanRunId,
        publisher_id: publisherId,
        article_url: item.link,
        title: item.title,
        canonical_url: analysis?.canonicalUrl,
        reachable: analysis?.reachable,
        http_status: analysis?.statusCode,
        has_og_title: Boolean(analysis?.headline),
        has_og_description: Boolean(analysis?.description),
        has_og_image: (analysis?.imageUrls.length ?? 0) > 0,
        has_twitter_card: false,
        has_article_schema: Boolean(analysis?.hasArticleStructuredData),
        has_author: Boolean(analysis?.author),
        has_date_published: Boolean(analysis?.datePublished),
        has_date_modified: Boolean(analysis?.dateModified),
        has_large_image_hint: Boolean(analysis?.hasLargeImageHint),
        has_max_image_preview_large: Boolean(analysis?.hasMaxImagePreviewLarge),
        score: scoreArticle(item),
        issues: item.issues,
        raw: item
      };
    });

  if (rows.length === 0) return;

  const { error } = await supabase.from("article_checks").insert(rows);

  if (error) {
    throw new Error(`Failed to save article checks: ${error.message}`);
  }
}

function scoreArticle(item: SampleItem): number {
  const analysis = item.articleAnalysis;
  let score = 100;

  if (!analysis?.reachable) score -= 30;
  if (!analysis?.hasArticleStructuredData) score -= 15;
  if (!analysis?.headline && !item.title) score -= 10;
  if (!analysis?.description) score -= 5;
  if ((analysis?.imageUrls.length ?? 0) === 0 && !item.hasImage) score -= 10;
  if (!analysis?.datePublished && !item.publishedAt) score -= 10;
  if (!analysis?.author) score -= 10;
  if (!analysis?.canonicalUrl) score -= 5;
  if (!analysis?.hasMaxImagePreviewLarge) score -= 5;

  return Math.max(0, score);
}
