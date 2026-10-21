'use strict';
/**
 * Free web search with no API key: DuckDuckGo's HTML results page, or your own
 * SearXNG instance if you run one. Used to give non-Grok AI providers (Claude,
 * GPT, local Llama) fresh search results to work from.
 */
const ctx = require('../core/ctx');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const decode = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

async function duckduckgo(q, n) {
  const res = await fetch('https://html.duckduckgo.com/html/', { method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ q }), signal: AbortSignal.timeout(15000) });
  const html = await res.text(); const out = [];
  for (const m of html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g)) {
    let url = m[1]; const u = /uddg=([^&]+)/.exec(url); if (u) url = decodeURIComponent(u[1]);
    if (!/^https?:/.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    out.push({ title: decode(m[2]), url, snippet: decode(m[3] || '') });
    if (out.length >= n) break;
  }
  return out;
}

async function searxng(base, q, n) {
  const res = await fetch(`${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(q)}&format=json`, { signal: AbortSignal.timeout(15000) });
  const j = await res.json();
  return (j.results || []).slice(0, n).map((r) => ({ title: r.title, url: r.url, snippet: r.content || '' }));
}

async function search(q, n = 8) {
  const sx = ctx.setting('ai.searxngUrl', '');
  if (sx) { try { const r = await searxng(sx, q, n); if (r.length) return r; } catch { /* fall back */ } }
  return duckduckgo(q, n);
}

/** Search results formatted as context for a prompt (empty string when nothing came back). */
async function forPrompt(text) {
  const q = String(text || '').replace(/\s+/g, ' ').replace(/^.*?(find|research|audit)\s+/i, '').slice(0, 200);
  if (q.length < 4) return '';
  const r = await search(q, 8);
  if (!r.length) return '';
  return `WEB SEARCH RESULTS (searched just now for "${q}"; use them, and only trust what they actually say):\n${r.map((x, i) => `${i + 1}. ${x.title} — ${x.url}\n   ${x.snippet}`).join('\n')}`;
}

module.exports = { search, forPrompt };
