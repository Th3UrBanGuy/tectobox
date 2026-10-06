// Website → Knowledge importer (dependency-free).
// Given a business website URL: discovers pages via robots.txt + sitemap(s)
// (falls back to a same-origin BFS crawl), extracts clean readable text per
// page (readability-style), pulls structured Q&A / product data from JSON-LD,
// auto-categorizes, and upserts into the knowledge table (one row per source
// URL, so re-syncs update instead of duplicating).
//
// Safety: every fetched URL is SSRF-guarded — only http(s), the hostname must
// resolve to public IP space (no loopback / private / link-local / metadata),
// every redirect hop is re-validated, responses are capped at 3 MB.
const db = require('./db');
const net = require('net');
const crypto = require('crypto');

const FETCH_TIMEOUT_MS = 15000;
const MAX_PAGES = 50;
const MAX_CHARS_PER_PAGE = 6000;
const MAX_BYTES_PER_PAGE = 3 * 1024 * 1024;
const CONCURRENCY = 3;
const UA = 'TectonicBot/1.0 (+https://ss.kalandar.me) website-knowledge-importer';

// ---------------- SSRF guard ----------------
function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    const n = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
    const v = (a, b, c, d) => (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
    const inRange = (base, bits) => (n >>> (32 - bits)) === (base >>> (32 - bits));
    // loopback, private, link-local, carrier NAT, "this network", multicast/reserved
    if (inRange(v(127, 0, 0, 0), 8)) return false;
    if (inRange(v(10, 0, 0, 0), 8)) return false;
    if (inRange(v(172, 16, 0, 0), 12)) return false;
    if (inRange(v(192, 168, 0, 0), 16)) return false;
    if (inRange(v(169, 254, 0, 0), 16)) return false;
    if (inRange(v(100, 64, 0, 0), 10)) return false;
    if (inRange(v(198, 18, 0, 0), 15)) return false; // benchmarking / CGNAT-adjacent
    if (inRange(v(192, 0, 2, 0), 24)) return false; // TEST-NET-1 (documentation)
    if (inRange(v(198, 51, 100, 0), 24)) return false; // TEST-NET-2
    if (inRange(v(203, 0, 113, 0), 24)) return false; // TEST-NET-3
    if (inRange(v(0, 0, 0, 0), 8)) return false;
    if (n >= v(224, 0, 0, 0)) return false; // multicast + reserved
    return true;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return false;
    if (low.startsWith('fe80:')) return false; // link-local
    if (low.startsWith('fc') || low.startsWith('fd')) return false; // unique-local
    if (low.startsWith('ff')) return false; // multicast
    // IPv4-mapped IPv6 (::ffff:127.0.0.1) — check the embedded IPv4
    const m = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPublicIp(m[1]);
    return true;
  }
  return false;
}

async function assertPublicUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('bad url'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad protocol');
  // Tests only: allow loopback fixtures with CRAWLER_ALLOW_PRIVATE=1.
  if (process.env.CRAWLER_ALLOW_PRIVATE === '1') return u;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('non-public host');
  // Literal IP: check directly, no DNS involved.
  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new Error('non-public host');
    return u;
  }
  // Domain name: resolve the REAL address via DNS-over-HTTPS. Local DNS in
  // proxied/sandboxed environments is intercepted (returns fake 198.18.0.0/15
  // for every external domain), so dns.lookup() cannot be trusted here.
  // DoH goes through the same egress proxy the fetch itself will use.
  const ips = await dohResolve(host);
  if (!ips || !ips.length) throw new Error('dns failed');
  if (!ips.every(isPublicIp)) throw new Error('non-public host');
  return u;
}

// Egress proxy dispatcher for undici fetch (same egress as src/connectors.js).
// Direct TCP to the internet is blocked from here; external fetches must go
// through the proxy. Cached per process.
let _dispatcher = false; // false = not tried yet, null = no proxy/unavailable
function proxyDispatcher() {
  if (_dispatcher !== false) return _dispatcher;
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY;
  if (!proxyUrl) { _dispatcher = null; return null; }
  try {
    const { ProxyAgent } = require('undici');
    _dispatcher = new ProxyAgent(proxyUrl);
  } catch { _dispatcher = null; }
  return _dispatcher;
}
function fetchOpts(extra = {}, url = '') {
  // Never proxy loopback / private-literal / localhost targets: the egress
  // proxy cannot reach them (and local fixture servers live here).
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost')) return extra;
    if (net.isIP(h) && !isPublicIp(h)) return extra;
  } catch {}
  const d = proxyDispatcher();
  return d ? { ...extra, dispatcher: d } : extra;
}

async function dohQuery(dohUrl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(dohUrl, fetchOpts({
      signal: ctrl.signal,
      headers: { 'Accept': 'application/dns-json', 'User-Agent': UA },
    }));
    if (!res.ok) return null;
    const j = await res.json();
    const ips = (j.Answer || [])
      .filter(a => (a.type === 1 || a.type === 28) && typeof a.data === 'string')
      .map(a => a.data);
    return ips.length ? ips : null;
  } catch { return null; }
  finally { clearTimeout(t); }
}

async function dohResolve(hostname) {
  const n = encodeURIComponent(hostname);
  return await dohQuery(`https://cloudflare-dns.com/dns-query?name=${n}&type=A`)
      || await dohQuery(`https://dns.google/resolve?name=${n}&type=A`);
}

async function fetchHtml(url, maxRedirects = 5) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    try { await assertPublicUrl(current); } catch { return null; }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, fetchOpts({
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        redirect: 'manual',
      }, current));
    } catch { clearTimeout(t); return null; }
    clearTimeout(t);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      try { await res.arrayBuffer(); } catch {}
      if (!loc) return null;
      try { current = new URL(loc, current).toString(); } catch { return null; }
      continue;
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || !(ct.includes('html') || ct.includes('xml'))) { try { await res.arrayBuffer(); } catch {} return null; }
    let buf;
    try { buf = Buffer.from(await res.arrayBuffer()); } catch { return null; }
    if (buf.length > MAX_BYTES_PER_PAGE) return null;
    return { html: buf.toString('utf8'), finalUrl: current };
  }
  return null;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } });
}

// ---------------- Readability-style text extraction ----------------
function stripChromeByAttr(h) {
  // Drop elements whose class or id looks like page chrome (nav, ads, …).
  // Runs a few passes for nested chrome.
  let prev;
  let out = h;
  for (let i = 0; i < 4; i++) {
    prev = out;
    out = out.replace(
      /<([a-z][a-z0-9]*)[^>]*\s(?:class|id)=["'][^"']*?(?:nav|menu|sidebar|footer|header|banner|breadcrumb|ad[s]?[-_]|promo|popup|modal|cookie|social|share|comment|widget|subscribe|newsletter|search|login|cart)[^"']*?["'][^>]*>[\s\S]*?<\/\1\s*>/gi,
      ' '
    );
    if (out === prev) break;
  }
  return out;
}

function textOf(htmlFragment) {
  return decodeEntities(htmlFragment.replace(/<[^>]+>/g, ' '))
    .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim())
    .filter(l => l.length > 1).join('\n');
}

// Extract the readable article text from raw HTML (no deps).
// ---------------- Universal hydration-data extractors ----------------
// Every major JS framework embeds its server state in the HTML for hydration.
// Extracting that state gives us the page's real content without a browser.
// Tried in order (cheapest first); the first one yielding real text wins.

function jsonTextOf(obj, depth, seen) {
  // Recursively pull human-readable strings out of a hydration JSON blob.
  if (depth > 6 || obj == null) return [];
  if (seen.has(obj)) return [];
  if (typeof obj === 'string') {
    const t = obj.replace(/\s+/g, ' ').trim();
    if (t.length < 25 || t.split(' ').length < 4) return [];
    if (/^https?:\/\/\S+$/.test(t)) return [];
    // Skip hash-like IDs: long, no spaces, mixed case+digits (but keep real titles).
    const nospace = t.replace(/\s/g, '');
    if (nospace.length >= 30 && !/\s/.test(t) && /[a-z]/.test(nospace) && /[A-Z0-9]/.test(nospace) && !/[aeiou]/i.test(nospace)) return [];
    return [t];
  }
  if (typeof obj !== 'object') return [];
  seen.add(obj);
  const out = [];
  const vals = Array.isArray(obj) ? obj : Object.values(obj);
  for (const v of vals) {
    // Skip obvious non-content keys at the top level only (handled by caller slice).
    out.push(...jsonTextOf(v, depth + 1, seen));
    if (out.length > 400) break;
  }
  return out;
}
function dedupeLines(lines) {
  const seen = new Set(), uniq = [];
  for (const l of lines) { const t = l.trim(); if (t && !seen.has(t)) { seen.add(t); uniq.push(t); } }
  return uniq;
}

// 1. Next.js Pages Router: <script id="__NEXT_DATA__" type="application/json">
function extractNextDataJson(html) {
  const m = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script\s*>/i);
  if (!m) return '';
  try {
    const data = JSON.parse(m[1]);
    const pp = (data.props && data.props.pageProps) || {};
    const lines = dedupeLines(jsonTextOf(pp, 0, new Set()));
    return lines.join('\n').slice(0, MAX_CHARS_PER_PAGE);
  } catch { return ''; }
}

// 2. Nuxt 2: <script>window.__NUXT__={...}</script>  |  Nuxt 3: <script id="__NUXT_DATA__">
function extractNuxtState(html) {
  let m = html.match(/<script[^>]+id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script\s*>/i);
  if (m) {
    try {
      const lines = dedupeLines(jsonTextOf(JSON.parse(m[1]), 0, new Set()));
      return lines.join('\n').slice(0, MAX_CHARS_PER_PAGE);
    } catch {}
  }
  const n2start = html.search(/window\.__NUXT__\s*=\s*\{/);
  if (n2start >= 0) {
    const openIdx = html.indexOf('{', n2start);
    let depth = 0, inStr = false, esc = false, endIdx = -1;
    for (let i = openIdx; i < html.length && i < openIdx + 200000; i++) {
      const ch = html[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    if (endIdx > 0) {
      try {
        const data = JSON.parse(html.slice(openIdx, endIdx + 1).replace(/!0/g, 'true').replace(/!1/g, 'false').replace(/:undefined/g, ':null'));
        const payload = data.data || data;
        const lines = dedupeLines(jsonTextOf(payload, 0, new Set()));
        return lines.join('\n').slice(0, MAX_CHARS_PER_PAGE);
      } catch {}
    }
  }
  return '';
}

// 3. SvelteKit: <script type="application/json" sveltekit:data-type="data">…
function extractSvelteKitData(html) {
  const re = /<script[^>]+type=["']application\/json["'][^>]*sveltekit:data-type=["']data["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  const all = [];
  let m;
  while ((m = re.exec(html)) && all.length < 10) {
    try {
      const data = JSON.parse(m[1]);
      const body = data.body ? (typeof data.body === 'string' ? JSON.parse(data.body) : data.body) : data;
      all.push(...jsonTextOf(body, 0, new Set()));
    } catch {}
  }
  if (!all.length) return '';
  return dedupeLines(all).join('\n').slice(0, MAX_CHARS_PER_PAGE);
}

// 4. Angular Universal: <script id="ng-state" type="application/json">
function extractAngularState(html) {
  const m = html.match(/<script[^>]+id=["']ng-state["'][^>]*>([\s\S]*?)<\/script\s*>/i);
  if (!m) return '';
  try {
    const lines = dedupeLines(jsonTextOf(JSON.parse(m[1]), 0, new Set()));
    return lines.join('\n').slice(0, MAX_CHARS_PER_PAGE);
  } catch { return ''; }
}

// 5. Remix: window.__remixContext = {...} (bracket-counted, handles nesting)
function extractRemixContext(html) {
  const start = html.search(/window\.__remixContext\s*=\s*\{/);
  if (start < 0) return '';
  const openIdx = html.indexOf('{', start);
  let depth = 0, inStr = false, esc = false;
  for (let i = openIdx; i < html.length && i < openIdx + 200000; i++) {
    const ch = html[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) {
      try {
        const data = JSON.parse(html.slice(openIdx, i + 1));
        const loaderData = data.state ? data.state.loaderData : data.loaderData;
        const lines = dedupeLines(jsonTextOf(loaderData || data, 0, new Set()));
        return lines.join('\n').slice(0, MAX_CHARS_PER_PAGE);
      } catch { return ''; }
    }}
  }
  return '';
}

// 6. Gatsby: /page-data{path}/page-data.json → result.data + result.pageContext
async function extractGatsbyPageData(origin, pagePath, fetchJson) {
  try {
    const p = pagePath.endsWith('/') ? pagePath.slice(0, -1) : pagePath;
    const url = origin + '/page-data' + (p || '/index') + '/page-data.json';
    const data = await fetchJson(url);
    if (!data || !data.result) return '';
    const lines = dedupeLines(jsonTextOf(data.result, 0, new Set()));
    return lines.join('\n').slice(0, MAX_CHARS_PER_PAGE);
  } catch { return ''; }
}

// 7. SvelteKit __data.json endpoint: {url}/__data.json
async function extractSvelteKitEndpoint(origin, pagePath, fetchJson) {
  try {
    const url = origin + pagePath + (pagePath.endsWith('/') ? '__data.json' : '/__data.json');
    const data = await fetchJson(url);
    if (!data) return '';
    const lines = dedupeLines(jsonTextOf(data, 0, new Set()));
    return lines.join('\n').slice(0, MAX_CHARS_PER_PAGE);
  } catch { return ''; }
}

// 8. WordPress REST API: {origin}/wp-json/wp/v2 — catches WP sites whose theme
// renders thin HTML but exposes full content via REST.
async function extractWordPressApi(origin, pagePath, fetchJson) {
  try {
    // Try to find the matching post/page via search, then fetch full content.
    const probe = await fetchJson(origin + '/wp-json/');
    if (!probe || !probe.namespaces) return '';
    // Get post types and search for relevant content.
    const types = await fetchJson(origin + '/wp-json/wp/v2/types');
    if (!types) return '';
    const all = [];
    for (const [slug, t] of Object.entries(types)) {
      if (!t.rest_base || slug === 'attachment') continue;
      try {
        const items = await fetchJson(origin + `/wp-json/wp/v2/${t.rest_base}?per_page=5&_fields=title,content,excerpt`);
        if (Array.isArray(items)) {
          for (const it of items) {
            const title = (it.title && it.title.rendered) || '';
            const content = (it.content && it.content.rendered) || (it.excerpt && it.excerpt.rendered) || '';
            const clean = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (title && clean.length > 100) all.push(title.replace(/<[^>]+>/g, '') + '\n' + clean);
            if (all.length > 20) break;
          }
        }
      } catch {}
      if (all.length > 20) break;
    }
    if (!all.length) return '';
    return dedupeLines(all.flatMap(t => jsonTextOf(t, 0, new Set()))).join('\n\n').slice(0, MAX_CHARS_PER_PAGE);
  } catch { return ''; }
}

// Master fallback: try every hydration mechanism, first real text wins.
async function extractHydrationText(html, origin, pagePath, fetchJson) {
  const tries = [
    () => extractNextDataJson(html),
    () => extractNextFlightText(html),
    () => extractNuxtState(html),
    () => extractSvelteKitData(html),
    () => extractAngularState(html),
    () => extractRemixContext(html),
  ];
  for (const fn of tries) {
    try {
      const t = fn();
      if (t && t.replace(/\s/g, '').length >= 200) return t;
    } catch {}
  }
  // Network-based fallbacks (Gatsby page-data, SvelteKit __data.json, WordPress API).
  if (fetchJson && origin) {
    for (const fn of [extractGatsbyPageData, extractSvelteKitEndpoint, extractWordPressApi]) {
      try {
        const t = await fn(origin, pagePath || '/', fetchJson);
        if (t && t.replace(/\s/g, '').length >= 200) return t;
      } catch {}
    }
  }
  return '';
}

// Detect "template shell" — hydration data that looks like enough text but is
// mostly site-wide boilerplate (taglines, SEO junk, nav). These pages need the
// real browser renderer to get their actual content (client-side API data).
function isTemplateShell(text, html) {
  if (!text) return true;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.replace(/\s/g, '').length < 200) return true;
  // SEO meta junk leaking into text = extraction grabbed shell, not content.
  if (/max-video-preview|max-image-preview|max-snippet/i.test(t)) return true;
  // Boilerplate ratio: site tagline/description repeated = shell.
  const words = t.toLowerCase().split(/\s+/);
  const uniq = new Set(words);
  const uniqRatio = uniq.size / Math.max(1, words.length);
  // Real content has diverse vocabulary; shells repeat the same phrases.
  if (words.length > 40 && uniqRatio < 0.45) return true;
  // Very short + generic = shell (detail pages should have substance).
  if (t.length < 600) {
    const genericPhrases = (t.match(/modern enterprise platform|architecting tomorrow|showcasing software/gi) || []).length;
    if (genericPhrases >= 2) return true;
  }
  return false;
}

// Next.js App Router embeds rendered page content as React Flight data in
// self.__next_f.push() script payloads. Plain HTML extraction sees almost nothing
// on such sites, so extract readable text from the flight payloads as a fallback.
function extractNextFlightText(html) {
  if (!html || !html.includes('__next_f')) return '';
  const out = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let m;
  while ((m = re.exec(html)) && out.length < 200) {
    let s;
    try { s = JSON.parse(m[1]); } catch { continue; }
    // Flight payload: pull human-readable fragments, skip code/identifiers.
    const frags = s.match(/[A-Za-z][A-Za-z0-9][^"\\<>{}]{18,400}/g) || [];
    for (const f of frags) {
      const t = f.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
      // Skip JS/CSS noise: font filenames, URLs, code identifiers, statements.
      if (/\.woff2?$|\.ttf$|googletagmanager|dangerouslySet|localStorage|prefers-color|classList|__next|_next\/static|dataLayer|gtag\(|document\.|window\.|var\s+\w+\s*=|function\s*\(|=>|;\s*$/i.test(t)) continue;
      if (/^[a-z0-9\-_]{20,}$/i.test(t.replace(/\s/g, ''))) continue;
      if (t.split(' ').length < 3) continue;
      // Must look like prose: mostly letters/spaces/punctuation, not code symbols.
      const syms = (t.match(/[=;{}()$]/g) || []).length;
      if (syms > 2) continue;
      out.push(t);
    }
  }
  // Dedupe while preserving order.
  const seen = new Set(), uniq = [];
  for (const t of out) { if (!seen.has(t)) { seen.add(t); uniq.push(t); } }
  return uniq.join('\n').slice(0, MAX_CHARS_PER_PAGE);
}

function extractMainText(html) {
  if (!html) return '';
  let h = String(html);
  h = h.replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/<script[\s\S]*?<\/script\s*>/gi, ' ');
  h = h.replace(/<style[\s\S]*?<\/style\s*>/gi, ' ');
  h = h.replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, ' ');
  h = stripChromeByAttr(h);
  // Drop structural boilerplate containers.
  h = h.replace(/<(nav|footer|header|aside|form|iframe|canvas|svg|figure|figcaption)[\s\S]*?<\/\1\s*>/gi, ' ');
  // Prefer the main content landmark when it actually holds text.
  const landmarks = [];
  const lmRe = /<(main|article)[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let lm;
  while ((lm = lmRe.exec(h)) && landmarks.length < 6) landmarks.push(lm[2]);
  let best = null, bestLen = 0;
  for (const frag of landmarks) {
    const t = textOf(frag);
    if (t.length > bestLen) { bestLen = t.length; best = t; }
  }
  let text;
  if (best && bestLen > 300) {
    text = best;
  } else {
    const body = h.match(/<body[^>]*>([\s\S]*?)<\/body\s*>/i);
    text = textOf(body ? body[1] : h);
  }
  // Drop leftover junk lines (single-word nav crumbs, lone punctuation).
  const lines = text.split('\n').filter(l => {
    const w = l.split(/\s+/).length;
    return w >= 2 || l.length > 40;
  });
  return lines.join('\n').slice(0, MAX_CHARS_PER_PAGE);
}

// ---------------- Structured data (JSON-LD) ----------------
function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const it of items) {
        const g = it && it['@graph'];
        const arr = Array.isArray(g) ? g : [it];
        for (const node of arr) {
          if (node && typeof node === 'object' && node['@type']) out.push(node);
        }
      }
    } catch { /* malformed JSON-LD — ignore */ }
  }
  return out;
}

function plainText(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(plainText).filter(Boolean).join(' ');
  if (typeof v === 'object') return plainText(v.name || v.text || v.description || '');
  return String(v);
}

// Turn JSON-LD nodes into KB-ready entries: { title, content, category, suffix }
function jsonLdEntries(nodes) {
  const entries = [];
  for (const n of nodes) {
    const types = Array.isArray(n['@type']) ? n['@type'] : [n['@type']];
    const t = types.map(String).join(',').toLowerCase();
    if (t.includes('faqpage')) {
      const qs = n.mainEntity || [];
      const list = Array.isArray(qs) ? qs : [qs];
      list.forEach((q, i) => {
        const question = plainText(q.name).trim();
        const answer = plainText(q.acceptedAnswer).trim();
        if (question && answer) {
          entries.push({
            title: question.slice(0, 140),
            content: `Q: ${question}\nA: ${answer}`.slice(0, MAX_CHARS_PER_PAGE),
            category: 'faq',
            suffix: `#faq-${i + 1}`,
          });
        }
      });
    } else if (t.includes('product')) {
      const name = plainText(n.name).trim();
      const desc = plainText(n.description).trim();
      const offers = n.offers && (Array.isArray(n.offers) ? n.offers[0] : n.offers);
      const price = offers ? plainText(offers.price) : '';
      const currency = offers ? plainText(offers.priceCurrency) : '';
      if (name && (desc || price)) {
        entries.push({
          title: name.slice(0, 140),
          content: [name, desc, price ? `Price: ${price} ${currency}`.trim() : ''].filter(Boolean).join('\n').slice(0, MAX_CHARS_PER_PAGE),
          category: 'product',
          suffix: '#product',
        });
      }
    } else if (t.includes('organization') || t.includes('localbusiness')) {
      const name = plainText(n.name).trim();
      const desc = plainText(n.description).trim();
      if (name && desc) {
        entries.push({
          title: `About ${name}`.slice(0, 140),
          content: desc.slice(0, MAX_CHARS_PER_PAGE),
          category: 'general',
          suffix: '#about',
        });
      }
    }
  }
  return entries;
}

function extractSameOriginLinks(html, base) {
  const out = new Set();
  const baseU = new URL(base);
  const re = /<a[^>]+href=["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.size < MAX_PAGES * 2) {
    try {
      const u = new URL(m[1], base);
      if (u.origin !== baseU.origin) continue;
      u.hash = '';
      const s = u.toString();
      if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|css|js|ico|woff2?)(\?|$)/i.test(s)) continue;
      out.add(s);
    } catch { /* skip bad hrefs */ }
  }
  return [...out];
}

function sitemapUrls(xml) {
  const urls = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) && urls.length < MAX_PAGES) urls.push(m[1].trim());
  return urls;
}

function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml);
}

// Recursively collect page URLs from a sitemap (handles sitemap indexes).
async function collectSitemapUrls(smUrl, origin, seen, depth = 0) {
  const out = [];
  if (depth > 2 || seen.has(smUrl)) return out;
  seen.add(smUrl);
  const r = await fetchHtml(smUrl);
  if (!r || !r.html.includes('<loc>')) return out;
  const locs = sitemapUrls(r.html).filter(u => {
    try { return new URL(u, smUrl).origin === origin; } catch { return false; }
  });
  if (isSitemapIndex(r.html)) {
    for (const child of locs.slice(0, 5)) {
      if (out.length >= MAX_PAGES) break;
      out.push(...await collectSitemapUrls(child, origin, seen, depth + 1));
    }
    return out.slice(0, MAX_PAGES);
  }
  return locs.slice(0, MAX_PAGES);
}

async function readRobots(origin) {
  // { sitemaps: [], disallow: [] } — disallow merged: a bot-specific group wins
  // over the wildcard group when present.
  const out = { sitemaps: [], disallow: [] };
  const r = await fetchHtml(origin + '/robots.txt');
  if (!r) return out;
  const star = [], bot = [];
  let group = null; // 'star' | 'bot' | 'other'
  for (const raw of r.html.split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase(), value = m[2].trim();
    if (field === 'user-agent') {
      const ua = value.toLowerCase();
      group = ua === '*' ? 'star' : (ua.includes('tectonicbot') ? 'bot' : 'other');
    } else if (field === 'sitemap' && value) {
      out.sitemaps.push(value);
    } else if (field === 'disallow' && value && (group === 'star' || group === 'bot')) {
      (group === 'bot' ? bot : star).push(value);
    }
  }
  out.disallow = bot.length ? bot : star;
  return out;
}

function isDisallowed(pathname, disallows) {
  return (disallows || []).some(d => d === '/' || (d && pathname.startsWith(d)));
}

function categorizeByUrl(url) {
  const u = url.toLowerCase();
  if (/(ship|deliver)/.test(u)) return 'shipping';
  if (/(return|refund|exchange|terms|privacy|policy)/.test(u)) return 'policy';
  if (/(faq|help|support|question)/.test(u)) return 'faq';
  if (/(product|shop|collection|category|item)/.test(u)) return 'product';
  if (/(offer|sale|discount|promo|campaign)/.test(u)) return 'marketing';
  return 'general';
}

function pageTitle(html, url) {
  const m = String(html).match(/<title[^>]*>([^<]{1,160})<\/title>/i);
  if (m) return decodeEntities(m[1]).trim();
  try { return new URL(url).pathname.replace(/[/_-]+/g, ' ').trim() || url; }
  catch { return url; }
}

function canonicalUrl(html, pageUrl) {
  const m = String(html).match(/<link[^>]+rel=["']canonical["'][^>]*>/i);
  if (!m) return pageUrl;
  const hm = m[0].match(/href=["']([^"']+)["']/i);
  if (!hm) return pageUrl;
  try {
    const u = new URL(hm[1], pageUrl);
    const base = new URL(pageUrl);
    if (u.origin !== base.origin) return pageUrl;
    u.hash = '';
    return u.toString();
  } catch { return pageUrl; }
}

function metaDescription(html) {
  const m = String(html).match(/<meta[^>]+name=["']description["'][^>]*>/i);
  if (!m) return '';
  const cm = m[0].match(/content=["']([^"']{10,400})["']/i);
  return cm ? decodeEntities(cm[1]).trim() : '';
}

async function discoverPages(siteUrl) {
  let origin;
  try {
    const u = new URL(siteUrl);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad protocol');
    origin = u.origin;
  } catch { throw new Error('Invalid website URL'); }

  const robots = await readRobots(origin);

  // 1) sitemaps: robots.txt Sitemap: directives first, then the conventional paths
  const smCandidates = [...robots.sitemaps, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const seen = new Set();
  for (const sm of smCandidates) {
    try {
      const urls = (await collectSitemapUrls(sm, origin, seen))
        .filter(u => {
          try { return !isDisallowed(new URL(u).pathname, robots.disallow); } catch { return false; }
        });
      if (urls.length) return urls.slice(0, MAX_PAGES);
    } catch { /* try next candidate */ }
  }

  // 2) fallback: same-origin BFS from the homepage (depth ≤ 2)
  const home = await fetchHtml(origin + '/');
  if (!home) return [];
  const seenPages = new Set([origin + '/']);
  const queue = [{ url: origin + '/', depth: 0, html: home.html }];
  const pages = [origin + '/'];
  while (queue.length && pages.length < MAX_PAGES) {
    const { url, depth, html } = queue.shift();
    if (depth >= 2) continue;
    for (const link of extractSameOriginLinks(html, url)) {
      let path;
      try { path = new URL(link).pathname; } catch { continue; }
      if (isDisallowed(path, robots.disallow)) continue;
      if (seenPages.has(link)) continue;
      seenPages.add(link);
      pages.push(link);
      if (pages.length >= MAX_PAGES) break;
      if (depth + 1 < 2 && pages.length < MAX_PAGES) {
        const r = await fetchHtml(link);
        if (r) queue.push({ url: link, depth: depth + 1, html: r.html });
      }
    }
  }
  return pages.slice(0, MAX_PAGES);
}

function contentHash(text) {
  return crypto.createHash('sha256').update(text.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
}

async function importWebsite(clientId, siteUrl, { maxPages = MAX_PAGES, importId = null } = {}) {
  let origin;
  try {
    const u = new URL(siteUrl);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad protocol');
    origin = u.origin;
  } catch {
    throw new Error('Invalid website URL');
  }
  // SSRF guard on the seed URL itself (private hosts rejected before any fetch).
  try { await assertPublicUrl(origin + '/'); }
  catch { throw new Error('Website host is not publicly reachable'); }

  db.setClientWebsite(clientId, origin + '/');
  const robots = await readRobots(origin);
  const pages = (await discoverPages(origin)).slice(0, maxPages);
  if (importId && db.setWebsiteImportDiscovered) db.setWebsiteImportDiscovered(importId, pages.length);
  const results = { discovered: pages.length, imported: 0, skipped: 0, structured: 0, thin: [] };
  const seenHashes = new Set();
  const record = (page) => { if (importId) { try { db.addWebsiteImportPage(importId, clientId, page); } catch {} } };
  const bump = (st) => {
    if (importId && db.bumpWebsiteImportProgress) {
      try { db.bumpWebsiteImportProgress(importId, st === 'imported' ? 1 : 0, st === 'imported' ? 0 : 1); } catch {}
    }
  };

  const processPage = async (pageUrl) => {
    let path;
    try { path = new URL(pageUrl).pathname; } catch { return; }
    if (isDisallowed(path, robots.disallow)) {
      results.skipped += 1; bump('skipped');
      record({ page_url: pageUrl, page_title: pageTitle('', pageUrl), category: 'general', chars: 0, status: 'skipped_fetch', note: 'Blocked by robots.txt.' });
      return;
    }
    const r = await fetchHtml(pageUrl);
    if (!r) {
      results.skipped += 1; bump('skipped');
      record({ page_url: pageUrl, page_title: pageTitle('', pageUrl), category: 'general', chars: 0, status: 'skipped_fetch', note: 'Could not download the page (timeout, blocked, or unreachable).' });
      return;
    }
    const { html } = r;
    const sourceUrl = canonicalUrl(html, r.finalUrl);
    let text = extractMainText(html);
    let renderMethod = 'html';
    // Universal fallback: try EVERY framework's hydration data (Next.js Pages +
    // App Router, Nuxt 2/3, SvelteKit, Angular, Remix, Gatsby page-data).
    if (text.replace(/\s/g, '').length < 200) {
      const origin = (() => { try { return new URL(pageUrl).origin; } catch { return ''; } })();
      const pagePath = (() => { try { return new URL(pageUrl).pathname; } catch { return '/'; } })();
      const hydrationText = await extractHydrationText(html, origin, pagePath, async (u) => {
        const rr = await fetchHtml(u);
        if (!rr) return null;
        try { return JSON.parse(rr.html); } catch { return null; }
      });
      if (hydrationText.replace(/\s/g, '').length >= 200) { text = hydrationText; renderMethod = 'hydration'; }
    }
    // LAST RESORT: real headless Chromium. Handles pure client SPAs, Rust/WASM
    // sites, canvas-rendered pages — literally any web technology.
    // Also escalates "template shells": hydration data that passed the char
    // threshold but is mostly boilerplate (detail content loads via client APIs).
    const needsBrowser = text.replace(/\s/g, '').length < 200 || isTemplateShell(text, html);
    if (needsBrowser) {
      try {
        const br = require('./browser-render');
        const rendered = await br.renderPage(pageUrl);
        if (rendered && rendered.text.replace(/\s/g, '').length >= 200) {
          // Keep the richer of the two (browser usually wins for dynamic pages).
          const htmlScore = text.replace(/\s/g, '').length * (isTemplateShell(text, html) ? 0.3 : 1);
          if (rendered.text.replace(/\s/g, '').length > htmlScore) {
            text = rendered.text;
            renderMethod = 'browser';
          }
        }
      } catch {}
    }
    const desc = metaDescription(html);
    if (desc && text.length < 1200 && !text.toLowerCase().includes(desc.toLowerCase().slice(0, 40))) {
      text = `Summary: ${desc}\n${text}`;
    }
    if (text.replace(/\s/g, '').length < 200) {
      // Too thin — probably JS-rendered or media-only. Report, don't import junk.
      results.thin.push(pageUrl);
      results.skipped += 1; bump('skipped');
      record({ page_url: pageUrl, page_title: pageTitle(html, pageUrl), category: 'general', chars: text.length, status: 'skipped_thin', note: 'Too little readable text — likely JS-rendered or media-only.' });
      return;
    }
    const hash = contentHash(text);
    if (seenHashes.has(hash)) {
      results.skipped += 1; bump('skipped');
      record({ page_url: pageUrl, page_title: pageTitle(html, pageUrl), category: 'general', chars: text.length, status: 'skipped_duplicate', note: 'Same content as another imported page.' });
      return;
    }
    seenHashes.add(hash);
    const title = pageTitle(html, pageUrl);
    const category = categorizeByUrl(sourceUrl);
    db.upsertKnowledgeBySource(clientId, { title, content: text, category, source_url: sourceUrl });
    results.imported += 1; bump('imported');
    record({ page_url: pageUrl, page_title: title, category, chars: text.length, status: 'imported', note: renderMethod !== 'html' ? `via ${renderMethod}` : null });
    // Structured data: FAQ / product / org JSON-LD becomes first-class KB rows.
    try {
      for (const e of jsonLdEntries(extractJsonLd(html))) {
        db.upsertKnowledgeBySource(clientId, {
          title: e.title, content: e.content, category: e.category,
          source_url: sourceUrl + e.suffix,
        });
        results.structured += 1;
      }
    } catch {}
  };

  // Bounded concurrency: fast without hammering the site.
  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    await Promise.all(pages.slice(i, i + CONCURRENCY).map(processPage));
  }
  results.website = origin + '/';
  return results;
}

module.exports = {
  extractMainText, extractSameOriginLinks, sitemapUrls, categorizeByUrl,
  discoverPages, importWebsite, jsonLdEntries, extractJsonLd, isPublicIp,
  assertPublicUrl, dohResolve,
  extractNextDataJson, extractNextFlightText, extractNuxtState,
  extractSvelteKitData, extractAngularState, extractRemixContext,
  extractHydrationText,
  MAX_PAGES,
};
