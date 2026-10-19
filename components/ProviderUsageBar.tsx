"use client";

import { useEffect, useState } from "react";
import { Check, ChevronRight, Gauge, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatUsageBalance, formatUsageReset, usageTone, useProviderUsage } from "./AppShell-provider-usage";
import type { ProviderUsageBalance, ProviderUsageReport, ProviderUsageWindow } from "@/lib/provider-usage-types";
import { SidebarIconButton } from "./SessionSidebar-chrome";
import { Tooltip } from "./ui/primitives";

interface WindowDef {
  short: string;
  pick: (report: ProviderUsageReport) => ProviderUsageWindow | undefined;
}

const WINDOWS: WindowDef[] = [
  { short: "5H", pick: (r) => r.fiveHour },
  { short: "7D", pick: (r) => r.sevenDay },
  { short: "30D", pick: (r) => r.monthly },
];

const COLLAPSED_STORAGE_KEY = "omp-web:provider-usage-collapsed";

function worstWindow(report: ProviderUsageReport): { short: string; window: ProviderUsageWindow } | null {
  let best: { short: string; window: ProviderUsageWindow } | null = null;
  for (const def of WINDOWS) {
    const window = def.pick(report);
    if (window && (best === null || window.percent > best.window.percent)) {
      best = { short: def.short, window };
    }
  }
  return best;
}

function DetailMeter({ short, window, t }: {
  short: string;
  window: ProviderUsageWindow;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const pct = Math.round(window.percent);
  const tone = usageTone(pct);
  const rawReset = window.resetMinutes ?? window.resetHours;
  const reset = rawReset !== undefined
    ? formatUsageReset(rawReset, window.resetMinutes !== undefined ? "minutes" : "hours")
    : null;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-dim)", letterSpacing: "0.04em", width: 22, flexShrink: 0 }}>{short}</span>
      <span style={{ flex: 1, minWidth: 0, height: 3, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: `${Math.min(100, Math.max(0, pct))}%`, background: tone, borderRadius: 2 }} />
      </span>
      <span style={{ fontSize: 10, fontWeight: 700, color: tone, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
        {pct}%
      </span>
      {reset && (
        <span style={{ fontSize: 9, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>
          {t("providerUsage.resets", { value: reset })}
        </span>
      )}
    </span>
  );
}

// Compact provider rate-limit block pinned above Settings in the sidebar: one
// slim row per account (worst window only), click to expand the full detail.
export function ProviderUsageBar() {
  const { t } = useI18n();
  const { snapshot, loading, error, refresh } = useProviderUsage("", 5 * 60_000);
  const [refreshDone, setRefreshDone] = useState(false);
  useEffect(() => {
    if (!refreshDone) return;
    const timer = window.setTimeout(() => setRefreshDone(false), 2000);
    return () => window.clearTimeout(timer);
  }, [refreshDone]);
  const reports = snapshot?.reports ?? [];
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // The first render must match the server, where localStorage is unavailable,
  // so start collapsed and apply the stored preference after mounting.
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => {
    try {
      // No stored choice yet → stay hidden; an explicit expand persists.
      if (window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "false") setCollapsed(false);
    } catch {
      // Storage unavailable: keep the collapsed default.
    }
  }, []);

  let worst: { percent: number; window: string } | null = null;
  // A balance-only provider reports no percentage at all; without this the
  // header would claim "no provider limits reported" while the row shows money.
  // The header and row carry the primary balance — the account's own money.
  // Narrower per-key caps stay in the expansion, so a nearly exhausted key
  // never hides how much the account actually holds.
  let primaryBalance: ProviderUsageBalance | null = null;
  for (const report of reports) {
    const best = worstWindow(report);
    if (best && (worst === null || best.window.percent > worst.percent)) {
      worst = { percent: Math.round(best.window.percent), window: best.short };
    }
    const balance = report.balances?.[0];
    if (balance && (primaryBalance === null || balance.remaining < primaryBalance.remaining)) {
      primaryBalance = balance;
    }
  }

  return (
    <section
      aria-label={t("appShell.sectionProviderUsage")}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "8px 8px 6px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-panel)",
        flexShrink: 0,
        minHeight: 0,
        maxHeight: "32vh",
        overflowY: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
      <button
        type="button"
        onClick={() => setCollapsed((v) => {
          const next = !v;
          try {
            window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next));
          } catch {
            // The preference still applies for this page load.
          }
          return next;
        })}
        aria-expanded={!collapsed}
        title={t("appShell.sectionProviderUsage")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          flex: 1,
          boxSizing: "border-box",
          padding: "0 4px",
          minWidth: 0,
          background: "none",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <ChevronRight
          size={11}
          strokeWidth={2}
          aria-hidden="true"
          style={{
            flexShrink: 0,
            color: "var(--text-dim)",
            transform: collapsed ? "none" : "rotate(90deg)",
            transition: "transform var(--dur-med) var(--ease-out-warm)",
          }}
        />
        <span aria-hidden="true" style={{ display: "flex", color: "var(--accent)", flexShrink: 0 }}>
          <Gauge size={13} strokeWidth={2} aria-hidden="true" />
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("appShell.sectionProviderUsage")}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 10, fontFamily: "var(--font-mono)", color: worst ? usageTone(worst.percent) : "var(--text-dim)", fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
          {loading && reports.length === 0
            ? t("appShell.providerUsageLoading")
            : error
              ? t("appShell.providerUsageUnavailable")
              : worst
                ? primaryBalance
                  ? t("providerUsage.highestAndBalance", { percent: worst.percent, window: worst.window, amount: formatUsageBalance(primaryBalance) })
                  : t("providerUsage.highest", { percent: worst.percent, window: worst.window })
                : primaryBalance
                  ? t("providerUsage.balance", { amount: formatUsageBalance(primaryBalance) })
                  : t("appShell.providerUsageNoData")}
        </span>
      </button>
        <Tooltip content={t("sessionSidebar.refresh")} side="top">
          <SidebarIconButton
            label={t("sessionSidebar.refresh")}
            active={refreshDone}
            disabled={loading}
            onClick={() => {
              setRefreshDone(false);
              void refresh().then(setRefreshDone);
            }}
          >
            {refreshDone ? (
              <Check size={14} strokeWidth={2.2} aria-hidden="true" />
            ) : (
              <RefreshCw size={14} strokeWidth={1.9} aria-hidden="true" />
            )}
          </SidebarIconButton>
        </Tooltip>
      </div>
      {!collapsed && reports.map((report, index) => {
        const account = report.accountLabel ?? t("appShell.account", { number: report.accountIndex ?? index + 1 });
        const key = `${report.provider}:${account}:${report.modelId ?? "all"}:${index}`;
        const best = worstWindow(report);
        const expanded = expandedKey === key;
        // A dollar/credit balance has no percentage window: show the money the
        // provider reports instead of a 0% bar or the "∞" no-limits mark. The
        // row carries the primary balance; the expansion lists each one.
        const balances = report.balances ?? [];
        const primary = balances[0];
        const balance = primary ? formatUsageBalance(primary) : null;
        const pct = best ? Math.round(best.window.percent) : 0;
        const tone = usageTone(pct);
        const expandable = !report.noLimits && (best !== null || balances.length > 0);
        // The bar follows money spent against the reported cap; a balance
        // without a cap (pure prepaid credit) has nothing to fill.
        const balanceFraction = primary?.limit && primary.used !== undefined
          ? Math.min(100, Math.max(0, (primary.used / primary.limit) * 100))
          : null;
        const barPct = best ? pct : balanceFraction;
        return (
          <div key={key} style={{ borderRadius: "var(--radius-control)", background: expanded ? "var(--bg-subtle)" : "transparent" }}>
            <button
              type="button"
              onClick={() => setExpandedKey((prev) => (prev === key ? null : key))}
              aria-expanded={expandable ? expanded : undefined}
              title={account}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "100%",
                boxSizing: "border-box",
                padding: "5px 6px 4px",
                background: "none",
                border: "none",
                cursor: expandable ? "pointer" : "default",
                textAlign: "left",
                minWidth: 0,
              }}
            >
              {expandable && (
                <ChevronRight
                  size={11}
                  strokeWidth={2}
                  aria-hidden="true"
                  style={{
                    flexShrink: 0,
                    color: "var(--text-dim)",
                    transform: expanded ? "rotate(90deg)" : "none",
                    transition: "transform var(--dur-med) var(--ease-out-warm)",
                  }}
                />
              )}
              <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 10, color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", padding: "0 5px", borderRadius: 4, whiteSpace: "nowrap", flexShrink: 0, lineHeight: 1.7 }}>
                {report.provider}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                {account}
              </span>
              {balance ? (
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: "var(--text)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {balance}
                </span>
              ) : report.noLimits ? (
                <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>∞</span>
              ) : (
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: tone, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {pct}%
                </span>
              )}
            </button>
            {barPct !== null && (
              <div style={{ height: 3, margin: "0 6px 0 23px", borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(100, Math.max(0, barPct))}%`, background: best ? tone : usageTone(barPct), borderRadius: 2 }} />
              </div>
            )}
            {expanded && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "6px 8px 7px 23px", fontFamily: "var(--font-mono)" }}>
                {balances.map((entry, entryIndex) => (
                  <span
                    key={entry.label ?? entryIndex}
                    style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}
                  >
                    <span style={{ minWidth: 22, flexShrink: 0, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                      {entry.label ?? t("providerUsage.balanceShort")}
                    </span>
                    <span style={{ color: "var(--text)", fontWeight: 700 }}>
                      {formatUsageBalance(entry)}
                    </span>
                    {entry.used !== undefined && entry.limit !== undefined && (
                      <span>
                        {formatUsageBalance({ ...entry, remaining: entry.used })}
                        {" / "}
                        {formatUsageBalance({ ...entry, remaining: entry.limit })}
                      </span>
                    )}
                  </span>
                ))}
                {WINDOWS.map((def) => {
                  const window = def.pick(report);
                  return window ? <DetailMeter key={def.short} short={def.short} window={window} t={t} /> : null;
                })}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
