import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const GRAPHQL_URL = 'https://graphql.animex.one/graphql';
const REST_BASE = 'https://pp.animex.one/rest/api';

const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://animex.one',
  'Referer': 'https://animex.one/',
};

const slugCache = new Map();
const episodesCache = new Map();

async function postJson(url, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...UPSTREAM_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn(`[AnimeX] POST ${url} failed:`, e.message);
    return null;
  }
}

async function getJson(url, params = {}) {
  try {
    const qs = new URLSearchParams(params).toString();
    const fullUrl = qs ? `${url}?${qs}` : url;
    const res = await fetch(fullUrl, { headers: UPSTREAM_HEADERS });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn(`[AnimeX] GET ${url} failed:`, e.message);
    return null;
  }
}

async function mapAnilist(anilistId) {
  const id = parseInt(anilistId);
  if (isNaN(id)) return null;
  if (slugCache.has(id)) return slugCache.get(id);

  const data = await postJson(GRAPHQL_URL, {
    query: 'query($id:Int){anime(anilistId:$id){id anilistId titleEnglish titleRomaji}}',
    variables: { id },
  });

  const slug = data?.data?.anime?.id ?? null;
  slugCache.set(id, slug);
  return slug;
}

function episodeTitle(ep) {
  const titles = ep.titles ?? {};
  for (const key of ['en', 'x-jat', 'ja', 'romaji']) {
    if (typeof titles[key] === 'string' && titles[key].trim()) return titles[key].trim();
  }
  if (typeof ep.title === 'string' && ep.title.trim()) return ep.title.trim();
  return `Episode ${ep.number ?? '?'}`;
}

async function fetchRawEpisodes(anilistId) {
  const id = parseInt(anilistId);
  if (isNaN(id)) return [];
  if (episodesCache.has(id)) return episodesCache.get(id);

  const slug = await mapAnilist(id);
  if (!slug) return [];

  const data = await getJson(`${REST_BASE}/episodes`, { id: slug });
  let episodes = [];
  if (Array.isArray(data)) {
    episodes = data.filter(ep => typeof ep === 'object');
  } else if (data?.episodes || data?.data) {
    const raw = data.episodes ?? data.data ?? [];
    episodes = Array.isArray(raw) ? raw.filter(ep => typeof ep === 'object') : [];
  }

  if (episodes.length) episodesCache.set(id, episodes);
  return episodes;
}

async function listServers(slug, epNum) {
  const data = await getJson(`${REST_BASE}/servers`, { id: slug, epNum });
  if (typeof data !== 'object' || !data) return [[], []];
  const sub = Array.isArray(data.subProviders) ? data.subProviders : [];
  const dub = Array.isArray(data.dubProviders) ? data.dubProviders : [];
  return [sub, dub];
}

function orderedProviderIds(providers) {
  if (!Array.isArray(providers)) return [];
  const defaults = providers.filter(p => p?.default && p?.id).map(p => p.id);
  const rest = providers.filter(p => !p?.default && p?.id).map(p => p.id);
  return [...defaults, ...rest];
}

function qualityToInt(q) {
  if (!q) return 0;
  const m = String(q).match(/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

async function tryProvider(slug, epNum, type, providerId) {
  const data = await getJson(`${REST_BASE}/sources`, {
    id: slug, epNum, type, providerId,
  });
  if (!data || !Array.isArray(data.sources) || !data.sources.length) return null;
  return data;
}

async function getSources(anilistId, epNum, category = 'sub', preferredServer = null) {
  const slug = await mapAnilist(anilistId);
  if (!slug) return { error: 'no_sources', message: 'AnimeX has no slug for this title.' };

  let epNumClean = parseFloat(epNum);
  epNumClean = Number.isInteger(epNumClean) ? parseInt(epNumClean) : epNumClean;
  if (isNaN(epNumClean)) return { error: 'invalid_ep', message: 'Invalid episode number.' };

  const cat = ['sub', 'dub'].includes(category) ? category : 'sub';
  const [subProviders, dubProviders] = await listServers(slug, epNumClean);
  const providers = cat === 'dub' ? dubProviders : subProviders;
  let orderedIds = orderedProviderIds(providers);

  if (!orderedIds.length) {
    return { error: 'no_sources', message: `AnimeX has no ${cat} providers for episode ${epNumClean}.` };
  }

  if (preferredServer && orderedIds.includes(preferredServer)) {
    orderedIds = [preferredServer, ...orderedIds.filter(id => id !== preferredServer)];
  }

  let chosen = null;
  for (const pid of orderedIds) {
    const result = await tryProvider(slug, epNumClean, cat, pid);
    if (result) { chosen = { pid, result }; break; }
  }

  if (!chosen) return { error: 'no_sources', message: 'AnimeX returned no playable streams.' };

  const { pid: providerId, result: raw } = chosen;
  const upstreamHeaders = raw.headers ?? {};
  const ref = upstreamHeaders.Referer ?? upstreamHeaders.referer ?? null;

  const hlsSources = (raw.sources ?? [])
    .filter(s => typeof s === 'object' && (s.url || s.file))
    .map(s => {
      const url = s.url ?? s.file;
      const quality = s.quality ?? 'default';
      return { url, file: url, isM3U8: true, quality, label: quality };
    })
    .sort((a, b) => qualityToInt(b.quality) - qualityToInt(a.quality));

  if (!hlsSources.length) return { error: 'no_sources', message: 'AnimeX stream list was empty.' };

  const tracks = (Array.isArray(raw.tracks) ? raw.tracks : [])
    .filter(s => typeof s === 'object' && (s.file || s.url))
    .map(s => ({
      file: s.file ?? s.url,
      url: s.file ?? s.url,
      label: s.label ?? s.lang ?? 'Unknown',
      kind: s.kind ?? 'subtitles',
      lang: s.label ?? s.lang ?? 'Unknown',
    }));

  const availableQualities = [...new Set(hlsSources.map(s => s.quality))]
    .sort((a, b) => qualityToInt(b) - qualityToInt(a));

  return {
    sources: hlsSources.map(s => ({ file: s.url, url: s.url, quality: s.quality })),
    tracks,
    intro: null,
    outro: null,
    headers: upstreamHeaders,
    provider: 'animex',
    download: '',
    hls_sources: hlsSources,
    source_type: 'hls',
    available_qualities: availableQualities,
    video_link: hlsSources[0].url,
    source_provider: 'animex',
    selected_server_id: providerId,
  };
}

app.get('/map/:anilistId', async (req, res) => {
  const slug = await mapAnilist(req.params.anilistId);
  if (!slug) return res.status(404).json({ error: 'not_found' });
  res.json({ anilistId: parseInt(req.params.anilistId), slug });
});

app.get('/episodes/:anilistId', async (req, res) => {
  const episodes = await fetchRawEpisodes(req.params.anilistId);
  if (!episodes.length) return res.status(404).json({ error: 'no_episodes' });

  const mapped = episodes.map(ep => {
    let num = parseFloat(ep.number);
    num = Number.isInteger(num) ? parseInt(num) : num;
    return {
      id: `watch/ax/${req.params.anilistId}/sub/${num}`,
      number: ep.number,
      title: episodeTitle(ep),
      filler: false,
    };
  });

  res.json({ total: mapped.length, episodes: mapped });
});

app.get('/watch/:anilistId/:category/:epNum', async (req, res) => {
  const { anilistId, category, epNum } = req.params;
  const preferredServer = req.query.server ?? null;
  const result = await getSources(anilistId, epNum, category, preferredServer);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

app.get('/servers/:anilistId/:epNum', async (req, res) => {
  const slug = await mapAnilist(req.params.anilistId);
  if (!slug) return res.status(404).json({ error: 'not_found' });
  const [sub, dub] = await listServers(slug, req.params.epNum);
  res.json({ sub, dub });
});

const PORT = process.env.PORT || 5500;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[AnimeX API] Running on http://0.0.0.0:${PORT}`);
});
