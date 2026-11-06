// Browser-safe env lookup. The PWA has no `process`; Vite exposes VITE_* on
// import.meta.env instead, so check both and never throw.
export function readEnv(name: string): string | undefined {
  if (typeof process !== 'undefined' && process.env) {
    const v = process.env[name];
    if (v) return v;
  }
  try {
    const metaEnv = (import.meta as unknown as { env?: Record<string, unknown> }).env;
    const v = metaEnv?.[`VITE_${name}`] ?? metaEnv?.[name];
    if (typeof v === 'string' && v) return v;
  } catch {
    // import.meta.env is a bundler feature; plain runtimes may lack it.
  }
  return undefined;
}
