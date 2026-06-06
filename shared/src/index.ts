export type CheckStatus = "pass" | "warn" | "fail";

export type CheckSeverity = "low" | "medium" | "high" | "critical";

export type CheckPlatform =
  | "general"
  | "smartnews"
  | "newsbreak"
  | "google_news"
  | "apple_news"
  | "media"
  | "content";

export interface FeedCheck {
  id: string;
  label: string;
  status: CheckStatus;
  severity: CheckSeverity;
  platform: CheckPlatform;
  message: string;
  recommendation: string;
}

export interface PlatformReadiness {
  score: number;
  status: "ready" | "needs_work" | "blocked";
  issues: string[];
}

export interface SampleItem {
  index: number;
  title: string;
  link: string;
  guid: string;
  publishedAt: string;
  hasImage: boolean;
  imageUrl: string;
  hasContentEncoded: boolean;
  bodyLength: number;
  likelyFullText: boolean;
  issues: string[];
  articleAnalysis?: ArticleAnalysis;
}

export interface ArticleAnalysis {
  reachable: boolean;
  statusCode?: number;
  hasArticleStructuredData: boolean;
  headline: string;
  imageUrls: string[];
  datePublished: string;
  dateModified: string;
  author: string;
  publisher: string;
  canonicalUrl: string;
  hasLargeImageHint: boolean;
  hasMaxImagePreviewLarge: boolean;
}

export interface ScanSummary {
  totalChecks: number;
  passed: number;
  warnings: number;
  failed: number;
  critical: number;
  itemCount: number;
  feedTitle: string;
}

export interface ScanResponse {
  scanRunId?: string;
  publisherId?: string;
  feedCandidateId?: string;
  url: string;
  fetchedAt: string;
  feedType: "rss" | "atom" | "unknown";
  overallScore: number;
  summary: ScanSummary;
  checks: FeedCheck[];
  platforms: {
    smartnews: PlatformReadiness;
    newsbreak: PlatformReadiness;
    googleNews: PlatformReadiness;
    appleNews: PlatformReadiness;
  };
  sampleItems: SampleItem[];
}

export interface ScanRunSummary {
  id: string;
  publisherId: string;
  feedCandidateId: string;
  inputUrl: string;
  finalUrl: string;
  domain: string;
  feedType: ScanResponse["feedType"];
  feedTitle: string;
  itemCount: number;
  overallScore: number;
  smartnewsScore: number;
  newsbreakScore: number;
  googleNewsScore: number;
  appleNewsScore: number;
  criticalCount: number;
  warningCount: number;
  failedCount: number;
  fetchedAt: string;
}

export interface PublisherSummary {
  id: string;
  name: string;
  domain: string;
  homepageUrl: string;
  status: string;
  notes: string;
  latestScanId: string;
  latestFeedUrl: string;
  latestFeedTitle: string;
  latestOverallScore: number;
  latestCriticalCount: number;
  latestWarningCount: number;
  latestFailedCount: number;
  latestFetchedAt: string;
  scanCount: number;
}
