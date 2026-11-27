/**
 * Pool panel: chart controls, the visible-range navigator and one card per
 * pooled provider (Claude, Codex). The page owns the settings so the ledger
 * below reads the same projection.
 */

import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { poolText } from "./poolText";
import { ProviderLogo } from "../../chat/ui";
import IconChevronLeft from "@tabler/icons-react/dist/esm/icons/IconChevronLeft.mjs";
import IconChevronDown from "@tabler/icons-react/dist/esm/icons/IconChevronDown.mjs";
import IconAdjustmentsHorizontal from "@tabler/icons-react/dist/esm/icons/IconAdjustmentsHorizontal.mjs";
import { stepZoomedView, type TimeView } from "./poolZoom";
import { ZoomButtons, ZoomTrack } from "./PoolZoomControls";

type ResolvedTheme = "dark" | "light";
import { PoolChart, type PoolChartMode } from "./PoolChart";
import {
  BURN_WINDOWS,
  FORECAST_DEFAULTS,
  changedForecastSettings,
  FUTURE_USAGE,
  OFFSET_LIMITS,
  POOL_PROVIDER_MODES,
  POOL_WINDOWS,
  QUIET_HOURS,
  normalizeOffDays,
  quietHoursOf,
  type BurnWindow,
  type FutureUsage,
  type QuietHoursId,
  type PoolProviderMode,
  type PoolSettings,
  type PoolWindow,
} from "./poolSettings";
import type { RoutingStrategy } from "./poolModel";
import {
  bandOpacity,
  EVENT_LONG_KEY,
  formatHourOfDay,
  formatPercent,
} from "./poolFormat";
import {
  ACCENTS,
  EVENT_KINDS,
  FABLE_ACCENT,
  poolCardStats,
  poolHeadline,
  poolLegendText,
  poolRangeText,
  shownEventKinds,
  shownFable,
  type PoolCardData,
} from "./poolCards";
import styles from "./QuotaPoolPanel.module.css";

export type { PoolCardData };

export interface QuotaPoolPanelProps {
  settings: PoolSettings;
  onSettingsChange: (
    patch:
      Partial<PoolSettings> | ((prev: PoolSettings) => Partial<PoolSettings>),
  ) => void;
  cards: PoolCardData[];
  /** The page's whole range. */
  range: TimeView;
  /** The part of it the charts show: the range itself unless zoomed. */
  view: TimeView;
  zoomed: boolean;
  now: number;
  resolvedTheme: ResolvedTheme;
  /** True until the first history response (or its failure) lands. */
  historyLoading: boolean;
  /** Providers with a pool, before any merging; the merge toggle needs two. */
  providerCount: number;
}

const ROUTING: readonly RoutingStrategy[] = ["soonest-reset", "fill-first", "round-robin"];

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  className = "",
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div className={`${styles.segmented} ${className}`} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={value === option.value}
          className={styles.segment}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Sunday-first, matching the chart's day columns. */
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

function weekdayName(
  day: number,
  locale: string | undefined,
  width: "narrow" | "long",
) {
  // Jan 2, 2000 was a Sunday.
  return new Date(2000, 0, 2 + day).toLocaleDateString(locale, {
    weekday: width,
  });
}

function OffDayToggles({
  value,
  onChange,
  label,
  locale,
}: {
  value: number[];
  onChange: (days: number[]) => void;
  label: string;
  locale: string | undefined;
}) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {WEEKDAYS.map((day) => {
        const name = weekdayName(day, locale, "long");
        const on = value.includes(day);
        return (
          <button
            key={day}
            type="button"
            aria-pressed={on}
            aria-label={name}
            title={name}
            className={`${styles.segment} ${styles.daySegment}`}
            onClick={() =>
              onChange(
                normalizeOffDays(
                  on ? value.filter((d) => d !== day) : [...value, day],
                ),
              )
            }
          >
            {weekdayName(day, locale, "narrow")}
          </button>
        );
      })}
    </div>
  );
}

function ProviderIcon({
  type,
}: {
  type: string;
  resolvedTheme: ResolvedTheme;
}) {
  return <ProviderLogo driver={type} size={20} />;
}

function CardIcon({
  card,
  resolvedTheme,
}: {
  card: PoolCardData;
  resolvedTheme: ResolvedTheme;
}) {
  if (card.type !== "all")
    return <ProviderIcon type={card.type} resolvedTheme={resolvedTheme} />;
  return (
    <span className={styles.iconStack}>
      {card.ratios.map(({ type }) => (
        <ProviderIcon key={type} type={type} resolvedTheme={resolvedTheme} />
      ))}
    </span>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.stat}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function PoolCard({
  card,
  settings,
  range,
  view,
  onViewChange,
  now,
  resolvedTheme,
  historyLoading,
}: {
  card: PoolCardData;
  settings: PoolSettings;
  range: TimeView;
  view: TimeView;
  onViewChange: (view: TimeView | null) => void;
  now: number;
  resolvedTheme: ResolvedTheme;
  historyLoading: boolean;
}) {
  const { t, i18n } = poolText;
  const locale = i18n.resolvedLanguage;
  const { model } = card;
  const { name, stats } = poolCardStats(card, {
    window: settings.window,
    now,
    historyLoading,
    locale,
  });
  const headline = poolHeadline(model);
  const combinedView = settings.window === "combined";
  const accent =
    ACCENTS[card.type][resolvedTheme === "dark" ? "dark" : "light"];
  const eventKinds = EVENT_KINDS[settings.window];
  // Fable's cap is weekly, so it shares the weekly and combined views only.
  const fable = shownFable(card, settings);
  const shownEvents = shownEventKinds(model, settings.window, view, now);
  const legend = poolLegendText(card, settings);

  return (
    <article
      className={styles.card}
      style={
        {
          "--pool-accent": accent,
          "--pool-overlay": FABLE_ACCENT[resolvedTheme === "dark" ? "dark" : "light"],
        } as CSSProperties
      }
      aria-label={t("quota_management.pool_card_label", { name })}
    >
      <header className={styles.cardHead}>
        <div className={styles.cardTitle}>
          <CardIcon card={card} resolvedTheme={resolvedTheme} />
          <h2>{name}</h2>
          <span className={styles.cardCount}>
            {t("quota_management.pool_accounts", { count: model.accountCount })}
          </span>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.bigValue}>
            <span className={styles.big}>{headline.current}</span>
            <span className={styles.of}>{headline.of}</span>
          </div>
          <dl className={styles.stats}>
            {stats.map((stat) => (
              <Stat key={stat.label} label={stat.label}>
                {stat.lead && (
                  <>
                    <strong>{stat.lead}</strong>{" "}
                  </>
                )}
                <span className={stat.warn ? styles.warn : undefined}>
                  {stat.value}
                </span>
              </Stat>
            ))}
          </dl>
        </div>
      </header>

      <PoolChart
        model={model}
        mode={settings.mode}
        hourly={settings.window === "five-hour"}
        startMs={view.startMs}
        endMs={view.endMs}
        bounds={range}
        onViewChange={onViewChange}
        now={now}
        showAccounts={settings.showAccounts}
        idle={{
          quietHours: quietHoursOf(settings.quiet),
          offDays: settings.offDays,
        }}
        label={name}
        // Every 5-hour window refills in the combined view; label only the big ones.
        minResetLabel={combinedView ? model.capacity / 4 : 0}
        eventKinds={eventKinds}
        overlay={fable ? { label: "Fable", model: fable } : null}
      />

      <footer className={styles.legend}>
        <span className={styles.legendTitle}>{legend.title}</span>
        <span className={styles.legendItem}>
          <span className={styles.swatchSolid} />
          {t("quota_management.pool_legend_recorded")}
        </span>
        <span className={styles.legendItem}>
          <span className={styles.swatchDashed} />
          {t("quota_management.pool_legend_projected")}
        </span>
        {fable && (
          <span className={styles.legendItem}>
            <span className={styles.swatchOverlay} />
            Fable {formatPercent(fable.current)}
          </span>
        )}
        {(settings.quiet !== "off" || settings.offDays.length > 0) && (
          <span className={styles.legendItem}>
            <span className={styles.swatchQuiet} />
            {t("quota_management.pool_legend_quiet")}
          </span>
        )}
        {shownEvents.map((kind) => (
          <span key={kind} className={styles.legendItem}>
            <span
              className={`${styles.swatchEvent} ${styles[`swatchEvent-${kind}`]}`}
            />
            {t(EVENT_LONG_KEY[kind])}
          </span>
        ))}
        {settings.showAccounts &&
          settings.mode === "remaining" &&
          model.accounts.map((account, index) => (
            <span key={account.key} className={styles.legendItem}>
              <span
                className={styles.swatchBand}
                style={{ opacity: bandOpacity(index, model.accounts.length) }}
              />
              {account.label}
            </span>
          ))}
        <span className={styles.legendNote}>{legend.note}</span>
      </footer>
    </article>
  );
}


export function QuotaPoolPanel({
  settings,
  onSettingsChange,
  cards,
  range,
  view,
  zoomed,
  now,
  resolvedTheme,
  historyLoading,
  providerCount,
}: QuotaPoolPanelProps) {
  const { t, i18n } = poolText;
  const locale = i18n.resolvedLanguage;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsId = useId();
  if (cards.length === 0) return null;
  const changed = changedForecastSettings(settings);
  const settingsName = changed
    ? `${t("quota_management.pool_settings")}, ${t("quota_management.pool_settings_changed", { count: changed })}`
    : t("quota_management.pool_settings");

  const limits = OFFSET_LIMITS[settings.window];
  const rangeText = poolRangeText({
    window: settings.window,
    range,
    view,
    zoomed,
    locale,
  });

  const setZoom = (zoom: TimeView | null) => onSettingsChange({ zoom });
  // Unzoomed, the arrows page; zoomed, they slide a whole view and page on past the edge.
  const canStep = (direction: -1 | 1) =>
    zoomed
      ? stepZoomedView(view, range, direction, settings.offset, limits) !== null
      : direction < 0
        ? settings.offset > limits.min
        : settings.offset < limits.max;
  const step = (direction: -1 | 1) => {
    if (!zoomed) {
      onSettingsChange((prev) => ({ offset: prev.offset + direction }));
      return;
    }
    const patch = stepZoomedView(view, range, direction, settings.offset, limits);
    if (patch) onSettingsChange(patch);
  };

  return (
    <section
      className={styles.panel}
      aria-label={t("quota_management.pool_section")}
    >
      <div className={styles.toolbar}>
        <div className={styles.views}>
          <Segmented<PoolWindow>
            label={t("quota_management.pool_window")}
            value={settings.window}
            onChange={(window) =>
              onSettingsChange({ window, offset: 0, zoom: null })
            }
            className={styles.fullRow}
            options={POOL_WINDOWS.map((value) => ({
              value,
              label: t(
                value === "weekly"
                  ? "quota_management.pool_window_weekly"
                  : value === "five-hour"
                    ? "quota_management.pool_window_five_hour"
                    : "quota_management.pool_window_combined",
              ),
            }))}
          />
          {providerCount > 1 && (
            <Segmented<PoolProviderMode>
              label={t("quota_management.pool_providers")}
              value={settings.providers}
              onChange={(providers) => onSettingsChange({ providers })}
              options={POOL_PROVIDER_MODES.map((value) => ({
                value,
                label: t(`quota_management.pool_providers_${value}`),
              }))}
            />
          )}
          <Segmented<PoolChartMode>
            label={t("quota_management.pool_view")}
            className={providerCount > 1 ? "" : styles.fullRow}
            value={settings.mode}
            onChange={(mode) => onSettingsChange({ mode })}
            options={[
              {
                value: "remaining",
                label: t("quota_management.pool_mode_remaining"),
              },
              { value: "rate", label: t("quota_management.pool_mode_rate") },
            ]}
          />
        </div>
        <button
          type="button"
          className={styles.settingsButton}
          aria-expanded={settingsOpen}
          aria-controls={settingsOpen ? settingsId : undefined}
          aria-label={settingsName}
          title={settingsName}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <IconAdjustmentsHorizontal size={16} aria-hidden />
          {t("quota_management.pool_settings")}
          {changed > 0 && (
            <span className={styles.changedCount} aria-hidden>
              {changed}
            </span>
          )}
          <IconChevronDown size={14} aria-hidden className={styles.chevron} />
        </button>
      </div>

      {settingsOpen && (
        <div
          id={settingsId}
          className={styles.settings}
          role="group"
          aria-label={t("quota_management.pool_settings")}
        >
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t("quota_management.pool_routing")}</span>
            <select
              value={settings.strategy}
              onChange={(e) => onSettingsChange({ strategy: e.target.value as RoutingStrategy })}
            >
              {ROUTING.map((value) => (
                <option key={value} value={value}>
                  {t(`quota_management.pool_routing_${value}`)}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>
              {t("quota_management.pool_burn_rate")}
            </span>
            <Segmented<BurnWindow>
              label={t("quota_management.pool_burn_rate")}
              value={settings.burnWindow}
              onChange={(burnWindow) => onSettingsChange({ burnWindow })}
              options={BURN_WINDOWS.map((hours) => ({
                value: hours,
                label: `${hours}h`,
              }))}
            />
          </div>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t("quota_management.pool_future")}</span>
            <select
              value={settings.future}
              onChange={(e) => onSettingsChange({ future: e.target.value as FutureUsage })}
            >
              {FUTURE_USAGE.map((value) => (
                <option key={value} value={value}>
                  {t(`quota_management.pool_future_${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t("quota_management.pool_quiet")}</span>
            <select
              value={settings.quiet}
              onChange={(e) => onSettingsChange({ quiet: e.target.value as QuietHoursId })}
            >
              {QUIET_HOURS.map((value) => {
                const hours = quietHoursOf(value);
                return (
                  <option key={value} value={value}>
                    {hours
                      ? t("quota_management.pool_quiet_range", {
                          from: formatHourOfDay(hours.startHour, locale),
                          to: formatHourOfDay(hours.endHour, locale),
                        })
                      : t("quota_management.pool_quiet_off")}
                  </option>
                );
              })}
            </select>
          </label>
          <div className={`${styles.field} ${styles.fieldWide}`}>
            <span className={styles.fieldLabel}>{t("quota_management.pool_off_days")}</span>
            <OffDayToggles
              value={settings.offDays}
              onChange={(offDays) => onSettingsChange({ offDays })}
              label={t("quota_management.pool_off_days")}
              locale={locale}
            />
          </div>
          <div className={styles.settingsFoot}>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={settings.showAccounts}
                disabled={settings.mode !== "remaining"}
                onChange={() =>
                  onSettingsChange((prev) => ({ showAccounts: !prev.showAccounts }))
                }
              />
              <span>
                {cards.some((card) => card.type === "all")
                  ? t("quota_management.pool_providers_toggle")
                  : t("quota_management.pool_accounts_toggle")}
                {settings.mode !== "remaining" && (
                  <small> · {t("quota_management.pool_bands_remaining_only")}</small>
                )}
              </span>
            </label>
            <button
              type="button"
              className={styles.reset}
              disabled={changed === 0}
              onClick={() => onSettingsChange(FORECAST_DEFAULTS)}
            >
              {t("quota_management.pool_settings_reset")}
            </button>
          </div>
        </div>
      )}

      <div className={styles.rangeRow}>
        <span className={styles.rangeText} aria-live="polite">
          {rangeText}
        </span>
        <div className={styles.rangeNav}>
          <ZoomButtons range={range} view={view} zoomed={zoomed} onChange={setZoom} />
          <button
            type="button"
            className={styles.navButton}
            onClick={() => step(-1)}
            disabled={!canStep(-1)}
            aria-label={t("quota_management.windows_prev")}
            title={t("quota_management.windows_prev")}
          >
            <IconChevronLeft size={16} />
          </button>
          <button
            type="button"
            className={styles.todayButton}
            onClick={() => onSettingsChange({ offset: 0, zoom: null })}
            data-current={settings.offset === 0 && !zoomed ? "true" : "false"}
          >
            {t("quota_management.windows_today")}
          </button>
          <button
            type="button"
            className={`${styles.navButton} ${styles.navNext}`}
            onClick={() => step(1)}
            disabled={!canStep(1)}
            aria-label={t("quota_management.windows_next")}
            title={t("quota_management.windows_next")}
          >
            <IconChevronLeft size={16} />
          </button>
        </div>
      </div>

      {zoomed && (
        <ZoomTrack
          range={range}
          view={view}
          now={now}
          valueText={rangeText}
          onChange={setZoom}
        />
      )}

      {cards.map((card) => (
        <PoolCard
          key={card.type}
          card={card}
          settings={settings}
          range={range}
          view={view}
          onViewChange={setZoom}
          now={now}
          resolvedTheme={resolvedTheme}
          historyLoading={historyLoading}
        />
      ))}
    </section>
  );
}
