// JSON-lines logger: one object per line on stdout/stderr, easy to read in
// Railway or journald.

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function jsonLogger(write: (line: string, isError: boolean) => void = (l, e) => (e ? console.error(l) : console.log(l))): Logger {
  const emit = (level: string, msg: string, fields: Record<string, unknown> = {}) =>
    write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }), level === 'error');
  return {
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
