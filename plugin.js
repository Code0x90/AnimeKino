// AnimeAV1 plugin for Kino.
// Catalog pages are read from animeav1.com. The site's HLS button uses a public
// player.zilla-networks.com/play/<id> page whose player loads /m3u8/<id>.

const BASE = "https://animeav1.com";
const KITSU = "https://kitsu.io/api/edge";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PAGE_SIZE = 20;
const MAX_CATALOG_PAGE = 50;

function cleanText(value) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp("\\b" + escaped + '="([^"]*)"', "i").exec(tag);
  return match ? cleanText(match[1]) : "";
}

function animeMeta(html, slug) {
  const marker = 'slug:"' + slug + '"';
  const at = html.indexOf(marker);
  if (at < 0) return {};

  const before = html.slice(0, at);
  const starts = [...before.matchAll(/id:\d+,title:"/g)];
  const start = starts.length ? starts[starts.length - 1].index : Math.max(0, at - 5000);
  const record = html.slice(start, Math.min(html.length, at + 1600));
  const afterSlug = html.slice(at, Math.min(html.length, at + 1400));
  const date = /startDate:"(\d{4})/.exec(record);
  const score = /score:([\d.]+)/.exec(record);
  const mature = /mature:true/.test(record);
  const genreMatches = [...record.matchAll(/genres:\[([^\]]*)\]/g)];
  const genres = genreMatches.length
    ? [...genreMatches[genreMatches.length - 1][1].matchAll(/slug:"([^"]+)"/g)].map((m) => m[1]).slice(0, 5)
    : [];
  const seasonMatch = /seasons:(null|\[[^\]]*\])/.exec(afterSlug);
  const malId = /malId:(\d+)/.exec(afterSlug);

  return {
    year: date ? date[1] : undefined,
    rating: score ? Number(score[1]) : undefined,
    mature,
    genres,
    malId: malId ? Number(malId[1]) : undefined,
    seasonValue: seasonMatch ? seasonMatch[1] : "null",
  };
}

async function getKitsuEpisodes(malId) {
  if (!Number.isInteger(malId) || malId < 1) return new Map();
  try {
    const mappingUrl = KITSU + "/mappings?filter%5BexternalSite%5D=myanimelist%2Fanime&filter%5BexternalId%5D=" + malId + "&include=item";
    const mappingResponse = await kino.fetch(mappingUrl, {
      headers: { Accept: "application/vnd.api+json" }, timeoutMs: 15000,
    });
    if (!mappingResponse.ok) return new Map();
    const mapping = mappingResponse.json();
    const animeId = (mapping.included || []).find((item) => item && item.type === "anime")?.id;
    if (!animeId || !/^\d+$/.test(String(animeId))) return new Map();

    const animeResponse = await kino.fetch(KITSU + "/anime/" + animeId + "?include=episodes", {
      headers: { Accept: "application/vnd.api+json" }, timeoutMs: 20000,
    });
    if (!animeResponse.ok) return new Map();
    const anime = animeResponse.json();
    const byNumber = new Map();
    for (const item of anime.included || []) {
      if (!item || item.type !== "episodes" || !item.attributes) continue;
      const attributes = item.attributes;
      const number = Number(attributes.number);
      if (!Number.isInteger(number) || number < 1) continue;
      const titles = attributes.titles || {};
      const title = titles.es || titles.es_es || titles.es_mx || titles.es_419 || titles.en || titles.en_us ||
        titles.ja_jp || attributes.canonicalTitle || titles.en_jp || "";
      const thumbnail = attributes.thumbnail && attributes.thumbnail.original;
      const still = typeof thumbnail === "string" && /^https:\/\//i.test(thumbnail) ? thumbnail : undefined;
      const rawAirDate = attributes.airDate || attributes.airdate;
      const airDate = typeof rawAirDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawAirDate)
        ? rawAirDate : undefined;
      const runtime = Number(attributes.length);
      const candidates = byNumber.get(number) || [];
      candidates.push({
        season: Number(attributes.seasonNumber) || undefined,
        title: String(title || "").trim().slice(0, 200),
        still,
        airDate,
        runtimeMinutes: Number.isInteger(runtime) && runtime >= 1 && runtime <= 1000 ? runtime : undefined,
      });
      byNumber.set(number, candidates);
    }
    return byNumber;
  } catch {
    // Metadata is optional: a Kitsu outage or an unmapped MAL id must not hide episodes.
    return new Map();
  }
}

function enrichEpisodes(episodes, metadata) {
  return episodes.map((episode) => {
    const candidates = metadata.get(episode.number) || [];
    const sameSeason = candidates.filter((candidate) => candidate.season === episode.season);
    const preferred = sameSeason.length === 1 ? sameSeason : candidates.filter((candidate) => candidate.season === 1);
    const extra = preferred.length === 1 ? preferred[0] : candidates.length === 1 ? candidates[0] : null;
    if (!extra) return episode;
    return {
      ...episode,
      title: extra.title || episode.title,
      still: extra.still,
      airDate: extra.airDate,
      runtimeMinutes: extra.runtimeMinutes,
    };
  });
}

function stableId(slug) {
  if (slug.length <= 128 && /^[A-Za-z0-9._~-]+$/.test(slug)) return slug;
  let hash = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    hash ^= slug.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return slug.slice(0, 96) + "~" + (hash >>> 0).toString(36);
}

function parseCard(article, pageHtml) {
  const link = /<a\b[^>]*href="\/media\/([a-z0-9._~-]+)"[^>]*>/i.exec(article);
  if (!link) return null;
  const slug = link[1];
  const heading = /<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i.exec(article);
  const posterMatch = /<img\b[^>]*alt="(?:Portada|Póster) de ([^"]+)"[^>]*>/i.exec(article);
  const images = [...article.matchAll(/<img\b[^>]*>/gi)];
  let poster = "";
  for (const image of images) {
    const tag = image[0];
    if (/alt="(?:Portada|Póster) de /i.test(tag)) {
      poster = attr(tag, "src");
      break;
    }
  }
  const synopsis = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(article);
  const title = cleanText(heading ? heading[1] : (posterMatch ? posterMatch[1] : slug.replace(/-/g, " ")));
  if (!title) return null;

  const meta = animeMeta(pageHtml, slug);
  // Keep the first version compatible with older Kino builds by excluding mature
  // titles instead of returning them without Kino's 18+ lock.
  if (meta.mature || meta.genres.some((g) => /^(hentai|erotica|adult)$/i.test(g)) || /hentai|solo adultos|18\+/i.test(article)) return null;

  return {
    id: stableId(slug),
    ref: slug,
    title: title.slice(0, 200),
    kind: "series",
    lang: "es",
    poster: poster || undefined,
    overview: synopsis ? cleanText(synopsis[1]).slice(0, 2000) : undefined,
    year: meta.year,
    rating: meta.rating,
    genres: meta.genres.length ? meta.genres : ["anime"],
  };
}

function parseCards(html) {
  const articles = html.match(/<article\b[\s\S]*?<\/article>/gi) || [];
  const out = [];
  const seen = new Set();
  for (const article of articles) {
    const item = parseCard(article, html);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length >= PAGE_SIZE) break;
  }
  return out;
}

async function getPage(path) {
  const response = await kino.fetch(BASE + path, {
    headers: { Accept: "text/html" },
    timeoutMs: 12000,
  });
  if (response.status === 404) throw kino.error("not_found", "No se encontró ese anime");
  if (!response.ok) throw kino.error("unavailable", "AnimeAV1 no respondió correctamente");
  return response.text();
}

function validPage(value) {
  const page = value ? Number(value) : 1;
  return Number.isInteger(page) && page >= 1 && page <= MAX_CATALOG_PAGE ? page : 0;
}

function nextPage(items, page) {
  return items.length >= PAGE_SIZE && page < MAX_CATALOG_PAGE ? String(page + 1) : undefined;
}

function episodeList(html, slug) {
  const marker = 'slug:"' + slug + '"';
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) return { meta: {}, episodes: [] };
  const meta = animeMeta(html, slug);
  const listAt = html.indexOf("episodes:[", markerAt);
  if (listAt < 0) return { meta, episodes: [] };
  const end = html.indexOf("]", listAt);
  if (end < 0) return { meta, episodes: [] };
  const raw = html.slice(listAt, end + 1);
  const matches = [...raw.matchAll(/\{id:(\d+),number:(\d+)(?:,season:(\d+))?\}/g)];
  const seen = new Set();
  const episodes = [];
  for (const match of matches) {
    const number = Number(match[2]);
    const season = Number(match[3] || 1);
    if (number < 1 || season < 1 || number > 99999 || season > 999) continue;
    const key = season + ":" + number;
    if (seen.has(key)) continue;
    seen.add(key);
    episodes.push({ season, number, ref: slug + "|" + number, title: "Episodio " + number });
  }
  return { meta, episodes };
}

function titleFrom(html, fallback) {
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return heading ? cleanText(heading[1]).slice(0, 200) : fallback;
}

function posterFrom(html) {
  const images = [...html.matchAll(/<img\b[^>]*>/gi)];
  for (const image of images) {
    if (/alt="(?:Portada|Póster) de /i.test(image[0])) return attr(image[0], "src") || undefined;
  }
  return undefined;
}

function backdropFrom(html) {
  const images = [...html.matchAll(/<img\b[^>]*>/gi)];
  for (const image of images) {
    if (/alt="(?:backdrop|fondo|One Piece Backdrop)/i.test(image[0])) return attr(image[0], "src") || undefined;
  }
  return undefined;
}

const VOE_MARKERS = ["@$", "^^", "~@", "%?", "*~", "!!", "#&"];

function decodeVoePayload(rawValue) {
  let value = String(rawValue).replace(/[a-z]/gi, (char) => {
    const base = char <= "Z" ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
  for (const marker of VOE_MARKERS) value = value.split(marker).join("_");
  value = atob(value.replaceAll("_", ""));
  value = Array.from(value, (char) => String.fromCharCode((char.charCodeAt(0) - 3 + 256) % 256)).join("");
  value = atob(Array.from(value).reverse().join(""));
  return JSON.parse(value);
}

function unescapeHtml(value) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function sourceName(name) {
  const value = String(name || "").toLowerCase();
  if (value.includes("voe")) return "Voe";
  if (value === "hls" || value.includes("playerzilla") || value.includes("zilla")) return "PlayerZilla";
  return "";
}

function sourceUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

async function episodeServers(slug, number) {
  const path = "/media/" + encodeURIComponent(slug) + "/" + number;
  try {
    const response = await kino.fetch(BASE + path + "/__data.json", {
      headers: { "User-Agent": UA, Referer: BASE + "/" }, timeoutMs: 12000,
    });
    if (response.ok) {
      const root = response.json();
      for (const node of root.nodes || []) {
        const data = node && node.data;
        if (!Array.isArray(data)) continue;
        const episode = data.find((entry) => entry && typeof entry === "object" && "embeds" in entry);
        if (!episode) continue;
        const embeds = data[episode.embeds];
        if (!embeds || typeof embeds !== "object") continue;
        const servers = [];
        const lanes = Array.isArray(embeds)
          ? [{ key: "SUB", lang: "Japonés" }]
          : [
              { key: "SUB", lang: "Japonés" }, { key: "sub", lang: "Japonés" },
              { key: "DUB", lang: "Latino" }, { key: "dub", lang: "Latino" },
            ];
        for (const lane of lanes) {
          const listRef = Array.isArray(embeds) ? embeds : embeds[lane.key];
          const list = typeof listRef === "number" ? data[listRef] : listRef;
          for (const ref of Array.isArray(list) ? list : []) {
            const item = typeof ref === "number" ? data[ref] : ref;
            if (!item || typeof item !== "object") continue;
            const field = (v) => typeof v === "number" ? data[v] : v;
            const name = sourceName(field(item.server));
            const url = sourceUrl(field(item.url));
            if (name && url && !servers.some((s) => s.name === name && s.lang === lane.lang)) {
              servers.push({ name, lang: lane.lang, url });
            }
          }
        }
        if (servers.length) return servers;
      }
    }
  } catch { /* The page HTML below is the site's fallback representation. */ }

  const html = await getPage(path);
  const block = /embeds:\{([\s\S]*?)\},downloads:/.exec(html);
  if (!block) return [];
  const servers = [];
  for (const lane of [{ key: "SUB", lang: "Japonés" }, { key: "DUB", lang: "Latino" }]) {
    const laneBlock = new RegExp("(?:^|[,\\s])" + lane.key + ":\\[([\\s\\S]*?)\\]", "i").exec(block[1]);
    if (!laneBlock) continue;
    for (const match of laneBlock[1].matchAll(/\{server:"([^"\\]*(?:\\.[^"\\]*)*)",url:"([^"\\]*(?:\\.[^"\\]*)*)"\}/g)) {
      const name = sourceName(match[1]);
      const url = sourceUrl(match[2].replace(/\\u0026/gi, "&").replace(/\\\//g, "/"));
      if (name && url && !servers.some((s) => s.name === name && s.lang === lane.lang)) {
        servers.push({ name, lang: lane.lang, url });
      }
    }
  }
  return servers;
}

function hlsUrlFromPlayer(rawUrl) {
  let player;
  try {
    player = new URL(rawUrl);
  } catch {
    return "";
  }
  if (player.protocol !== "https:" || player.hostname !== "player.zilla-networks.com") return "";
  const parts = player.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "play" || !/^[a-f0-9]{16,64}$/i.test(parts[1])) return "";
  return "https://player.zilla-networks.com/m3u8/" + parts[1];
}

function playerZillaStream(rawUrl) {
  const direct = hlsUrlFromPlayer(rawUrl);
  return direct ? {
    url: direct,
    headers: {
      Referer: "https://player.zilla-networks.com/",
      "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty", "User-Agent": UA,
    },
  } : null;
}

async function voeStream(embedUrl) {
  const origin = new URL(embedUrl).origin;
  let response = await kino.fetch(embedUrl, { headers: { "User-Agent": UA }, timeoutMs: 15000 });
  if (!response.ok) throw new Error("Voe embed no respondió");
  let html = response.text();
  const redirect = /window\.location\.href\s*=\s*['"]([^'"]+)['"]/.exec(html);
  if (redirect) {
    const redirectUrl = new URL(redirect[1], embedUrl);
    if (redirectUrl.protocol !== "https:") throw new Error("Redirección Voe no segura");
    response = await kino.fetch(redirectUrl.href, { headers: { "User-Agent": UA }, timeoutMs: 15000 });
    if (!response.ok) throw new Error("Redirección Voe no respondió");
    html = response.text();
  }
  const script = /<script\s+type="application\/json"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!script) throw new Error("No se encontró el payload de Voe");
  const payload = JSON.parse(unescapeHtml(script[1]));
  if (!Array.isArray(payload) || typeof payload[0] !== "string") throw new Error("Payload Voe inválido");
  const decoded = decodeVoePayload(payload[0]);
  const url = sourceUrl(decoded && decoded.source);
  if (!url) throw new Error("Voe no entregó un HLS válido");
  return { url, headers: { Referer: origin + "/", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty", "User-Agent": UA } };
}

export async function search(query) {
  await null;
  const q = query && typeof query.q === "string" ? query.q.trim() : "";
  if (!q) return [];
  const page = validPage(query && query.cursor);
  if (!page) return [];
  const path = "/catalogo?search=" + encodeURIComponent(q) + "&page=" + page;
  const html = await getPage(path);
  const items = parseCards(html);
  return { items, next: nextPage(items, page) };
}

export async function home() {
  const html = await getPage("/catalogo");
  const items = parseCards(html);
  if (!items.length) return [];
  return [{ id: "anime-recientes", title: "Animes recientes", genre: "anime", ref: "catalogo", items }];
}

export async function browse(ref, cursor) {
  await null;
  if (ref !== "catalogo") throw kino.error("not_found", "No existe esa sección");
  const page = validPage(cursor);
  if (!page) throw kino.error("not_found", "No existe esa página");
  const html = await getPage("/catalogo?page=" + page);
  const items = parseCards(html);
  return { items, next: nextPage(items, page) };
}

export async function episodes(ref) {
  const slug = String(ref || "");
  if (!/^[a-z0-9._~-]{1,128}$/i.test(slug)) throw kino.error("not_found", "No se encontró ese anime");
  const html = await getPage("/media/" + encodeURIComponent(slug));
  const data = episodeList(html, slug);
  if (!data.episodes.length) throw kino.error("not_found", "No se encontraron episodios");
  const episodeMetadata = await getKitsuEpisodes(data.meta.malId);
  const title = titleFrom(html, slug.replace(/-/g, " "));
  const synopsis = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  return {
    series: {
      title,
      poster: posterFrom(html),
      backdrop: backdropFrom(html),
      overview: synopsis ? cleanText(synopsis[1]).slice(0, 2000) : undefined,
      year: data.meta.year,
      rating: data.meta.rating,
      genres: data.meta.genres.length ? data.meta.genres : ["anime"],
    },
    episodes: enrichEpisodes(data.episodes, episodeMetadata),
  };
}

export async function resolve(ref) {
  await null;
  const value = String(ref || "");
  const split = value.split("|");
  const slug = split[0] || "";
  const number = Number(split[1]);
  if (split.length !== 2 || !/^[a-z0-9._~-]{1,128}$/i.test(slug) || !Number.isInteger(number) || number < 1 || number > 99999) {
    throw kino.error("not_found", "No se encontró ese episodio");
  }
  const servers = await episodeServers(slug, number);
  const resolved = [];
  for (const server of servers) {
    try {
      const stream = server.name === "PlayerZilla" ? playerZillaStream(server.url) : await voeStream(server.url);
      if (stream && !resolved.some((item) => item.url === stream.url)) {
        resolved.push({ ...stream, label: server.name + " · " + server.lang });
      }
    } catch { /* A failed source does not prevent trying the other supported source. */ }
  }
  if (!resolved.length) throw kino.error("unavailable", "No se pudo resolver Voe ni PlayerZilla para este episodio");
  return { ...resolved[0], alternatives: resolved.slice(1) };
}
