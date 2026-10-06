import { config } from '../config.js';

export function businessTimezone(): string {
  return config.businessTimezone;
}

/** Offset (ms) of `tz` relative to UTC at the given instant. */
function tzOffsetMs(tz: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUTC - Math.floor(date.getTime() / 1000) * 1000;
}

/** Current calendar date in the business timezone: YYYY-MM-DD */
export function todayStr(tz: string = businessTimezone(), at: Date = new Date()): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return dtf.format(at);
}

export function addDays(dateStr: string, days: number): string {
  // Accept both YYYY-MM-DD and full ISO timestamps (callers pass nowISO()).
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    ? new Date(`${dateStr}T00:00:00Z`)
    : new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dayRange(from: string, to: string, tz: string = businessTimezone()): { from: string; to: string } {
  const start = startOfDayIso(from, tz);
  const end = endOfDayIso(to, tz);
  return { from: start, to: end };
}

/** First instant (UTC ISO) of the given YYYY-MM-DD in tz. */
export function startOfDayIso(dateStr: string, tz: string = businessTimezone()): string {
  const guess = new Date(`${dateStr}T00:00:00Z`);
  const offset = tzOffsetMs(tz, guess);
  let iso = new Date(guess.getTime() - offset).toISOString();
  // re-check with the actual instant (DST safety)
  const offset2 = tzOffsetMs(tz, new Date(iso));
  if (offset2 !== offset) iso = new Date(guess.getTime() - offset2).toISOString();
  return iso;
}

export function endOfDayIso(dateStr: string, tz: string = businessTimezone()): string {
  const next = addDays(dateStr, 1);
  return startOfDayIso(next, tz);
}

export type Period = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom' | 'all';

export interface DateFilter {
  from?: string;
  to?: string;
}

/** Resolves a named period (or explicit YYYY-MM-DD bounds) into UTC ISO instant bounds. */
export function resolvePeriod(
  period: string | undefined,
  fromInput?: string,
  toInput?: string,
  tz: string = businessTimezone(),
): DateFilter {
  const today = todayStr(tz);
  switch (period) {
    case 'today':
      return { from: startOfDayIso(today, tz), to: endOfDayIso(today, tz) };
    case 'yesterday':
      return { from: startOfDayIso(addDays(today, -1), tz), to: endOfDayIso(addDays(today, -1), tz) };
    case '7d':
      return { from: startOfDayIso(addDays(today, -6), tz), to: endOfDayIso(today, tz) };
    case '30d':
      return { from: startOfDayIso(addDays(today, -29), tz), to: endOfDayIso(today, tz) };
    case 'month':
      return { from: startOfDayIso(`${today.slice(0, 7)}-01`, tz), to: endOfDayIso(today, tz) };
    case 'custom': {
      const out: DateFilter = {};
      if (fromInput) out.from = startOfDayIso(fromInput, tz);
      if (toInput) out.to = endOfDayIso(toInput, tz);
      return out;
    }
    default:
      return {};
  }
}

/**
 * SQLite expression that renders a UTC ISO timestamp column as a local
 * calendar date (YYYY-MM-DD) in the business timezone.
 */export function sqlLocalDate(column: string, tz: string = businessTimezone()): string {
  const offsetMin = tzOffsetMs(tz, new Date()) / 60000;
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = Math.round(abs % 60);
  const sign = offsetMin < 0 ? '-' : '+';
  const mods: string[] = [];
  if (h) mods.push(`'${sign}${h} hours'`);
  if (m) mods.push(`'${sign}${m} minutes'`);
  if (mods.length === 0) mods.push(`'+0 minutes'`);
  return `date(substr(${column}, 1, 19), ${mods.join(', ')})`;
}

/** Resolves a named period (or explicit bounds) into YYYY-MM-DD date bounds. */
export function resolvePeriodDates(
  period: string | undefined,
  fromInput?: string,
  toInput?: string,
  tz: string = businessTimezone(),
): { from?: string; to?: string } {
  const today = todayStr(tz);
  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case '7d':
      return { from: addDays(today, -6), to: today };
    case '30d':
      return { from: addDays(today, -29), to: today };
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'custom': {
      const out: { from?: string; to?: string } = {};
      if (fromInput) out.from = fromInput;
      if (toInput) out.to = toInput;
      return out;
    }
    default:
      return { from: fromInput, to: toInput };
  }
}
