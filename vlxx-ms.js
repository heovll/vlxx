const BASE_URL = (process.env.VLXX_BASE_URL || 'https://vlxx.phd').replace(/\/$/, '');
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 10004}`).replace(/\/$/, '');
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36';
const CACHE_TTL = 5 * 60 * 1000;
const DETAIL_TTL = 10 * 60 * 1000;
const listCache = new Map();
const detailCache = new Map();

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}
function absoluteUrl(value, base = BASE_URL) {
  if (!value) return '';
  try { return new URL(String(value).replace(/&amp;/g, '&'), base).href; } catch { return ''; }
}
function relativePath(value) {
  const absolute = absoluteUrl(value);
  if (!absolute) return '';
  const url = new URL(absolute);
  return `${url.pathname}${url.search}`;
}
function cacheGet(map, key, ttl) {
  const item = map.get(key);
  return item && Date.now() - item.time < ttl ? item.value : null;
}
function cacheSet(map, key, value) {
  map.set(key, { time: Date.now(), value });
  return value;
}
function mergeCookies(existing, response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') || '').split(/,(?=[^;,=]+=[^;,]+)/);
  const jar = new Map(String(existing || '').split('; ').filter(Boolean).map(pair => pair.split('=')));
  for (const value of values || []) {
    const pair = String(value).split(';', 1)[0];
    const at = pair.indexOf('=');
    if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}
async function fetchResponse(url, options = {}, cookie = '') {
  const headers = {
    Accept: '*/*',
    'User-Agent': DEFAULT_UA,
    Referer: BASE_URL + '/',
    ...options.headers
  };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(url, {
    redirect: 'follow',
    ...options,
    headers,
    signal: options.signal || AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`VLXX HTTP ${response.status} ${url}`);
  return response;
}
async function fetchHtml(url) {
  const response = await fetchResponse(url, {
    headers: { Accept: 'text/html,application/xhtml+xml' }
  });
  return response.text();
}
function proxyImage(url) {
  return url ? `${PUBLIC_URL}/image?url=${encodeURIComponent(url)}` : undefined;
}
function listUrl(path, page = 1) {
  const safePage = Math.max(1, Number(page) || 1);
  if (!path || path === '/') return safePage === 1 ? `${BASE_URL}/` : `${BASE_URL}/new/${safePage}/`;
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return safePage === 1 ? `${BASE_URL}${normalized}` : `${BASE_URL}${normalized.replace(/\/$/, '')}/${safePage}/`;
}
export const CATALOGS = [
  { id: 'vlxxms-home', name: 'VLXX ms • Phim mới', path: '/' },
  { id: 'vlxxms-jav', name: 'VLXX ms • JAV', path: '/jav/' },
  { id: 'vlxxms-phim-sex-hay', name: 'VLXX ms • Phim sex hay', path: '/phim-sex-hay/' },
  { id: 'vlxxms-vietsub', name: 'VLXX ms • Vietsub', path: '/vietsub/' },
  { id: 'vlxxms-khong-che', name: 'VLXX ms • Không che', path: '/khong-che/' },
  { id: 'vlxxms-hoc-sinh', name: 'VLXX ms • Học sinh', path: '/hoc-sinh/' },
  { id: 'vlxxms-vung-trom', name: 'VLXX ms • Vụng trộm', path: '/vung-trom/' },
  { id: 'vlxxms-cap-3', name: 'VLXX ms • Cấp 3', path: '/cap-3/' },
  { id: 'vlxxms-chau-au', name: 'VLXX ms • Châu Âu', path: '/chau-au/' },
  { id: 'vlxxms-xvideos', name: 'VLXX ms • XVIDEOS', path: '/xvideos/' },
  { id: 'vlxxms-xnxx', name: 'VLXX ms • XNXX', path: '/xnxx/' },
  { id: 'vlxxms-xxx', name: 'VLXX ms • XXX', path: '/xxx/' }
];
function parsePagination(html) {
  const values = [...String(html).matchAll(/data-page=["'](\d+)["']/gi)].map(match => Number(match[1]));
  const current = Number(String(html).match(/active[^>]*data-page=["'](\d+)["']/i)?.[1] || 1);
  return { currentPage: current, totalPages: Math.max(1, current, ...values) };
}
export function parseListResponse(html) {
  const items = [];
  const seen = new Set();
  const blocks = String(html || '').split('class="video-item"');
  for (let index = 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    const href = block.match(/href=["']([^"']+)["']/i)?.[1] || '';
    const path = relativePath(href);
    if (!path || !/\/video\//i.test(path) || seen.has(path)) continue;
    const title = cleanText(block.match(/title=["']([^"']+)["']/i)?.[1] || '');
    const dataOriginal = block.match(/data-original=["']([^"']+)["']/i)?.[1] || '';
    const src = block.match(/<img[^>]*src=["']([^"']+)["']/i)?.[1] || '';
    const poster = absoluteUrl(dataOriginal || (src.startsWith('data:') ? '' : src));
    if (!title) continue;
    items.push({
      id: `vlxxms:${encodeURIComponent(path)}`,
      type: 'movie',
      name: title,
      poster: proxyImage(poster),
      posterShape: 'landscape',
      description: '',
      genres: ['VLXX ms'],
      sourcePath: path
    });
    seen.add(path);
  }
  return { metas: items, pagination: parsePagination(html) };
}
export async function scrapeCatalog({ path = '/', page = 1 } = {}) {
  const url = listUrl(path, page);
  const cached = cacheGet(listCache, url, CACHE_TTL);
  if (cached) return cached;
  const result = parseListResponse(await fetchHtml(url));
  return cacheSet(listCache, url, result);
}
function detailUrlFromId(id) {
  const raw = String(id || '').replace(/^vlxxms:/i, '');
  return absoluteUrl(decodeURIComponent(raw));
}
function fieldText(html, className) {
  const match = String(html).match(new RegExp(`<[^>]+class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i'));
  return match ? cleanText(match[1]) : '';
}
function extractLinkList(html, className) {
  const scope = html.match(new RegExp(`<[^>]+class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<\\/div>`, 'i'))?.[1] || '';
  return [...scope.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map(match => cleanText(match[1])).filter(Boolean);
}
function canonicalUrl(html, fallback) {
  const value = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1]
    || html.match(/property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1];
  return absoluteUrl(value || fallback);
}
function parseServerButtons(html) {
  return [...String(html).matchAll(/onclick=["']server\((\d+),\s*(\d+)\)["']/gi)].map(match => ({ serverId: match[1], dataId: match[2] }));
}
export function parseMovieDetail(html, fallbackUrl) {
  const title = cleanText(html.match(/<h[12][^>]*class=["'][^"']*page-title[^"']*["'][^>]*>([\s\S]*?)<\/h[12]>/i)?.[1]
    || html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] || 'VLXX ms');
  const poster = absoluteUrl(html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] || '');
  const pageUrl = canonicalUrl(html, fallbackUrl);
  const code = fieldText(html, 'video-code');
  const description = fieldText(html, 'video-description');
  const casts = extractLinkList(html, 'actress-tag');
  const categories = extractLinkList(html, 'category-tag');
  const servers = parseServerButtons(html);
  const selected = servers.length ? servers : [{ serverId: '1', dataId: html.match(/data-id=["'](\d+)["']/i)?.[1] || '' }];
  const videos = selected.map((server, index) => ({
    id: `vlxxms:episode:${encodeURIComponent(pageUrl)}:s${server.serverId}`,
    title: `Full • Server #${server.serverId}`,
    season: 1,
    episode: index + 1,
    available: true,
    overview: code ? `Code: ${code}` : undefined
  }));
  return {
    id: `vlxxms:${encodeURIComponent(relativePath(pageUrl))}`,
    type: 'movie',
    name: code ? `(${code}) ${title}` : title,
    poster: proxyImage(poster),
    posterShape: 'landscape',
    description,
    genres: categories,
    cast: casts,
    videos,
    extra: { code, pageUrl, serverCount: selected.length }
  };
}
export async function scrapeMeta(id) {
  const pageUrl = detailUrlFromId(id);
  const cached = cacheGet(detailCache, pageUrl, DETAIL_TTL);
  if (cached) return cached;
  return cacheSet(detailCache, pageUrl, parseMovieDetail(await fetchHtml(pageUrl), pageUrl));
}
function parseEmbedSource(text, url) {
  let sourceHtml = String(text || '');
  try {
    const json = JSON.parse(sourceHtml);
    if (json?.player) sourceHtml = json.player;
  } catch {}
  const iframe = sourceHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];
  if (iframe) return { embedUrl: absoluteUrl(iframe, url), sourceUrl: '' };
  const file = sourceHtml.match(/"file"\s*:\s*"(https?[^"\\]+(?:\.vl|\.m3u8|\.mp4)[^"\\]*)"/i)?.[1]
    || sourceHtml.match(/(?:sources|file)[^\n]{0,300}(https?:\/\/[^"'\s\\]+(?:\.vl|\.m3u8|\.mp4)[^"'\s\\]*)/i)?.[1]
    || sourceHtml.match(/https?:\/\/[^"'\s\\]+\.vl[^"'\s\\]*/i)?.[0]
    || sourceHtml.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i)?.[0];
  return { embedUrl: '', sourceUrl: file ? absoluteUrl(file, url) : '' };
}
export async function resolveStream(videoId) {
  const match = String(videoId || '').match(/^vlxxms:episode:(.+):s(\d+)$/i);
  if (!match) throw new Error('Invalid VLXX ms episode ID');
  const pageUrl = absoluteUrl(decodeURIComponent(match[1]));
  const serverId = match[2];
  const detailResponse = await fetchResponse(pageUrl, { headers: { Accept: 'text/html,application/xhtml+xml' } });
  let cookie = mergeCookies('', detailResponse);
  const detailHtml = await detailResponse.text();
  const dataId = detailHtml.match(/data-id=["'](\d+)["']/i)?.[1] || pageUrl.match(/\/(\d+)\/?$/)?.[1];
  if (!dataId) throw new Error('VLXX ms data-id not found');
  const deviceType = detailHtml.match(/deviceType\s*=\s*["'](\w+)["']/i)?.[1] || 'desktop';
  const vlxxServer = deviceType.toLowerCase() === 'desktop' ? '1' : '2';
  const ajaxResponse = await fetchResponse(`${BASE_URL}/ajax.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: pageUrl,
      Origin: BASE_URL
    },
    body: new URLSearchParams({ vlxx_server: vlxxServer, id: dataId, server: serverId }).toString()
  }, cookie);
  cookie = mergeCookies(cookie, ajaxResponse);
  const ajaxText = await ajaxResponse.text();
  const parsedAjax = parseEmbedSource(ajaxText, `${BASE_URL}/ajax.php`);
  if (parsedAjax.sourceUrl) return { url: parsedAjax.sourceUrl, referer: pageUrl, origin: BASE_URL, cookie };
  if (!parsedAjax.embedUrl) throw new Error('VLXX ms AJAX response did not expose iframe');
  const embedResponse = await fetchResponse(parsedAjax.embedUrl, {
    headers: { Referer: pageUrl, Origin: BASE_URL }
  }, cookie);
  cookie = mergeCookies(cookie, embedResponse);
  const embedText = await embedResponse.text();
  const parsedEmbed = parseEmbedSource(embedText, parsedAjax.embedUrl);
  if (!parsedEmbed.sourceUrl) throw new Error('VLXX ms embed did not expose HLS source');
  return {
    url: parsedEmbed.sourceUrl,
    referer: parsedAjax.embedUrl,
    origin: new URL(parsedAjax.embedUrl).origin,
    cookie
  };
}
export { cleanText, listUrl, parseEmbedSource };
