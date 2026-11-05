// AnimeAV1 plugin for Kino.
// Catalog pages are read from animeav1.com. The site's HLS button uses a public
// player.zilla-networks.com/play/<id> page whose player loads /m3u8/<id>.

const BASE = "https://animeav1.com";
const ANILIST = "https://graphql.anilist.co";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PAGE_SIZE = 20;
const MAX_CATALOG_PAGE = 50;
const MAX_SLUG_LENGTH = 500;
const catalogDetailCache = new Map();
const HOME_CATALOGS = [
  { id: "anime-mejor-puntuados", title: "Mejor puntuados", ref: "catalogo:order:score", path: "/catalogo?order=score&page=1" },
  { id: "anime-recientes", title: "Recientes", ref: "catalogo:order:latest_added", path: "/catalogo?order=latest_added&page=1" },
  { id: "anime-series", title: "Series", ref: "catalogo:category:tv-anime", path: "/catalogo?category=tv-anime&page=1" },
  { id: "anime-peliculas", title: "Películas", ref: "catalogo:category:pelicula", path: "/catalogo?category=pelicula&page=1" },
  { id: "anime-ovas", title: "OVAs", ref: "catalogo:category:ova", path: "/catalogo?category=ova&page=1" },
  { id: "anime-especiales", title: "Especiales", ref: "catalogo:category:especial", path: "/catalogo?category=especial&page=1" },
];

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
  const date = /startDate:"(\d{4})/.exec(record);
  const score = /score:([\d.]+)/.exec(record);
  const mature = /mature:true/.test(record);
  const genreMatches = [...record.matchAll(/genres:\[([^\]]*)\]/g)];
  const genres = genreMatches.length
    ? [...genreMatches[genreMatches.length - 1][1].matchAll(/slug:"([^"]+)"/g)].map((m) => m[1]).slice(0, 5)
    : [];
  const malId = /^,malId:(\d+)/.exec(html.slice(at + marker.length));

  return {
    year: date ? date[1] : undefined,
    rating: score ? Number(score[1]) : undefined,
    mature,
    genres,
    malId: malId ? Number(malId[1]) : undefined,
  };
}

function isPublicImage(value) {
  return typeof value === "string" && /^https:\/\//i.test(value);
}

async function getAniListMedia(malIds) {
  const ids = [...new Set((malIds || []).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 50);
  if (!ids.length) return new Map();
  try {
    const response = await kino.fetch(ANILIST, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: { json: {
        query: "query ($ids: [Int]) { Page(perPage: 50) { media(type: ANIME, idMal_in: $ids) { id idMal coverImage { extraLarge large } bannerImage } } }",
        variables: { ids },
      } },
      timeoutMs: 8000,
    });
    if (!response.ok) {
      return new Map();
    }
    const mediaList = response.json()?.data?.Page?.media || [];
    const out = new Map();
    for (const media of mediaList) {
      const malId = Number(media.idMal);
      if (!ids.includes(malId)) continue;
      const cover = media.coverImage || {};
      out.set(malId, {
        anilistId: Number(media.id) || undefined,
        poster: [cover.extraLarge, cover.large].find(isPublicImage),
        backdrop: isPublicImage(media.bannerImage) ? media.bannerImage : undefined,
      });
    }
    return out;
  } catch {
    return new Map();
  }
}

async function catalogDetail(item) {
  const existing = catalogDetailCache.get(item.ref);
  if (existing && Date.now() - existing.at < 24 * 60 * 60 * 1000) {
    const detail = await existing.value;
    return detail;
  }
  const value = getPage("/media/" + encodeURIComponent(item.ref), 4000)
    .then((html) => {
      const detail = { malId: animeMeta(html, item.ref).malId, poster: posterFrom(html) };
      return detail;
    })
    .catch(() => {
      catalogDetailCache.delete(item.ref);
      return {};
    });
  catalogDetailCache.set(item.ref, { at: Date.now(), value });
  if (catalogDetailCache.size > 200) catalogDetailCache.delete(catalogDetailCache.keys().next().value);
  return value;
}

async function enrichCatalogArtwork(items) {
  const detailData = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(10, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      const detail = item._malId ? {} : await catalogDetail(item);
      detailData.set(item.ref, { malId: item._malId || detail.malId, poster: detail.poster });
    }
  }));
  const media = await getAniListMedia(items.map((item) => (detailData.get(item.ref) || {}).malId));
  const result = items.map((item) => {
    const { _malId, ...visibleItem } = item;
    const detail = detailData.get(item.ref) || {};
    const malId = _malId || detail.malId;
    const anilist = media.get(malId);
    const poster = (anilist && anilist.poster) || visibleItem.poster || detail.poster;
    return { ...visibleItem, poster };
  });
  return result;
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
  const posterTag = [...article.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0])
    .find((tag) => /alt="(?:Portada|Póster) de /i.test(tag));
  let poster = posterTag && (attr(posterTag, "src") || attr(posterTag, "data-src") || attr(posterTag, "data-lazy-src"));
  if (!poster && posterTag) {
    const srcset = attr(posterTag, "srcset");
    const choices = srcset ? srcset.split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean) : [];
    poster = choices.length ? choices[choices.length - 1] : undefined;
  }
  const synopsis = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(article);
  const title = cleanText(heading ? heading[1] : slug.replace(/-/g, " "));
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
    _malId: meta.malId,
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

async function getPage(path, timeoutMs = 12000) {
  const response = await kino.fetch(BASE + path, {
    headers: { Accept: "text/html" },
    timeoutMs,
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
  const matches = [...raw.matchAll(/\{id:\d+,number:(\d+)(?:,season:(\d+))?\}/g)];
  const seen = new Set();
  const episodes = [];
  for (const match of matches) {
    const number = Number(match[1]);
    const season = Number(match[2] || 1);
    if (number < 1 || season < 1 || number > 99999 || season > 999) continue;
    const key = season + ":" + number;
    if (seen.has(key)) continue;
    seen.add(key);
    episodes.push({ season, number, ref: slug + "|" + number });
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
  const items = await enrichCatalogArtwork(parseCards(html));
  return { items, next: nextPage(items, page) };
}

export async function home() {
  const rows = await Promise.all(HOME_CATALOGS.map(async (catalog, index) => {
    try {
      const html = await getPage(catalog.path);
      const items = await enrichCatalogArtwork(parseCards(html));
      return items.length ? { ...catalog, genre: "anime", items } : null;
    } catch (error) {
      if (index === 0) throw error;
      return null;
    }
  }));
  return rows.filter(Boolean);
}

export async function browse(ref, cursor) {
  await null;
  const match = /^(catalogo|catalogo:(genre|category|order):([a-z0-9_-]+))$/.exec(String(ref || ""));
  if (!match) throw kino.error("not_found", "No existe esa sección");
  const page = validPage(cursor);
  if (!page) throw kino.error("not_found", "No existe esa página");
  const path = match[2]
    ? "/catalogo?" + match[2] + "=" + encodeURIComponent(match[3]) + "&page=" + page
    : "/catalogo?page=" + page;
  const html = await getPage(path);
  const items = await enrichCatalogArtwork(parseCards(html));
  return { items, next: nextPage(items, page) };
}

export async function episodes(ref) {
  const slug = String(ref || "");
  if (slug.length > MAX_SLUG_LENGTH || !/^[a-z0-9._~-]+$/i.test(slug)) throw kino.error("not_found", "No se encontró ese anime");
  const html = await getPage("/media/" + encodeURIComponent(slug));
  const data = episodeList(html, slug);
  if (!data.episodes.length) throw kino.error("not_found", "No se encontraron episodios");
  const animeImages = (await getAniListMedia([data.meta.malId])).get(data.meta.malId);
  const ids = {};
  if (Number.isInteger(data.meta.malId) && data.meta.malId > 0) ids.mal = data.meta.malId;
  if (Number.isInteger(animeImages && animeImages.anilistId) && animeImages.anilistId > 0) ids.anilist = animeImages.anilistId;
  const poster = animeImages?.poster || posterFrom(html);
  const backdrop = animeImages?.backdrop || backdropFrom(html);
  const title = titleFrom(html, slug.replace(/-/g, " "));
  const synopsis = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  return {
    series: {
      title,
      poster,
      backdrop,
      overview: synopsis ? cleanText(synopsis[1]).slice(0, 2000) : undefined,
      year: data.meta.year,
      rating: data.meta.rating,
      genres: data.meta.genres.length ? data.meta.genres : ["anime"],
      ids: Object.keys(ids).length ? ids : undefined,
    },
    episodes: data.episodes,
  };
}

export async function resolve(ref) {
  await null;
  const value = String(ref || "");
  const split = value.split("|");
  const slug = split[0] || "";
  const number = Number(split[1]);
  if (split.length !== 2 || slug.length > MAX_SLUG_LENGTH || !/^[a-z0-9._~-]+$/i.test(slug) || !Number.isInteger(number) || number < 1 || number > 99999) {
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
    } catch {
    }
  }
  if (!resolved.length) throw kino.error("unavailable", "No se pudo resolver Voe ni PlayerZilla para este episodio");
  return { ...resolved[0], alternatives: resolved.slice(1) };
}
