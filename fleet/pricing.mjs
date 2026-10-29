// fleet/pricing.mjs — what a kilowatt-hour costs where the owner lives.
//
// The owner gives a ZIP code (Settings in the Fleet tab); its first three digits
// name the state, and the state's average residential price comes from the table
// below. A typed-in ¢/kWh (from an actual bill) wins over the table. Estimates
// only: a utility's tiers, delivery charges and time-of-use rates are not modelled.

// EIA Electric Power Monthly, Table 5.6.A: average residential price, ¢/kWh.
// Refresh from https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_6_a
export const RATES_AS_OF = '2026-07'
export const STATE_RATES = {
  AK: 28.83, AL: 16.40, AR: 14.33, AZ: 15.38, CA: 33.61, CO: 17.00, CT: 24.16, DC: 25.21,
  DE: 18.48, FL: 15.03, GA: 16.27, HI: 48.00, IA: 15.99, ID: 13.73, IL: 19.22, IN: 16.73,
  KS: 15.27, KY: 13.81, LA: 12.72, MA: 30.49, MD: 21.41, ME: 32.41, MI: 23.05, MN: 17.45,
  MO: 16.09, MS: 14.54, MT: 14.99, NC: 15.16, ND: 13.41, NE: 13.78, NH: 26.60, NJ: 25.19,
  NM: 16.09, NV: 12.77, NY: 29.90, OH: 19.45, OK: 14.35, OR: 15.97, PA: 21.72, RI: 28.29,
  SC: 15.47, SD: 15.37, TN: 13.71, TX: 15.88, UT: 13.12, VA: 17.55, VT: 23.75, WA: 14.71,
  WI: 19.06, WV: 15.78, WY: 14.36,
}
export const US_AVERAGE = 18.31

// USPS three-digit ZIP prefixes, by state. Gaps (military, territories) are null.
const ZIP3 = [
  [5, 5, 'NY'], [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'], [50, 59, 'VT'],
  [60, 69, 'CT'], [70, 89, 'NJ'], [100, 149, 'NY'], [150, 196, 'PA'], [197, 199, 'DE'],
  [200, 205, 'DC'], [206, 219, 'MD'], [220, 246, 'VA'], [247, 268, 'WV'], [270, 289, 'NC'],
  [290, 299, 'SC'], [300, 319, 'GA'], [320, 349, 'FL'], [350, 369, 'AL'], [370, 385, 'TN'],
  [386, 397, 'MS'], [398, 399, 'GA'], [400, 427, 'KY'], [430, 459, 'OH'], [460, 479, 'IN'],
  [480, 499, 'MI'], [500, 528, 'IA'], [530, 549, 'WI'], [550, 567, 'MN'], [569, 569, 'DC'],
  [570, 577, 'SD'], [580, 588, 'ND'], [590, 599, 'MT'], [600, 629, 'IL'], [630, 658, 'MO'],
  [660, 679, 'KS'], [680, 693, 'NE'], [700, 714, 'LA'], [716, 729, 'AR'], [730, 749, 'OK'],
  [750, 799, 'TX'], [800, 816, 'CO'], [820, 831, 'WY'], [832, 838, 'ID'], [840, 847, 'UT'],
  [850, 865, 'AZ'], [870, 884, 'NM'], [885, 885, 'TX'], [889, 898, 'NV'], [900, 961, 'CA'],
  [967, 968, 'HI'], [970, 979, 'OR'], [980, 994, 'WA'], [995, 999, 'AK'],
]

export function stateForZip(zip) {
  const m = /^\s*(\d{3})\d{2}(?:-\d{4})?\s*$/.exec(String(zip || ''))
  if (!m) return null
  const p = Number(m[1])
  return ZIP3.find(([lo, hi]) => p >= lo && p <= hi)?.[2] || null
}

/** `{ centsPerKwh, source, state }` for the stored settings. */
export function resolveRate({ zip, rateCents } = {}) {
  const state = stateForZip(zip)
  const typed = Number(rateCents)
  if (Number.isFinite(typed) && typed > 0) return { centsPerKwh: typed, source: 'custom', state, asOf: null }
  if (state && STATE_RATES[state]) return { centsPerKwh: STATE_RATES[state], source: 'state', state, asOf: RATES_AS_OF }
  return { centsPerKwh: US_AVERAGE, source: 'us', state: null, asOf: RATES_AS_OF }
}
