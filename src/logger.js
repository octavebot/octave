const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function level() {
  return LEVELS[process.env.LOG_LEVEL_OVERRIDE] || LEVELS.info;
}

function emit(stream, lvl, msg, meta) {
  if (LEVELS[lvl] < level()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...(meta || {}) });
  stream.write(line + '\n');
}

const throttleState = new Map();

export const log = {
  debug: (msg, meta) => emit(process.stdout, 'debug', msg, meta),
  info: (msg, meta) => emit(process.stdout, 'info', msg, meta),
  warn: (msg, meta) => emit(process.stderr, 'warn', msg, meta),
  error: (msg, meta) => emit(process.stderr, 'error', msg, meta),
  throttled(key, intervalMs, fn) {
    const now = Date.now();
    const last = throttleState.get(key) || 0;
    if (now - last >= intervalMs) {
      throttleState.set(key, now);
      fn();
    }
  },
};
