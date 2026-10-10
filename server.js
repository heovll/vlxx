import express from 'express';
import cors from 'cors';
import stremioAddonSdk from 'stremio-addon-sdk';
import { CATALOGS, scrapeCatalog, scrapeMeta, resolveStream } from './vlxx-ms.js';
import { createMediaProxy, getMediaSession, fetchMediaResource } from './media-proxy.js';

const { addonBuilder, getRouter } = stremioAddonSdk;
const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  next();
});
app.use(cors());

const PORT = Number(process.env.PORT || 10004);
const HOST = process.env.HOST || '0.0.0.0';
const BASE_URL = (process.env.VLXX_BASE_URL || 'https://vlxx.phd').replace(/\/$/, '');
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PAGE_SIZE = 20;
const manifest = {
  id: 'community.vlxx.ms',
  version: '0.1.1',
  name: 'VLXX ms',
  description: 'VLXX ms metadata and streams addon. Adult content.',
  logo: 'https://raw.githubusercontent.com/youngbi/repo/main/plugins/vlxx.ico',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  catalogs: CATALOGS.map(({ id, name }) => ({
    type: 'movie',
    id,
    name,
    extra: [{ name: 'skip', isRequired: false }]
  })),
  idPrefixes: ['vlxxms:'],
  behaviorHints: { configurable: false, configurationRequired: false }
};

const builder = new addonBuilder(manifest);
builder.defineCatalogHandler(async ({ id, extra }) => {
  const definition = CATALOGS.find(item => item.id === id) || CATALOGS[0];
  const skip = Math.max(0, Number(extra?.skip || 0));
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const result = await scrapeCatalog({ path: definition.path, page });
  return { metas: result.metas };
});
builder.defineMetaHandler(async ({ id }) => {
  if (!String(id || '').startsWith('vlxxms:')) return { meta: null };
  return { meta: await scrapeMeta(id) };
});
builder.defineStreamHandler(async ({ id }) => {
  const resolved = await resolveStream(id);
  const sourceHeaders = {
    Referer: resolved.referer,
    Origin: resolved.origin,
    ...(resolved.cookie ? { Cookie: resolved.cookie } : {})
  };
  const proxied = await createMediaProxy(resolved.url, sourceHeaders, {
    timeoutMs: 120000,
    verifyFirstSegment: true
  });
  if (!proxied) return { streams: [] };
  return {
    streams: [{
      name: 'VLXX ms • Full',
      description: 'Internal HLS Proxy • Test build',
      url: `${PUBLIC_URL}${proxied.url}`,
      behaviorHints: { notWebReady: false }
    }]
  };
});

const router = getRouter(builder.getInterface());
const imageCache = new Map();
const ALLOWED_IMAGE_HOSTS = new Set(['vlxx.phd', 'vlxx.ms', 'vlxx.moi', 'cdn.vlcontent.com']);
function isAllowedImageHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return ALLOWED_IMAGE_HOSTS.has(host) || host.endsWith('.vlstream.net');
}
app.get('/image', async (req, res) => {
  try {
    const target = new URL(String(req.query.url || ''));
    if (!['http:', 'https:'].includes(target.protocol) || !isAllowedImageHost(target.hostname)) {
      return res.status(400).send('image host is not allowed');
    }
    const key = target.href;
    const cached = imageCache.get(key);
    if (cached && Date.now() - cached.time < 6 * 60 * 60 * 1000) {
      res.setHeader('Content-Type', cached.type);
      res.setHeader('Cache-Control', 'public, max-age=21600');
      return res.send(cached.bytes);
    }
    const upstream = await fetch(target.href, {
      redirect: 'follow',
      headers: { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8', Referer: `${BASE_URL}/`, 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(20000)
    });
    if (!upstream.ok) return res.status(502).send(`image upstream HTTP ${upstream.status}`);
    const bytes = Buffer.from(await upstream.arrayBuffer());
    const type = upstream.headers.get('content-type') || 'image/jpeg';
    imageCache.set(key, { time: Date.now(), bytes, type });
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=21600');
    return res.send(bytes);
  } catch (error) {
    return res.status(400).send(error?.message || 'image proxy failed');
  }
});
app.get('/manifest.json', (_req, res) => res.json(manifest));
app.get('/health', (_req, res) => res.json({ ok: true, addon: 'vlxxms', version: manifest.version, port: PORT }));
app.get('/media/:token/playlist.m3u8', (req, res) => {
  const session = getMediaSession(req.params.token);
  if (!session) return res.status(404).send('media session not found');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(session.playlist);
});
app.get('/media/:token/chunk/:index', async (req, res) => {
  const session = getMediaSession(req.params.token);
  if (!session) return res.status(404).send('media session not found');
  try {
    const resource = await fetchMediaResource(session, Number(req.params.index));
    if (!resource) return res.status(404).send('media resource not found');
    res.setHeader('Content-Type', resource.contentType);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(resource.bytes);
  } catch (error) {
    return res.status(502).send(error?.message || 'media fetch failed');
  }
});
app.use(router);
app.listen(PORT, HOST, () => console.log(`VLXX ms addon listening on ${HOST}:${PORT}`));
