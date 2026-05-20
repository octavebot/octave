/**
 * Chart image generator for triggered alerts.
 *
 * For each `triggered` alert we POST a Chart.js config to quickchart.io and
 * get back a hosted PNG URL. Telegram's sendPhoto then fetches it directly
 * from the URL (so we never need to download/upload bytes ourselves).
 *
 *   - Free, no API key required
 *   - 5-second timeout — if QuickChart is slow we fall back to text-only
 *   - Both line-of-closes and candlestick rendering supported; we use
 *     candlestick because Chart.js financial plugin is bundled on QuickChart
 *
 * The chart shows the last ~50 bars of gold 5m with horizontal lines at:
 *   green  = entry
 *   red    = stop loss
 *   blue   = TP1
 *   blue   = TP2 (dashed)
 *   orange = current price marker (label only)
 */

import { fetchAllPanes } from './cloud_data_supplement.js';

const QUICKCHART_URL = 'https://quickchart.io/chart/create';
const FETCH_TIMEOUT_MS = 5000;

/**
 * Build a QuickChart-hosted PNG URL for a triggered alert.
 *
 * @param {object} alert  The triggered alert object (must have entryPlan)
 * @returns {Promise<string|null>}  URL to a PNG, or null if anything fails
 */
export async function buildAlertChartUrl(alert) {
  try {
    if (!alert?.entryPlan) return null;
    const ep = alert.entryPlan;

    // Last 50 5-minute gold bars from the same cache the detector uses
    const panes = await fetchAllPanes();
    const pane = panes.get('gold|5') || panes.get('gold|15');
    if (!pane?.bars?.length) return null;
    const bars = pane.bars.slice(-50);
    if (bars.length < 10) return null;

    const lastPrice = bars[bars.length - 1].close;
    const dir = alert.direction;
    const dirEmoji = dir === 'LONG' ? '🟢' : '🔴';
    const stratNum = strategyNum(alert.strategy);

    // Y-axis bounds — include all important levels with a little padding
    const levels = [ep.entry, ep.stop, ep.t1, ep.t2, ep.runner, lastPrice].filter(Number.isFinite);
    const dataLow  = Math.min(...bars.map((b) => b.low),  ...levels);
    const dataHigh = Math.max(...bars.map((b) => b.high), ...levels);
    const pad = (dataHigh - dataLow) * 0.05;

    const chartConfig = {
      type: 'candlestick',
      data: {
        datasets: [{
          label: 'GOLD 5m',
          data: bars.map((b) => ({
            x: b.time * 1000,
            o: b.open, h: b.high, l: b.low, c: b.close,
          })),
          color: {
            up:   '#22c55e',
            down: '#ef4444',
            unchanged: '#9ca3af',
          },
        }],
      },
      options: {
        responsive: false,
        plugins: {
          legend: { display: false },
          title: {
            display: true,
            text: `${dirEmoji} ${stratNum} ${dir} TRIGGERED · GOLD ${ep.entry.toFixed(2)}`,
            color: '#e7eaf3',
            font: { size: 16, weight: 'bold' },
          },
          annotation: {
            annotations: {
              entry: {
                type: 'line',
                yMin: ep.entry, yMax: ep.entry,
                borderColor: '#22c55e', borderWidth: 2,
                label: { content: `Entry ${ep.entry.toFixed(2)}`, enabled: true, position: 'end', backgroundColor: '#22c55e', color: '#000' },
              },
              stop: {
                type: 'line',
                yMin: ep.stop, yMax: ep.stop,
                borderColor: '#ef4444', borderWidth: 2,
                label: { content: `SL ${ep.stop.toFixed(2)}`, enabled: true, position: 'end', backgroundColor: '#ef4444', color: '#fff' },
              },
              tp1: ep.t1 != null ? {
                type: 'line',
                yMin: ep.t1, yMax: ep.t1,
                borderColor: '#3b82f6', borderWidth: 2,
                label: { content: `TP1 ${ep.t1.toFixed(2)}`, enabled: true, position: 'end', backgroundColor: '#3b82f6', color: '#fff' },
              } : undefined,
              tp2: (ep.t2 != null && ep.t2 !== ep.t1) ? {
                type: 'line',
                yMin: ep.t2, yMax: ep.t2,
                borderColor: '#3b82f6', borderWidth: 2, borderDash: [6, 6],
                label: { content: `TP2 ${ep.t2.toFixed(2)}`, enabled: true, position: 'end', backgroundColor: '#3b82f6', color: '#fff' },
              } : undefined,
              now: {
                type: 'line',
                yMin: lastPrice, yMax: lastPrice,
                borderColor: '#fbbf24', borderWidth: 1, borderDash: [2, 4],
                label: { content: `Now ${lastPrice.toFixed(2)}`, enabled: true, position: 'start', backgroundColor: '#fbbf24', color: '#000' },
              },
            },
          },
        },
        scales: {
          x: { type: 'time', time: { unit: 'hour' }, ticks: { color: '#8b94aa' }, grid: { color: '#232a3a' } },
          y: {
            min: dataLow - pad,
            max: dataHigh + pad,
            ticks: { color: '#8b94aa', callback: (v) => '$' + Number(v).toFixed(0) },
            grid: { color: '#232a3a' },
          },
        },
      },
    };

    // POST → get short URL pointing to the PNG
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(QUICKCHART_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chart: chartConfig,
        width: 900,
        height: 520,
        backgroundColor: '#0b0e14',
        format: 'png',
        version: '4',
      }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));

    if (!res.ok) {
      console.error('[chart-image] quickchart non-2xx:', res.status);
      return null;
    }
    const data = await res.json();
    return data?.url || null;
  } catch (err) {
    // Never let chart generation crash an alert send
    console.error('[chart-image] generation failed:', err.message);
    return null;
  }
}

function strategyNum(name) {
  const map = { USLS: '#1', 'ICT-SMC': '#2', 'ALGO-SMC': '#3', ADAPTIVE: '#4', ICT: '#5', SMT: '#6', TRINITY: '#7', AMN: '#8', TORI: '#9', WARRIOR: '#10' };
  return map[name] || '#?';
}
