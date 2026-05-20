/**
 * Bar resampling — aggregate N consecutive bars into a single larger bar.
 *
 * Yahoo gives us native 1m / 5m / 15m / 30m / 60m / 1D for gold. For TFs Yahoo
 * doesn't expose (4H, 2H, 8H), we build them by grouping smaller bars.
 *
 * The 4H boundary convention here is NY-local: each 4H bar starts on a
 * 4-hour wall-clock boundary in America/New_York (00:00, 04:00, 08:00, 12:00,
 * 16:00, 20:00 EST/EDT). This matches how TradingView and most chart vendors
 * present 4H gold bars.
 */
import { nyParts } from './time.js';

/**
 * Group bars by NY-local 4-hour bucket and emit OHLCV bars on those boundaries.
 *
 * Each output bar:
 *   - time:   first input bar's unix time in the bucket
 *   - open:   first input bar's open
 *   - high:   max high across the bucket
 *   - low:    min low across the bucket
 *   - close:  last input bar's close
 *   - volume: sum
 *
 * The most recent in-progress bucket is included (partial 4H bar). Drop it if
 * you need only completed bars: `bars.slice(0, -1)`.
 */
export function resampleTo4H(hourlyBars) {
  if (!Array.isArray(hourlyBars) || hourlyBars.length === 0) return [];
  const buckets = new Map(); // bucketKey -> bar
  const order = [];
  for (const b of hourlyBars) {
    const np = nyParts(b.time);
    const bucketStartHour = Math.floor(np.hour / 4) * 4;
    const key = `${np.dateKey}|${bucketStartHour}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume || 0,
      };
      buckets.set(key, bucket);
      order.push(key);
    } else {
      if (b.high > bucket.high) bucket.high = b.high;
      if (b.low < bucket.low) bucket.low = b.low;
      bucket.close = b.close;
      bucket.volume += b.volume || 0;
    }
  }
  return order.map((k) => buckets.get(k));
}

/**
 * Generic N-bar grouping (no calendar alignment). Useful when you just want
 * "every 4 bars combined" without caring about wall-clock boundaries.
 */
export function resampleEveryN(bars, n) {
  if (n <= 1) return bars.slice();
  const out = [];
  for (let i = 0; i < bars.length; i += n) {
    const chunk = bars.slice(i, i + n);
    if (chunk.length === 0) continue;
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((b) => b.high)),
      low: Math.min(...chunk.map((b) => b.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((a, b) => a + (b.volume || 0), 0),
    });
  }
  return out;
}
