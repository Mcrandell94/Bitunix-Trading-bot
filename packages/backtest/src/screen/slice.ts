/**
 * `--slice k/n` (2026-10-09): every n-th coin of a fresh coin list, starting at the k-th, so a slow run (the 15m
 * history downloads) can be split into parallel jobs. Coins in `keep` (BTC, loaded as the shorts' reference) stay in
 * every slice and do not count. Pure.
 */
export function sliceList(list: ReadonlyArray<string>, spec: string | undefined, keep: ReadonlySet<string> = new Set()): string[] {
  if (!spec) return [...list];
  const m = /^(\d+)\/(\d+)$/.exec(spec), k = Number(m?.[1]), n = Number(m?.[2]);
  if (!m || !(n >= 1) || !(k >= 1 && k <= n)) throw new Error(`--slice must be k/n with 1 <= k <= n (got ${spec})`);
  let i = 0;
  return list.filter((s) => keep.has(s) || i++ % n === k - 1);
}
