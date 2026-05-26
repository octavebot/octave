/**
 * fetch with a hard timeout.
 *
 * Node's global fetch has NO default timeout. A network black-hole (TCP connect
 * that hangs with no RST, a server that accepts then never responds) makes the
 * awaiting code hang indefinitely. In the signal engine that stalls the whole
 * 3s detection tick — the heartbeat then goes stale and the watchdog restarts
 * the engine ~5 min later. Until then the bot is silently frozen. The same hang
 * on an LLM call stalls signal delivery; on a feed it blocks the data refresh.
 *
 * Wrapping every outbound call in a timeout makes them FAIL FAST instead, so the
 * caller degrades gracefully (fallback feed, no-op LLM, cached news) and the
 * tick keeps moving. AbortSignal.timeout requires Node ≥18 (VPS runs 20).
 *
 * @param {string|URL} url
 * @param {object} opts      standard fetch options
 * @param {number} timeoutMs hard ceiling; the fetch aborts (throws) past this
 */
export async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  // Respect a caller-supplied signal if present; otherwise enforce our timeout.
  const signal = opts.signal || AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...opts, signal });
}
