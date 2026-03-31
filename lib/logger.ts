// Minimal logger stub
export function createLogger(meta: Record<string, unknown>) {
  const prefix = meta.event ? `[${meta.event}]` : '[app]'
  return {
    info:  (msg: string, extra?: unknown) => console.log(prefix, msg, extra ?? ''),
    warn:  (msg: string, extra?: unknown) => console.warn(prefix, msg, extra ?? ''),
    error: (msg: string, extra?: unknown) => console.error(prefix, msg, extra ?? ''),
  }
}
