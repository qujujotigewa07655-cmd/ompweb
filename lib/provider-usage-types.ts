export type ProviderUsageWindowId = "5h" | "7d" | "monthly";

export interface ProviderUsageWindow {
  percent: number;
  resetMinutes?: number;
  resetHours?: number;
}

/**
 * Money or credit balance instead of a window percentage — what aggregators
 * like OpenRouter report. `remaining` is what is left under that limit; several
 * balances can coexist (account prepaid money, per-key cap).
 */
export interface ProviderUsageBalance {
  label?: string;
  remaining: number;
  used?: number;
  limit?: number;
  unit: string;
}

export interface ProviderUsageReport {
  provider: string;
  accountLabel?: string;
  accountIndex?: number;
  plan?: string;
  modelId?: string;
  tier?: string;
  noLimits?: boolean;
  /** Every balance the provider reported, primary first. */
  balances?: ProviderUsageBalance[];
  fiveHour?: ProviderUsageWindow;
  sevenDay?: ProviderUsageWindow;
  monthly?: ProviderUsageWindow;
}

export interface ProviderUsageSnapshot {
  generatedAt: number | null;
  reports: ProviderUsageReport[];
}

export interface ProviderUsageContext {
  provider: string;
  modelId: string;
}
