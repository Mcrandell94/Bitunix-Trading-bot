// A probe of LiqWall (liqwall.com; owner 2026-10-17: "I added LIQWALL_API_KEY. See what you can do with it"). LiqWall
// shows liquidation heatmaps, order-book walls of 14 exchanges, liquidations and Hyperliquid whales; its API is not
// documented anywhere reachable, so this looks for it: the home page's API / docs links, the usual spec paths (OpenAPI,
// llms.txt, sitemap), and its MCP server (JSON-RPC initialize + tools/list, which lists every tool with its inputs).
// Research only, no data tools are called. The key goes only to LiqWall's own hosts, as `Authorization: Bearer` and
// `X-API-Key`, and is never printed: it, any email and any key-like field are masked (the repo's Actions logs are
// public). The container's proxy blocks the host, so it runs on GitHub Actions (--lw-probe).

import { shape } from './cryptodata';

export const LW = {
  hosts: ['https://liqwall.com', 'https://api.liqwall.com'],
  pages: ['/', '/api', '/docs', '/developers', '/api/docs', '/openapi.json', '/api/openapi.json', '/api/v1/openapi.json', '/llms.txt', '/.well-known/mcp.json', '/sitemap.xml'],
  mcp: ['https://liqwall.com/mcp', 'https://liqwall.com/api/mcp', 'https://mcp.liqwall.com/mcp', 'https://mcp.liqwall.com'],
} as const;

type Res = { ok: boolean; status: number; headers?: { get(name: string): string | null }; text(): Promise<string> };
type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Res>;

/** A JSON-RPC answer from plain JSON or a server-sent-events body (`data: {...}` lines). */
export function rpcBody(t: string): Record<string, unknown> | null {
  const tryJson = (s: string) => { try { const j = JSON.parse(s); return j && typeof j === 'object' ? (j as Record<string, unknown>) : null; } catch { return null; } };
  return tryJson(t) ?? t.split('\n').filter((l) => l.startsWith('data:')).map((l) => tryJson(l.slice(5).trim())).find((j) => j && ('result' in j || 'error' in j)) ?? null;
}

export async function lwProbe(key: string | undefined, fetchFn: FetchFn = fetch as unknown as FetchFn): Promise<string[]> {
  const mask = (s: string) => (key ? s.split(key).join('***') : s)
    .replace(/("(?:api_?key|key_?(?:prefix|hint|id)?|token|secret|email|user(?:name|_id)?|account(?:_id)?|owner)"\s*:\s*)"[^"]*"/gi, '$1"***"')
    .replace(/Bearer\s+[^\s"']+/g, 'Bearer ***').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***');
  const auth: Record<string, string> = key ? { Authorization: `Bearer ${key}`, 'X-API-Key': key } : {};
  const out = [`===== LIQWALL PROBE (${key ? 'with the LIQWALL_API_KEY secret' : 'no LIQWALL_API_KEY secret for this workflow: calls without a key'}) =====`];
  const call = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    try {
      const r = await fetchFn(url, { ...init, headers: { ...auth, ...(init.headers ?? {}) } }), t = await r.text();
      return { status: r.status, text: t, session: r.headers?.get('mcp-session-id') ?? null, type: r.headers?.get('content-type') ?? '' };
    } catch (e) { return { status: 0, text: (e as Error).message, session: null, type: '' }; }
  };
  out.push('', 'Pages:');
  for (const host of LW.hosts) for (const p of LW.pages) {
    const r = await call(`${host}${p}`), html = /html/i.test(r.type) || /^\s*</.test(r.text);
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(r.text)?.[1]?.trim();
    // Links that point at an API, docs, keys or MCP.
    const links = [...new Set([...r.text.matchAll(/(?:href|src)=["']([^"']+)["']/gi)].map((m) => m[1]!).filter((u) => /api|docs?|developer|mcp|openapi|key|pricing|plan/i.test(u)))].slice(0, 25);
    let json: unknown = null;
    try { json = JSON.parse(r.text); } catch { /* not JSON */ }
    const paths = json && typeof json === 'object' ? Object.keys((json as { paths?: object }).paths ?? {}) : [];
    out.push(` ${host}${p} → HTTP ${r.status}${title ? ` · "${mask(title)}"` : ''}${paths.length ? ` · spec, ${paths.length} paths: ${paths.join(', ')}` : json != null ? ` · ${mask(shape(json))}` : ''}`);
    if (links.length) out.push(`   links: ${mask(links.join(' '))}`);
    if (r.status === 200 && !html && !paths.length) out.push(`   ${mask(r.text.replace(/\s+/g, ' ')).slice(0, 1500)}`);
    if (p === '/sitemap.xml' && r.status === 200) out.push(`   pages: ${[...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => /api|doc|developer|mcp|key/i.test(u!)).slice(0, 30).join(' ') || '(none about an API)'}`);
  }
  out.push('', 'MCP (initialize, then tools/list):');
  const rpc = (id: number, method: string, params: unknown) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const hdr = (s?: string | null) => ({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(s ? { 'Mcp-Session-Id': s } : {}) });
  for (const url of LW.mcp) {
    const init = await call(url, { method: 'POST', headers: hdr(), body: rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bitunix-bot-probe', version: '1' } }) });
    const ij = rpcBody(init.text);
    out.push(` ${url} initialize → HTTP ${init.status}${ij ? ` · ${mask(JSON.stringify((ij.result as Record<string, unknown> | undefined)?.serverInfo ?? ij.error ?? ij)).slice(0, 400)}` : ` · ${mask(init.text.replace(/\s+/g, ' ')).slice(0, 200)}`}`);
    if (!ij || !('result' in ij)) continue;
    const instr = (ij.result as { instructions?: string }).instructions;
    if (instr) out.push(`   instructions: ${mask(instr.replace(/\s+/g, ' ')).slice(0, 1500)}`);
    await call(url, { method: 'POST', headers: hdr(init.session), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    const tl = await call(url, { method: 'POST', headers: hdr(init.session), body: rpc(2, 'tools/list', {}) }), tj = rpcBody(tl.text);
    const tools = ((tj?.result as { tools?: { name: string; description?: string; inputSchema?: { properties?: Record<string, { type?: string; enum?: unknown[]; description?: string }>; required?: string[] } }[] } | undefined)?.tools) ?? [];
    out.push(`   tools/list → HTTP ${tl.status} · ${tools.length} tools${tools.length ? '' : ` · ${mask(tl.text.replace(/\s+/g, ' ')).slice(0, 400)}`}`);
    for (const t of tools) {
      const props = Object.entries(t.inputSchema?.properties ?? {}).map(([k, v]) => `${k}${t.inputSchema?.required?.includes(k) ? '*' : ''}${v.type ? `:${v.type}` : ''}${v.enum ? ` [${v.enum.join('|')}]` : ''}`);
      out.push(`   - ${t.name}(${props.join(', ')}): ${mask((t.description ?? '').replace(/\s+/g, ' ')).slice(0, 400)}`);
    }
    break; // one MCP server is enough
  }
  return out;
}
