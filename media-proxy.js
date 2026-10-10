import crypto from 'node:crypto';

const sessions = new Map();
const SESSION_TTL = 2 * 60 * 60 * 1000;
const FETCH_TIMEOUT = 120_000;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36';

function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function mergeSetCookies(existing, response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') || '').split(/,(?=[^;,=]+=[^;,]+)/);
  const jar = new Map(existing ? existing.split('; ').filter(Boolean).map(x => x.split('=')) : []);
  for (const value of values || []) {
    const pair = String(value).split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator > 0) jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function fetchBytes(url, { headers = {}, cookie = '', signal } = {}) {
  const requestHeaders = {
    'User-Agent': DEFAULT_UA,
    Accept: '*/*',
    ...headers
  };
  if (cookie) requestHeaders.Cookie = cookie;

  const response = await fetch(url, {
    redirect: 'follow',
    headers: requestHeaders,
    signal: signal || AbortSignal.timeout(FETCH_TIMEOUT)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { response, bytes };
}

function decodePlayerPayload(html) {
  const match = String(html).match(/data-obf=["']([^"']+)["']/i);
  if (!match) return null;
  try {
    return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function extractPlaylistUrlFromHtml(html, baseUrl) {
  const text = String(html || '')
    .replace(/\\u002F/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
  const matches = text.match(/(?:https?:)?\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]+)?/gi) || [];
  for (const value of matches) {
    try {
      const absolute = new URL(value.startsWith('//') ? `https:${value}` : value, baseUrl).href;
      if (/\.m3u8(?:[?#]|$)/i.test(absolute)) return absolute;
    } catch {}
  }
  return null;
}

function decryptPlaylist(text, keyHex) {
  const lines = String(text).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const marker = lines.find(line => line.startsWith('#ENC-AESGCM;iv='));
  if (!marker || !keyHex || !/^[0-9a-f]{64}$/i.test(keyHex)) return String(text);

  const iv = Buffer.from(marker.slice(marker.indexOf('iv=') + 3), 'base64');
  const encryptedLine = lines.find(line => !line.startsWith('#'));
  if (!encryptedLine || iv.length !== 12) throw new Error('invalid encrypted HLS playlist');

  const encrypted = Buffer.from(encryptedLine, 'base64');
  if (encrypted.length <= 16) throw new Error('encrypted HLS playlist is too short');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
  const clear = Buffer.concat([
    decipher.update(encrypted.subarray(0, encrypted.length - 16)),
    decipher.final()
  ]);
  return clear.toString('utf8');
}

function findPngEnd(bytes) {
  const marker = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  for (let i = 0; i <= bytes.length - marker.length; i += 1) {
    let found = true;
    for (let j = 0; j < marker.length; j += 1) {
      if (bytes[i + j] !== marker[j]) {
        found = false;
        break;
      }
    }
    if (found) return i + marker.length;
  }
  return -1;
}

function findTsOffset(bytes) {
  if (bytes[0] === 0x47) return 0;
  const limit = Math.min(bytes.length, 8192);
  for (let offset = 0; offset < limit; offset += 1) {
    if (bytes[offset] !== 0x47) continue;
    let good = 0;
    for (let packet = 1; packet < 8; packet += 1) {
      if (bytes[offset + packet * 188] === 0x47) good += 1;
    }
    if (good >= 4) return offset;
  }
  return -1;
}

function normalizeMediaBytes(bytes) {
  const pngEnd = findPngEnd(bytes);
  const candidate = pngEnd >= 0 ? bytes.subarray(pngEnd) : bytes;
  const offset = findTsOffset(candidate);
  if (offset < 0) return null;
  const ts = candidate.subarray(offset);
  return ts.subarray(0, ts.length - (ts.length % 188));
}

function addRemoteResource(session, url, headers = {}) {
  const index = session.resources.length;
  session.resources.push({ url, headers });
  return `/media/${session.token}/chunk/${index}`;
}

function rewriteUriAttribute(line, session, playlistUrl) {
  return line.replace(/URI="([^"]+)"/i, (_match, uri) => {
    const absolute = new URL(uri, playlistUrl).href;
    return `URI="${addRemoteResource(session, absolute)}"`;
  });
}

function rewritePlaylist(text, session, playlistUrl) {
  return String(text).split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (/^#EXT-X-(KEY|MAP|MEDIA|I-FRAMES-ONLY-STREAM-INF):/i.test(trimmed) && /URI="/i.test(line)) {
      return rewriteUriAttribute(line, session, playlistUrl);
    }
    if (trimmed.startsWith('#')) return line;
    if (!isHttpUrl(new URL(trimmed, playlistUrl).href)) return line;
    const absolute = new URL(trimmed, playlistUrl).href;
    return addRemoteResource(session, absolute);
  }).join('\n');
}

async function loadPlaylist(sourceUrl, sourceHeaders = {}, signal) {
  const first = await fetchBytes(sourceUrl, { headers: sourceHeaders, signal });
  const contentType = (first.response.headers.get('content-type') || '').toLowerCase();
  const html = Buffer.from(first.bytes).toString('utf8');
  let playlistUrl = sourceUrl;
  let playlistText = html;
  let cookie = mergeSetCookies('', first.response);
  let payload = decodePlayerPayload(html);

  if (contentType.includes('text/html') || contentType.includes('xml') || payload || !/^\s*#EXTM3U/m.test(playlistText)) {
    playlistUrl = payload?.sU || extractPlaylistUrlFromHtml(html, sourceUrl);
    if (!playlistUrl) throw new Error('player wrapper does not expose an HLS playlist');
    const second = await fetchBytes(playlistUrl, { headers: sourceHeaders, cookie, signal });
    cookie = mergeSetCookies(cookie, second.response);
    playlistText = Buffer.from(second.bytes).toString('utf8');
    const secondContentType = (second.response.headers.get('content-type') || '').toLowerCase();
    if (secondContentType.includes('text/html') && !/^\s*#EXTM3U/m.test(playlistText)) {
      const nestedUrl = extractPlaylistUrlFromHtml(playlistText, playlistUrl);
      if (!nestedUrl) throw new Error('nested player wrapper does not expose an HLS playlist');
      playlistUrl = nestedUrl;
      const third = await fetchBytes(playlistUrl, { headers: sourceHeaders, cookie, signal });
      cookie = mergeSetCookies(cookie, third.response);
      playlistText = Buffer.from(third.bytes).toString('utf8');
    }
    playlistText = decryptPlaylist(playlistText, payload?.eK);
  }

  if (!/^\s*#EXTM3U/m.test(playlistText)) throw new Error('upstream response is not an HLS playlist');
  return { playlistText, playlistUrl, cookie, sourceHeaders };
}

function firstMediaUrl(playlistText, playlistUrl) {
  const line = String(playlistText || '').split(/\r?\n/).map(x => x.trim()).find(x => x && !x.startsWith('#'));
  if (!line) return null;
  try { return new URL(line, playlistUrl).href; } catch { return null; }
}

async function verifyFirstSegment(loaded, signal) {
  async function probe(url, depth = 0) {
    const result = await fetchBytes(url, {
      headers: { ...loaded.sourceHeaders, Referer: loaded.sourceHeaders?.Referer || loaded.playlistUrl, Range: 'bytes=0-65535' },
      cookie: loaded.cookie,
      signal
    });
    if (!result.bytes?.length) throw new Error('first HLS resource is empty');
    const text = Buffer.from(result.bytes).toString('utf8');
    if (/^\s*#EXTM3U/m.test(text) && depth < 3) {
      const child = firstMediaUrl(text, url);
      if (!child) throw new Error('nested HLS playlist has no media resource');
      return probe(child, depth + 1);
    }
    return url;
  }
  const first = firstMediaUrl(loaded.playlistText, loaded.playlistUrl);
  if (!first) throw new Error('HLS playlist has no media resource');
  return probe(first);
}

export async function createMediaProxy(sourceUrl, sourceHeaders = {}, options = {}) {
  if (!isHttpUrl(sourceUrl)) return null;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Math.floor(Number(options.timeoutMs)))
    : FETCH_TIMEOUT;
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abortFromOutside = () => controller.abort(externalSignal?.reason || new Error('media proxy cancelled'));
  if (externalSignal) {
    if (externalSignal.aborted) abortFromOutside();
    else externalSignal.addEventListener('abort', abortFromOutside, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error('media proxy source timeout')), timeoutMs);
  let loaded;
  try {
    loaded = await loadPlaylist(sourceUrl, sourceHeaders, controller.signal);
    if (options.verifyFirstSegment) await verifyFirstSegment(loaded, controller.signal);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromOutside);
  }
  const token = crypto.randomBytes(18).toString('base64url');
  const session = {
    token,
    sourceUrl,
    sourceHeaders,
    cookie: loaded.cookie,
    playlistUrl: loaded.playlistUrl,
    resources: [],
    createdAt: Date.now(),
    playlist: ''
  };
  session.playlist = rewritePlaylist(loaded.playlistText, session, loaded.playlistUrl);
  sessions.set(token, session);
  return {
    token,
    url: `/media/${token}/playlist.m3u8`,
    session
  };
}

export function getMediaSession(token) {
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function deleteMediaSession(token) {
  if (token) sessions.delete(String(token));
}

export async function fetchMediaResource(session, index) {
  const resource = session?.resources?.[index];
  if (!resource) return null;
  const result = await fetchBytes(resource.url, {
    headers: {
      ...session.sourceHeaders,
      Referer: session.sourceHeaders?.Referer || session.playlistUrl,
      ...(resource.headers || {})
    },
    cookie: session.cookie
  });
  const text = Buffer.from(result.bytes).toString('utf8');
  if (/^\s*#EXTM3U/m.test(text)) {
    const rewritten = rewritePlaylist(text, session, resource.url);
    return { bytes: Buffer.from(rewritten, 'utf8'), contentType: 'application/vnd.apple.mpegurl' };
  }
  const normalized = normalizeMediaBytes(result.bytes);
  return {
    bytes: normalized || Buffer.from(result.bytes),
    contentType: normalized ? 'video/mp2t' : (result.response.headers.get('content-type') || 'application/octet-stream')
  };
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL;
  for (const [token, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(token);
  }
}, 10 * 60 * 1000).unref();
