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
