import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ntuCampusShuttleSource from './data/ntu-campus-shuttle.js';

dotenv.config({ quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 3000);
const LTA_ACCOUNT_KEY = normalizeLtaAccountKey(process.env.LTA_ACCOUNT_KEY);
const LTA_BASE_URL = 'https://datamall2.mytransport.sg/ltaodataservice';
const ARRIVELAH_BASE_URL = 'https://arrivelah2.busrouter.sg/';
const BUSROUTER_BASE_URL = 'https://data.busrouter.sg/v1';
const MAZEMAP_API_BASE_URL = 'https://api.mazemap.com';
const NTU_OMNIBUS_BASE_URL = 'https://apps.ntu.edu.sg/NTUOmnibus/';
const PUBLIC_BUS_SERVICES = ['179', '199'];
const CAMPUS_SHUTTLE_SERVICES = Object.keys(ntuCampusShuttleSource.services);
const SERVICES = [...PUBLIC_BUS_SERVICES, ...CAMPUS_SHUTTLE_SERVICES];
const PUBLIC_LIVE_SERVICE_SET = new Set(PUBLIC_BUS_SERVICES);
const CAMPUS_LIVE_SERVICE_SET = new Set(CAMPUS_SHUTTLE_SERVICES);
const LIVE_SERVICE_SET = new Set(SERVICES);
const PAGE_SIZE = 500;
const STATIC_CACHE_TTL_MS = Number(process.env.STATIC_CACHE_TTL_MS || 12 * 60 * 60 * 1000);
const ARRIVAL_CACHE_TTL_MS = Number(process.env.ARRIVAL_CACHE_TTL_MS || 8000);
const ROOM_INDEX_CACHE_TTL_MS = Number(process.env.ROOM_INDEX_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 5000);
const NTU_OMNIBUS_MODULE_VERSION_TTL_MS = Number(
  process.env.NTU_OMNIBUS_MODULE_VERSION_TTL_MS || 30 * 60 * 1000
);
const MAZEMAP_POI_PAGE_LIMIT = 2000;
const NTU_VIEW = {
  center: {
    lat: 1.3483,
    lng: 103.6831,
  },
  zoom: 14.7,
};
const NTU_ROOM_SEARCH_CAMPUSES = [
  {
    campusId: 2123,
    campusName: 'NTU - Main Campus',
    maxPages: 4,
  },
  {
    campusId: 2270,
    campusName: 'NTU - Novena',
    maxPages: 1,
  },
  {
    campusId: 2271,
    campusName: 'NTU One-North',
    maxPages: 1,
  },
];
const ROOM_SEARCH_PHRASE_ALIASES = [
  {
    shortForm: 'tr',
    longForm: 'tutorial room',
  },
  {
    shortForm: 'lt',
    longForm: 'lecture theatre',
  },
];
const ROOM_SEARCH_ACRONYM_STOPWORDS = new Set(['and', 'at', 'for', 'in', 'of', 'the', 'to']);

const routeCache = {
  data: null,
  fetchedAt: 0,
  pending: null,
};

const arrivalCache = new Map();
const ntuOmnibusModuleVersionCache = {
  value: null,
  fetchedAt: 0,
  pending: null,
};
const roomIndexCache = {
  data: null,
  fetchedAt: 0,
  pending: null,
};

const SERVICE_COLORS = {
  '179': '#ff4fa3',
  '199': '#ff6b35',
  ...Object.fromEntries(
    CAMPUS_SHUTTLE_SERVICES.map((serviceNo) => [serviceNo, ntuCampusShuttleSource.services[serviceNo].color])
  ),
};

const LOAD_LABELS = {
  SEA: 'Seats available',
  SDA: 'Standing available',
  LSD: 'Limited standing',
};

const VEHICLE_LABELS = {
  SD: 'Single deck',
  DD: 'Double deck',
  BD: 'Bendy bus',
};

const CAMPUS_OMNIBUS_ROUTE_MAP = {
  'CL-B': {
    routeName: 'Blue',
    routeColorCode: '0054A6',
  },
  'CL-R': {
    routeName: 'Red',
    routeColorCode: 'C1272D',
  },
  CR: {
    routeName: 'Green',
    routeColorCode: '1E9D61',
  },
  CWR: {
    routeName: 'Brown',
    routeColorCode: '8A5A3C',
  },
};

const NTU_OMNIBUS_API = {
  pickupCheckPoints: 'T2ld7BA3eca74ndBz+xz1Q',
  activeBusServicesData: 'ZqTN65XW1uKLZ0T8NTg0jw',
  eta: '2vqnARteBS8UFZvhYCydcw',
};

const NTU_OMNIBUS_CLIENT_VARIABLES = {
  SGHO_RouteColorCode: 'D9860A',
  NTU_RouteColorCode:
    "{'data':[{'route_code':'Blue','color_code':'0054A6','Order':'2'},{'route_code':'Green','color_code':'007C48','Order':'3'},{'route_code':'Brown','color_code':'866D4B','Order':'4'},{'route_code':'Red','color_code':'D71440','Order':'1'},{'route_code':'179','color_code':'944496','Order':'5'},{'route_code':'179A','color_code':'944496','Order':'6'},{'route_code':'199','color_code':'944496','Order':'7'},{'route_code':'default','color_code':'181C62','Order':'8'}]}",
};

const NTU_OMNIBUS_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json; charset=UTF-8',
  'X-CSRFToken': 'T6C+9iB49TLra4jEsMeSckDMNhQ=',
};

function normalizeLtaAccountKey(value) {
  const normalized = String(value || '').trim();

  if (!normalized || normalized === 'replace-with-your-datamall-account-key') {
    return null;
  }

  return normalized;
}

class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/routes', async (_req, res) => {
  try {
    const dataset = await getRouteDataset();
    res.json(publicRouteDataset(dataset));
  } catch (error) {
    handleApiError(res, error);
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    configured: Boolean(LTA_ACCOUNT_KEY),
    routeSource: 'public-busrouter-plus-ntu-omnibus',
    publicLiveSource: LTA_ACCOUNT_KEY ? 'lta-datamall' : 'arrivelah',
    publicArrivalSource: LTA_ACCOUNT_KEY ? 'lta-datamall' : 'arrivelah',
    campusLiveSource: 'ntu-omnibus',
    liveDataAvailable: true,
    liveServices: SERVICES,
    services: SERVICES,
    port: PORT,
  });
});

app.get('/api/arrivals', async (req, res) => {
  try {
    const busStopCode = String(req.query.busStopCode || '').trim();

    if (!busStopCode) {
      throw new ApiError(400, 'Select a stop before requesting live arrival timings.');
    }

    const dataset = await getRouteDataset();
    const stopMeta = dataset.stopLookup[busStopCode];

    if (!stopMeta) {
      throw new ApiError(404, `Stop ${busStopCode} is not part of the NTU route map.`);
    }

    if (!stopMeta.services.some((serviceNo) => LIVE_SERVICE_SET.has(serviceNo))) {
      throw new ApiError(501, 'Live arrivals are not available for the selected stop.');
    }

    const response = await getArrivalResponse(busStopCode, stopMeta);
    res.json(response);
  } catch (error) {
    handleApiError(res, error);
  }
});

app.get('/api/vehicles', async (_req, res) => {
  try {
    const dataset = await getRouteDataset();
    const [publicVehicles, campusVehicles] = await Promise.all([
      collectPublicVehicles(dataset),
      collectCampusVehicles(dataset),
    ]);

    res.json({
      updatedAt: new Date().toISOString(),
      vehicles: [...publicVehicles, ...campusVehicles].sort(
        (left, right) =>
          left.serviceNo.localeCompare(right.serviceNo) ||
          String(left.id).localeCompare(String(right.id))
      ),
    });
  } catch (error) {
    handleApiError(res, error);
  }
});

app.get('/api/rooms/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    const limit = clampInteger(req.query.limit, 1, 10, 8);

    if (query.length < 2) {
      throw new ApiError(400, 'Enter at least 2 characters to search NTU rooms.');
    }

    const response = await searchNtuRooms(query, {
      limit,
    });

    res.json({
      query,
      updatedAt: new Date().toISOString(),
      ...response,
    });
  } catch (error) {
    handleApiError(res, error);
  }
});

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (isDirectRun()) {
  app.listen(PORT, () => {
    console.log(`NTU Live Bus Map listening on http://localhost:${PORT}`);
  });
}

export default app;

async function getRouteDataset() {
  const cacheAge = Date.now() - routeCache.fetchedAt;

  if (routeCache.data && cacheAge < STATIC_CACHE_TTL_MS) {
    return routeCache.data;
  }

  if (routeCache.pending) {
    return routeCache.pending;
  }

  routeCache.pending = hydrateRouteDataset()
    .then((dataset) => {
      routeCache.data = dataset;
      routeCache.fetchedAt = Date.now();
      return dataset;
    })
    .finally(() => {
      routeCache.pending = null;
    });

  return routeCache.pending;
}

async function searchNtuRooms(query, { limit = 8 } = {}) {
  const exactMatches = await searchNtuRoomsByIdentifier(query);

  if (exactMatches.length) {
    return {
      source: 'identifier',
      results: exactMatches.slice(0, limit).map(publicRoomSearchResult),
    };
  }

  const roomIndex = await getNtuRoomIndex();

  return {
    source: 'indexed',
    results: fuzzySearchNtuRooms(roomIndex, query, limit).map(publicRoomSearchResult),
  };
}

async function searchNtuRoomsByIdentifier(query) {
  const variants = buildRoomIdentifierVariants(query);
  const matches = [];
  const seen = new Set();

  for (const identifier of variants) {
    const responses = await Promise.all(
      NTU_ROOM_SEARCH_CAMPUSES.map(async (campusConfig) => {
        try {
          const payload = await fetchMazeMapPois({
            campusId: campusConfig.campusId,
            identifier,
            srid: 4326,
          });

          return normalizeMazeMapRoomPois(payload?.pois, campusConfig, {
            allowAllKinds: true,
          });
        } catch {
          return [];
        }
      })
    );

    for (const room of responses.flat()) {
      if (seen.has(room.id)) {
        continue;
      }

      seen.add(room.id);
      matches.push(room);
    }

    if (matches.length) {
      break;
    }
  }

  return matches.sort(compareRoomResults);
}

async function getNtuRoomIndex() {
  const cacheAge = Date.now() - roomIndexCache.fetchedAt;

  if (roomIndexCache.data && cacheAge < ROOM_INDEX_CACHE_TTL_MS) {
    return roomIndexCache.data;
  }

  if (roomIndexCache.pending) {
    return roomIndexCache.pending;
  }

  roomIndexCache.pending = hydrateNtuRoomIndex()
    .then((roomIndex) => {
      roomIndexCache.data = roomIndex;
      roomIndexCache.fetchedAt = Date.now();
      return roomIndex;
    })
    .finally(() => {
      roomIndexCache.pending = null;
    });

  return roomIndexCache.pending;
}

async function hydrateNtuRoomIndex() {
  const campusIndexes = await Promise.all(
    NTU_ROOM_SEARCH_CAMPUSES.map((campusConfig) => hydrateNtuRoomCampusIndex(campusConfig))
  );

  return dedupeRooms(campusIndexes.flat()).sort(compareRoomResults);
}

async function hydrateNtuRoomCampusIndex(campusConfig) {
  const rooms = [];
  let fromId = 0;
  let previousCursor = null;

  for (let pageNumber = 0; pageNumber < campusConfig.maxPages; pageNumber += 1) {
    const payload = await fetchMazeMapPois({
      campusId: campusConfig.campusId,
      fromId: fromId || undefined,
      srid: 4326,
    });
    const pois = Array.isArray(payload?.pois) ? payload.pois : [];
    const lastPoiId = Number(pois.at(-1)?.poiId);
    const pageLimit = Number(payload?.limit) || MAZEMAP_POI_PAGE_LIMIT;

    rooms.push(...normalizeMazeMapRoomPois(pois, campusConfig));

    if (
      !pois.length ||
      pois.length < pageLimit ||
      !Number.isFinite(lastPoiId) ||
      lastPoiId === fromId ||
      lastPoiId === previousCursor
    ) {
      break;
    }

    previousCursor = fromId;
    fromId = lastPoiId;
  }

  return dedupeRooms(rooms);
}

function fuzzySearchNtuRooms(roomIndex, query, limit) {
  const queryProfile = buildRoomQueryProfile(query);

  return roomIndex
    .map((room) => ({
      room,
      score: scoreRoomMatch(room, queryProfile),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || compareRoomResults(left.room, right.room))
    .slice(0, limit)
    .map((entry) => entry.room);
}

function scoreRoomMatch(room, queryProfile) {
  const { compactVariants, normalizedVariants, numericTokens, prefersLectureTheatre, prefersTutorialRooms, tokenMatches } =
    queryProfile;
  let score = 0;
  let matchedTokens = 0;

  if (matchesSearchVariants(room.search.identifierCompact, compactVariants, (value, variant) => value === variant)) {
    score += 2600;
  }

  if (matchesSearchVariants(room.search.title, normalizedVariants, (value, variant) => value === variant)) {
    score += 2300;
  }

  if (matchesSearchVariants(room.search.titleCompact, compactVariants, (value, variant) => value === variant)) {
    score += 2100;
  }

  if (
    matchesSearchVariants(room.search.identifierCompact, compactVariants, (value, variant) =>
      value.startsWith(variant)
    )
  ) {
    score += 1700;
  }

  if (
    matchesSearchVariants(room.search.titleIndexed, normalizedVariants, (value, variant) =>
      value.includes(variant)
    )
  ) {
    score += 1450;
  }

  if (matchesSearchVariants(room.search.full, normalizedVariants, (value, variant) => value.includes(variant))) {
    score += 950;
  }

  if (
    matchesSearchVariants(room.search.titleIndexedCompact, compactVariants, (value, variant) =>
      value.includes(variant)
    )
  ) {
    score += 920;
  }

  if (matchesSearchVariants(room.search.fullCompact, compactVariants, (value, variant) => value.includes(variant))) {
    score += 880;
  }

  if (
    numericTokens.length &&
    room.search.tutorialRoomNumbers.some((roomNumber) => numericTokens.includes(roomNumber)) &&
    !prefersLectureTheatre
  ) {
    score += prefersTutorialRooms ? 2600 : 1800;
  }

  for (const token of tokenMatches) {
    let tokenMatched = false;

    if (token.compact && room.search.identifierCompact.includes(token.compact)) {
      score += 340;
      tokenMatched = true;
    }

    if (token.text && room.search.title.includes(token.text)) {
      score += 240;
      tokenMatched = true;
    }

    if (token.text && room.search.building.includes(token.text)) {
      score += 90;
      tokenMatched = true;
    }

    if (token.text && room.search.campus.includes(token.text)) {
      score += 50;
      tokenMatched = true;
    }

    if (tokenMatched) {
      matchedTokens += 1;
    }
  }

  if (!score) {
    return 0;
  }

  if (tokenMatches.length > 1 && matchedTokens === 0) {
    return 0;
  }

  if (matchedTokens === tokenMatches.length && tokenMatches.length > 0) {
    score += 260;
  }

  return score;
}

function normalizeMazeMapRoomPois(pois, campusConfig, { allowAllKinds = false } = {}) {
  return (Array.isArray(pois) ? pois : [])
    .map((poi) => normalizeMazeMapRoom(poi, campusConfig, { allowAllKinds }))
    .filter(Boolean);
}

function normalizeMazeMapRoom(poi, campusConfig, { allowAllKinds = false } = {}) {
  const title = normalizeOptionalText(poi?.title);
  const identifier = normalizeOptionalText(poi?.identifier);
  const buildingName = normalizeOptionalText(poi?.buildingName);
  const floorName = normalizeOptionalText(poi?.floorName);
  const kind = String(poi?.kind || '').trim().toLowerCase();
  const [lng, lat] = Array.isArray(poi?.point?.coordinates) ? poi.point.coordinates : [];

  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
    return null;
  }

  if (!title && !identifier) {
    return null;
  }

  if (!allowAllKinds && !isSearchableMazeMapRoomKind(kind)) {
    return null;
  }

  const displayTitle = title || identifier;
  const tutorialRoomNumbers = extractTutorialRoomNumbers(displayTitle);
  const titleSearchText = normalizeSearchText(displayTitle);
  const titleIndexedText = buildSearchIndexText([displayTitle], {
    includePhraseAliases: true,
  });
  const buildingSearchText = buildSearchIndexText([buildingName], {
    includeAcronyms: true,
  });
  const campusSearchText = buildSearchIndexText([campusConfig.campusName], {
    includeAcronyms: true,
  });
  const fullSearchText = buildSearchIndexText(
    [displayTitle, identifier, buildingName, floorName, campusConfig.campusName],
    {
      includeAcronyms: true,
      includePhraseAliases: true,
    }
  );

  return {
    id: `${campusConfig.campusId}:${poi?.poiId || identifier || displayTitle}`,
    poiId: Number.isFinite(Number(poi?.poiId)) ? Number(poi.poiId) : null,
    campusId: campusConfig.campusId,
    campusName: campusConfig.campusName,
    title: displayTitle,
    identifier,
    buildingName,
    floorName,
    kind,
    lat: Number(lat),
    lng: Number(lng),
    search: {
      building: buildingSearchText,
      campus: campusSearchText,
      full: fullSearchText,
      fullCompact: normalizeCompactSearchText(fullSearchText),
      identifierCompact: normalizeCompactSearchText(identifier),
      isTutorialRoom: tutorialRoomNumbers.length > 0,
      title: titleSearchText,
      titleCompact: normalizeCompactSearchText(displayTitle),
      titleIndexed: titleIndexedText,
      titleIndexedCompact: normalizeCompactSearchText(titleIndexedText),
      tutorialRoomNumbers,
    },
  };
}

function isSearchableMazeMapRoomKind(kind) {
  return kind === 'room' || kind === 'generic';
}

function publicRoomSearchResult(room) {
  return {
    id: room.id,
    campusId: room.campusId,
    campusName: room.campusName,
    title: room.title,
    identifier: room.identifier,
    buildingName: room.buildingName,
    floorName: room.floorName,
    lat: room.lat,
    lng: room.lng,
  };
}

function buildRoomIdentifierVariants(query) {
  const trimmed = String(query || '').trim();

  return Array.from(
    new Set(
      [
        trimmed,
        trimmed.toUpperCase(),
        trimmed.replace(/[\s_]+/g, '-'),
        trimmed.replace(/[\s_-]+/g, ''),
      ].filter((value) => value.length >= 2)
    )
  );
}

function buildRoomQueryProfile(query) {
  const normalizedVariants = Array.from(
    new Set(
      buildSearchVariants(query, {
        includePhraseAliases: true,
      })
    )
  )
    .filter(Boolean)
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  const compactVariants = Array.from(
    new Set(normalizedVariants.map((variant) => normalizeCompactSearchText(variant)).filter(Boolean))
  ).sort((left, right) => right.length - left.length || left.localeCompare(right));
  const tokenMatches = Array.from(
    new Set(
      normalizedVariants.flatMap((variant) =>
        variant
          .split(' ')
          .map((token) => token.trim())
          .filter(Boolean)
      )
    )
  ).map((token) => ({
    compact: normalizeCompactSearchText(token),
    text: token,
  }));
  const numericTokens = extractNumberTokens(query);
  const tokenSet = new Set(tokenMatches.map((token) => token.text));

  return {
    compactVariants,
    normalizedVariants,
    numericTokens,
    prefersLectureTheatre: tokenSet.has('lt') || normalizedVariants.some((variant) => variant.includes('lecture theatre')),
    prefersTutorialRooms: tokenSet.has('tr') || normalizedVariants.some((variant) => variant.includes('tutorial room')),
    tokenMatches,
  };
}

function buildSearchIndexText(values, { includeAcronyms = false, includePhraseAliases = false } = {}) {
  const variants = new Set();

  for (const value of Array.isArray(values) ? values : [values]) {
    for (const variant of buildSearchVariants(value, { includeAcronyms, includePhraseAliases })) {
      variants.add(variant);
    }
  }

  return Array.from(variants).join(' ').trim();
}

function buildSearchVariants(value, { includeAcronyms = false, includePhraseAliases = false } = {}) {
  const normalized = normalizeSearchText(value);

  if (!normalized) {
    return [];
  }

  const variants = new Set([normalized]);

  if (includePhraseAliases) {
    for (const variant of buildPhraseAliasVariants(normalized)) {
      variants.add(variant);
    }
  }

  if (includeAcronyms) {
    for (const variant of buildAcronymVariants(normalized)) {
      variants.add(variant);
    }
  }

  return Array.from(variants);
}

function buildPhraseAliasVariants(normalizedValue) {
  const variants = new Set([normalizedValue]);

  for (const alias of ROOM_SEARCH_PHRASE_ALIASES) {
    variants.add(replaceNormalizedPhrase(normalizedValue, alias.longForm, alias.shortForm));
    variants.add(replaceNormalizedPhrase(normalizedValue, alias.shortForm, alias.longForm));
  }

  return Array.from(variants).filter(Boolean);
}

function buildAcronymVariants(normalizedValue) {
  const rawWords = normalizedValue
    .split(' ')
    .map((token) => normalizeSearchToken(token))
    .filter(Boolean);
  const significantWords = rawWords.filter((token) => !ROOM_SEARCH_ACRONYM_STOPWORDS.has(token));
  const variants = new Set();

  for (const words of [significantWords, rawWords]) {
    if (words.length < 2) {
      continue;
    }

    for (let start = 0; start < words.length; start += 1) {
      for (let length = 2; length <= Math.min(5, words.length - start); length += 1) {
        const acronym = words
          .slice(start, start + length)
          .map((word) => word[0])
          .join('');

        if (acronym.length < 2) {
          continue;
        }

        for (let prefixLength = 2; prefixLength <= acronym.length; prefixLength += 1) {
          variants.add(acronym.slice(0, prefixLength));
        }
      }
    }
  }

  return Array.from(variants);
}

function replaceNormalizedPhrase(value, source, target) {
  if (!value || !source || !target) {
    return '';
  }

  return value
    .replace(new RegExp(`(^| )${escapeRegex(source)}(?= |$)`, 'g'), (_, prefix) => `${prefix}${target}`)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSearchToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function extractNumberTokens(value) {
  return Array.from(
    new Set(
      String(value || '')
        .match(/\d+/g)
        ?.map((token) => normalizeNumericToken(token))
        .filter(Boolean) || []
    )
  );
}

function extractTutorialRoomNumbers(value) {
  return Array.from(
    new Set(
      Array.from(String(value || '').matchAll(/tutorial room\s*\+\s*(\d+)/gi))
        .map((match) => normalizeNumericToken(match[1]))
        .filter(Boolean)
    )
  );
}

function normalizeNumericToken(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/^0+(?=\d)/, '');

  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function matchesSearchVariants(value, variants, matcher) {
  if (!value || !Array.isArray(variants) || !variants.length) {
    return false;
  }

  return variants.some((variant) => variant && matcher(value, variant));
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSearchText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function normalizeCompactSearchText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeOptionalText(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function compareRoomResults(left, right) {
  return (
    String(left.campusName || '').localeCompare(String(right.campusName || '')) ||
    String(left.buildingName || '').localeCompare(String(right.buildingName || '')) ||
    String(left.floorName || '').localeCompare(String(right.floorName || '')) ||
    String(left.identifier || '').localeCompare(String(right.identifier || '')) ||
    String(left.title || '').localeCompare(String(right.title || ''))
  );
}

function dedupeRooms(rooms) {
  const roomLookup = new Map();

  for (const room of rooms) {
    if (!roomLookup.has(room.id)) {
      roomLookup.set(room.id, room);
    }
  }

  return Array.from(roomLookup.values());
}

async function hydrateRouteDataset() {
  const [geometryIndex, campusDataset] = await Promise.all([
    getPublicRouteGeometryIndex(),
    hydrateCampusDataset(),
  ]);
  const publicDataset = await hydrateFallbackRouteDataset(geometryIndex);

  return mergeRouteDatasets(publicDataset, campusDataset);
}

async function hydrateCampusDataset() {
  try {
    return await hydrateOfficialCampusDataset();
  } catch (error) {
    console.warn('Falling back to static NTU campus shuttle dataset:', error.message);
    return hydrateCampusShuttleDataset();
  }
}

function hydrateCampusShuttleDataset() {
  const stopMembership = new Map();

  for (const [serviceNo, service] of Object.entries(ntuCampusShuttleSource.services)) {
    for (const [stopCode] of service.stops) {
      if (!stopMembership.has(stopCode)) {
        stopMembership.set(stopCode, new Set());
      }

      stopMembership.get(stopCode).add(serviceNo);
    }
  }

  const stops = Object.entries(ntuCampusShuttleSource.stops)
    .map(([stopCode, stop]) => ({
      code: stopCode,
      ...stop,
      services: Array.from(stopMembership.get(stopCode) || []).sort(
        (left, right) => SERVICES.indexOf(left) - SERVICES.indexOf(right)
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const services = Object.fromEntries(
    Object.entries(ntuCampusShuttleSource.services).map(([serviceNo, service]) => [
      serviceNo,
      {
        color: service.color,
        title: service.title,
        shortLabel: service.shortLabel,
        operates: service.operates,
        summary: service.summary,
        frequencies: service.frequencies,
        directions: [
          {
            direction: 1,
            path: decodePolyline(service.path),
            stops: service.stops.map(([stopCode, label, firstBusTime], index) => {
              const stop = ntuCampusShuttleSource.stops[stopCode];

              return {
                code: stopCode,
                name: stop.name,
                roadName: stop.roadName,
                lat: stop.lat,
                lng: stop.lng,
                label,
                firstBusTime,
                stopSequence: index + 1,
                distanceKm: null,
              };
            }),
          },
        ],
      },
    ])
  );

  const publicStopLookup = Object.fromEntries(stops.map((stop) => [stop.code, stop]));

  return {
    generatedAt: ntuCampusShuttleSource.generatedAt,
    center: ntuCampusShuttleSource.center,
    zoom: ntuCampusShuttleSource.zoom,
    source: ntuCampusShuttleSource.source,
    services,
    stops,
    stopLookup: publicStopLookup,
  };
}

async function hydrateOfficialCampusDataset() {
  const fallbackCampusDataset = hydrateCampusShuttleDataset();
  const campusServices = await Promise.all(
    CAMPUS_SHUTTLE_SERVICES.map(async (serviceNo) => {
      const checkpointPayload = await fetchCampusOmnibusPickupCheckPoints(serviceNo);
      return normalizeOfficialCampusService(serviceNo, checkpointPayload, fallbackCampusDataset);
    })
  );
  const stopsByCode = new Map();
  const services = Object.fromEntries(
    campusServices.map(({ serviceNo, service }) => [serviceNo, service])
  );

  for (const { stops } of campusServices) {
    for (const stop of stops) {
      const existing = stopsByCode.get(stop.code);

      if (!existing) {
        stopsByCode.set(stop.code, {
          ...stop,
          services: [...stop.services],
          omnibusCodes: { ...(stop.omnibusCodes || {}) },
        });
        continue;
      }

      existing.services = Array.from(new Set([...existing.services, ...stop.services])).sort(
        (left, right) => SERVICES.indexOf(left) - SERVICES.indexOf(right)
      );
      existing.omnibusCodes = {
        ...(existing.omnibusCodes || {}),
        ...(stop.omnibusCodes || {}),
      };
    }
  }

  const stops = Array.from(stopsByCode.values()).sort((left, right) => left.name.localeCompare(right.name));

  if (!stops.length) {
    throw new ApiError(502, 'The NTU Omnibus route feed returned no campus shuttle stops.');
  }

  return {
    generatedAt: new Date().toISOString(),
    center: ntuCampusShuttleSource.center,
    zoom: ntuCampusShuttleSource.zoom,
    source: 'ntu-omnibus',
    services,
    stops,
    stopLookup: Object.fromEntries(stops.map((stop) => [stop.code, stop])),
  };
}

function normalizeOfficialCampusService(serviceNo, checkpointPayload, fallbackCampusDataset) {
  const fallbackService = fallbackCampusDataset.services?.[serviceNo] || ntuCampusShuttleSource.services[serviceNo];
  const checkpointList =
    checkpointPayload?.data?.CheckPoint?.CheckPointResult?.CheckPoint?.List ||
    checkpointPayload?.data?.Response?.CheckPoint?.CheckPointResult?.CheckPoint?.List ||
    [];
  const pickupPointList =
    checkpointPayload?.data?.PickupPoints?.PickupPointResult?.Pickuppoint?.List ||
    checkpointPayload?.data?.Response?.PickupPoints?.PickupPointResult?.Pickuppoint?.List ||
    [];
  const path = checkpointList
    .map((point) => normalizeCoordinatePair(point?.Latitude || point?.Lat, point?.Longitude || point?.Lng))
    .filter(Boolean);
  const stops = pickupPointList.map((pickupPoint, index) =>
    normalizeOfficialCampusStop(serviceNo, pickupPoint, index)
  );

  if (!stops.length) {
    throw new ApiError(502, `NTU Omnibus returned no pickup points for ${serviceNo}.`);
  }

  return {
    serviceNo,
    service: {
      color: SERVICE_COLORS[serviceNo],
      title: fallbackService?.title || serviceNo,
      shortLabel: fallbackService?.shortLabel || CAMPUS_OMNIBUS_ROUTE_MAP[serviceNo].routeName,
      operates: 'Live via NTU Omnibus',
      summary: fallbackService?.summary || null,
      frequencies: fallbackService?.frequencies || [],
      directions: [
        {
          direction: 1,
          path: path.length ? path : stops.map((stop) => [stop.lat, stop.lng]),
          stops: stops.map((stop, index) => ({
            code: stop.code,
            name: stop.name,
            roadName: stop.roadName,
            lat: stop.lat,
            lng: stop.lng,
            label: stop.name,
            firstBusTime: null,
            stopSequence: index + 1,
            distanceKm: null,
          })),
        },
      ],
    },
    stops,
  };
}

function normalizeOfficialCampusStop(serviceNo, pickupPoint, index) {
  const rawCode = String(
    pickupPoint?.Busstopcode || pickupPoint?.Pickupname || pickupPoint?.ShortName || `${serviceNo}-${index + 1}`
  ).trim();
  const rawName = String(pickupPoint?.ShortName || pickupPoint?.Pickupname || rawCode).trim();
  const rawLat = Number(pickupPoint?.Lat);
  const rawLng = Number(pickupPoint?.Lng);
  const matchedStop = resolveCampusStopReference(rawName, rawLat, rawLng);
  const lat = Number.isFinite(rawLat) ? rawLat : matchedStop?.lat;
  const lng = Number.isFinite(rawLng) ? rawLng : matchedStop?.lng;

  return {
    code: rawCode,
    name: matchedStop?.matchedByName ? matchedStop.name : rawName,
    roadName: matchedStop?.roadName || '',
    lat,
    lng,
    displayCode: null,
    services: [serviceNo],
    omnibusCodes: {
      [serviceNo]: rawCode,
    },
  };
}

function resolveCampusStopReference(name, lat, lng) {
  const normalizedName = normalizeCampusStopName(name);
  const fallbackStops = Object.values(ntuCampusShuttleSource.stops);
  const exactNameMatch = fallbackStops.find((stop) => normalizeCampusStopName(stop.name) === normalizedName);

  if (exactNameMatch) {
    return {
      ...exactNameMatch,
      matchedByName: true,
    };
  }

  let nearestStop = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const stop of fallbackStops) {
    const distance = getDistanceMeters(lat, lng, stop.lat, stop.lng);

    if (distance < nearestDistance) {
      nearestStop = stop;
      nearestDistance = distance;
    }
  }

  if (nearestStop && nearestDistance <= 150) {
    return {
      ...nearestStop,
      matchedByName: false,
    };
  }

  return null;
}

function normalizeCampusStopName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\bblk\b/g, 'block')
    .replace(/\bny\b/g, 'nanyang')
    .replace(/\bcres\b/g, 'crescent')
    .replace(/\bopp\b/g, 'opposite')
    .replace(/\bgardens\b/g, 'garden')
    .replace(/\bgdn\b/g, 'garden')
    .replace(/\bhalls\b/g, 'hall')
    .replace(/\blib\b/g, 'library')
    .replace(/\bsch\b/g, 'school')
    .replace(/\s+of\s+/g, ' ')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function mergeRouteDatasets(publicDataset, campusDataset) {
  const stopsByCode = new Map();

  for (const stop of [...publicDataset.stops, ...campusDataset.stops]) {
    const existing = stopsByCode.get(stop.code);

    if (!existing) {
      stopsByCode.set(stop.code, {
        ...stop,
        services: [...stop.services],
        omnibusCodes: stop.omnibusCodes ? { ...stop.omnibusCodes } : undefined,
      });
      continue;
    }

    existing.services = Array.from(new Set([...existing.services, ...stop.services])).sort(
      (left, right) => SERVICES.indexOf(left) - SERVICES.indexOf(right)
    );
    existing.omnibusCodes = {
      ...(existing.omnibusCodes || {}),
      ...(stop.omnibusCodes || {}),
    };
  }

  const stops = Array.from(stopsByCode.values()).sort((left, right) => left.name.localeCompare(right.name));

  return {
    generatedAt: new Date().toISOString(),
    center: NTU_VIEW.center,
    zoom: NTU_VIEW.zoom,
    source: 'combined',
    services: {
      ...publicDataset.services,
      ...campusDataset.services,
    },
    stops,
    stopLookup: Object.fromEntries(stops.map((stop) => [stop.code, stop])),
  };
}

async function hydrateFallbackRouteDataset(geometryIndex) {
  const [serviceIndex, stopIndex] = await Promise.all([
    fetchPublicJson(`${BUSROUTER_BASE_URL}/services.min.json`),
    fetchPublicJson(`${BUSROUTER_BASE_URL}/stops.min.json`),
  ]);

  const stopServices = new Map();

  const services = Object.fromEntries(
    PUBLIC_BUS_SERVICES.map((serviceNo) => {
      const service = serviceIndex?.[serviceNo];

      if (!service) {
        return [
          serviceNo,
          {
            color: SERVICE_COLORS[serviceNo],
            directions: [],
          },
        ];
      }

      const directions = (service.routes || []).map((routeStops, index) => {
        const stops = routeStops
          .map((stopCode, stopIndexWithinRoute) => {
            const stop = stopIndex?.[stopCode];

            if (!stop) {
              return null;
            }

            if (!stopServices.has(stopCode)) {
              stopServices.set(stopCode, new Set());
            }

            stopServices.get(stopCode).add(serviceNo);

            return {
              code: stopCode,
              name: stop[2],
              roadName: stop[3],
              lat: Number(stop[1]),
              lng: Number(stop[0]),
              stopSequence: stopIndexWithinRoute + 1,
              distanceKm: null,
              firstBus: null,
              lastBus: null,
            };
          })
          .filter(Boolean);

        return {
          direction: index + 1,
          path: geometryIndex?.[serviceNo]?.[index] || stops.map((stop) => [stop.lat, stop.lng]),
          stops,
        };
      });

      return [
        serviceNo,
        {
          color: SERVICE_COLORS[serviceNo],
          title: `Bus ${serviceNo}`,
          shortLabel: serviceNo,
          operates: 'Live public bus',
          directions,
        },
      ];
    })
  );

  const uniqueStopCodes = new Set(
    Object.values(services).flatMap((service) =>
      service.directions.flatMap((direction) => direction.stops.map((stop) => stop.code))
    )
  );

  const stops = Array.from(uniqueStopCodes)
    .map((stopCode) => {
      const stop = stopIndex?.[stopCode];

      if (!stop) {
        return null;
      }

      return {
        code: stopCode,
        name: stop[2],
        roadName: stop[3],
        lat: Number(stop[1]),
        lng: Number(stop[0]),
        services: Array.from(stopServices.get(stopCode) || []).sort(),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));

  if (!stops.length) {
    throw new ApiError(502, 'The fallback route dataset could not be loaded.');
  }

  const publicStopLookup = Object.fromEntries(stops.map((stop) => [stop.code, stop]));

  return {
    generatedAt: new Date().toISOString(),
    center: NTU_VIEW.center,
    zoom: NTU_VIEW.zoom,
    source: 'public-fallback',
    services,
    stops,
    stopLookup: publicStopLookup,
  };
}

async function fetchPagedDataset(pathname) {
  const combined = [];

  for (let skip = 0; ; skip += PAGE_SIZE) {
    const payload = await fetchDatamallJson(pathname, {
      $skip: String(skip),
    });

    const rows = Array.isArray(payload?.value) ? payload.value : [];
    combined.push(...rows);

    if (rows.length < PAGE_SIZE) {
      break;
    }
  }

  return combined;
}

async function fetchDatamallJson(pathname, query = {}) {
  const url = new URL(`${LTA_BASE_URL}${pathname}`);

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  let response;

  try {
    response = await fetch(url, {
      headers: {
        AccountKey: LTA_ACCOUNT_KEY,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ApiError(
        504,
        'LTA DataMall took too long to respond. Please try again in a moment.'
      );
    }

    throw new ApiError(
      502,
      'The app could not reach LTA DataMall right now. Please try again shortly.',
      String(error)
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new ApiError(
      response.status,
      'LTA DataMall could not fulfil the request right now. Please try again in a moment.',
      body.slice(0, 300)
    );
  }

  return response.json();
}

async function fetchArriveLahJson(busStopCode) {
  const url = new URL(ARRIVELAH_BASE_URL);
  url.searchParams.set('id', busStopCode);

  let response;

  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ApiError(504, 'ArriveLah took too long to respond. Please try again in a moment.');
    }

    throw new ApiError(502, 'The app could not reach ArriveLah right now.', String(error));
  }

  if (!response.ok) {
    const body = await response.text();
    throw new ApiError(
      response.status,
      'ArriveLah could not fulfil the request right now. Please try again in a moment.',
      body.slice(0, 300)
    );
  }

  return response.json();
}

async function fetchPublicJson(url) {
  let response;

  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ApiError(504, 'The public fallback dataset took too long to respond.');
    }

    throw new ApiError(502, 'The public fallback dataset could not be reached.', String(error));
  }

  if (!response.ok) {
    throw new ApiError(
      502,
      'The public fallback dataset could not be loaded right now.',
      `${response.status} ${response.statusText}`
    );
  }

  return response.json();
}

async function fetchMazeMapPois({ campusId, identifier, fromId, poiIds, srid = 4326 } = {}) {
  const url = new URL('/api/pois/', MAZEMAP_API_BASE_URL);

  if (Number.isFinite(Number(campusId))) {
    url.searchParams.set('campusid', String(campusId));
  }

  if (identifier) {
    url.searchParams.set('identifier', String(identifier).trim());
  }

  if (Number.isFinite(Number(fromId)) && Number(fromId) > 0) {
    url.searchParams.set('fromid', String(Number(fromId)));
  }

  if (Array.isArray(poiIds) && poiIds.length) {
    url.searchParams.set('poiids', poiIds.join(','));
  }

  if (Number.isFinite(Number(srid))) {
    url.searchParams.set('srid', String(Number(srid)));
  }

  let response;

  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(Math.max(UPSTREAM_TIMEOUT_MS * 6, 30_000)),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ApiError(504, 'MazeMap took too long to respond while loading NTU room data.');
    }

    throw new ApiError(502, 'The app could not reach MazeMap right now.', String(error));
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new ApiError(
      response.status,
      'MazeMap could not fulfil the NTU room request right now.',
      detail.slice(0, 300)
    );
  }

  return response.json();
}

async function fetchCampusOmnibusPickupCheckPoints(serviceNo) {
  const routeConfig = CAMPUS_OMNIBUS_ROUTE_MAP[serviceNo];

  if (!routeConfig) {
    throw new ApiError(500, `No NTU Omnibus mapping is defined for ${serviceNo}.`);
  }

  return fetchNtuOmnibusJson(
    '/screenservices/CampusShuttle_MUI/MainFlow/RenderMap/DataActionGetPickupCheckPoints',
    NTU_OMNIBUS_API.pickupCheckPoints,
    buildCampusOmnibusRoutePayload(serviceNo)
  );
}

async function fetchCampusOmnibusVehicles(serviceNo) {
  const routeConfig = CAMPUS_OMNIBUS_ROUTE_MAP[serviceNo];

  if (!routeConfig) {
    throw new ApiError(500, `No NTU Omnibus mapping is defined for ${serviceNo}.`);
  }

  return fetchNtuOmnibusJson(
    '/screenservices/CampusShuttle_MUI/MainFlow/RenderMap/DataActionGetActiveBusServicesData',
    NTU_OMNIBUS_API.activeBusServicesData,
    buildCampusOmnibusRoutePayload(serviceNo)
  );
}

async function fetchCampusOmnibusEta(busStopCode, serviceNo) {
  const routeConfig = CAMPUS_OMNIBUS_ROUTE_MAP[serviceNo];

  if (!routeConfig) {
    throw new ApiError(500, `No NTU Omnibus mapping is defined for ${serviceNo}.`);
  }

  return fetchNtuOmnibusJson(
    '/screenservices/CampusShuttle_MUI/ActionGetETAAndNextETA_FMS',
    NTU_OMNIBUS_API.eta,
    {
      inputParameters: {
        BusStopCode: busStopCode,
        RouteCode: routeConfig.routeName,
      },
    }
  );
}

function buildCampusOmnibusRoutePayload(serviceNo) {
  const routeConfig = CAMPUS_OMNIBUS_ROUTE_MAP[serviceNo];

  return {
    screenData: {
      variables: {
        RouteId: routeConfig.routeName,
        IsSBS_Route: false,
        CurrDateTime_Local: formatSingaporeDateTime(new Date()),
        RouteColorCode: routeConfig.routeColorCode,
        RouteName: routeConfig.routeName,
        UserCurrLat: String(NTU_VIEW.center.lat),
        _userCurrLatInDataFetchStatus: 1,
        UserCurrLng: String(NTU_VIEW.center.lng),
        _userCurrLngInDataFetchStatus: 1,
        CurrDateTime: '1900-01-01T00:00:00',
        _currDateTimeInDataFetchStatus: 1,
        CheckIsScreenActive: true,
        _checkIsScreenActiveInDataFetchStatus: 1,
        IsRenderMapActive: true,
        _isRenderMapActiveInDataFetchStatus: 1,
      },
    },
    clientVariables: {
      ...NTU_OMNIBUS_CLIENT_VARIABLES,
      SelectedRoute: routeConfig.routeName,
    },
  };
}

async function fetchNtuOmnibusJson(pathname, apiVersion, body, { retry = true } = {}) {
  const moduleVersion = await getNtuOmnibusModuleVersion();
  let response;

  try {
    response = await fetch(resolveNtuOmnibusUrl(pathname), {
      method: 'POST',
      headers: NTU_OMNIBUS_HEADERS,
      body: JSON.stringify({
        versionInfo: {
          moduleVersion,
          apiVersion,
        },
        viewName: 'MapFlow.Shuttle',
        ...body,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ApiError(504, 'NTU Omnibus took too long to respond.');
    }

    throw new ApiError(502, 'The app could not reach NTU Omnibus right now.', String(error));
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new ApiError(
      502,
      'NTU Omnibus could not fulfil the campus shuttle request right now.',
      detail.slice(0, 300)
    );
  }

  const payload = await response.json();
  const versionInfo = payload?.versionInfo || {};

  if (retry && (versionInfo.hasModuleVersionChanged || versionInfo.hasApiVersionChanged)) {
    ntuOmnibusModuleVersionCache.value = null;
    ntuOmnibusModuleVersionCache.fetchedAt = 0;
    return fetchNtuOmnibusJson(pathname, apiVersion, body, {
      retry: false,
    });
  }

  if (versionInfo.hasApiVersionChanged) {
    throw new ApiError(502, 'NTU Omnibus changed its campus shuttle API format.');
  }

  return payload;
}

async function getNtuOmnibusModuleVersion() {
  const cacheAge = Date.now() - ntuOmnibusModuleVersionCache.fetchedAt;

  if (ntuOmnibusModuleVersionCache.value && cacheAge < NTU_OMNIBUS_MODULE_VERSION_TTL_MS) {
    return ntuOmnibusModuleVersionCache.value;
  }

  if (ntuOmnibusModuleVersionCache.pending) {
    return ntuOmnibusModuleVersionCache.pending;
  }

  ntuOmnibusModuleVersionCache.pending = fetchNtuOmnibusModuleVersion()
    .then((moduleVersion) => {
      ntuOmnibusModuleVersionCache.value = moduleVersion;
      ntuOmnibusModuleVersionCache.fetchedAt = Date.now();
      return moduleVersion;
    })
    .finally(() => {
      ntuOmnibusModuleVersionCache.pending = null;
    });

  return ntuOmnibusModuleVersionCache.pending;
}

async function fetchNtuOmnibusModuleVersion() {
  const url = resolveNtuOmnibusUrl('moduleservices/moduleversioninfo?491u8Vf4gA2M4H1K39PJrQ');
  let response;

  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ApiError(504, 'NTU Omnibus version metadata took too long to respond.');
    }

    throw new ApiError(502, 'NTU Omnibus version metadata could not be reached.', String(error));
  }

  if (!response.ok) {
    throw new ApiError(502, 'NTU Omnibus version metadata could not be loaded.');
  }

  const payload = await response.json();
  const moduleVersion = String(payload?.versionToken || '').trim();

  if (!moduleVersion) {
    throw new ApiError(502, 'NTU Omnibus did not return a module version token.');
  }

  return moduleVersion;
}

function resolveNtuOmnibusUrl(pathname) {
  return new URL(String(pathname).replace(/^\/+/, ''), NTU_OMNIBUS_BASE_URL);
}

function formatSingaporeDateTime(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${lookup.day}-${lookup.month}-${lookup.year} ${lookup.hour}:${lookup.minute}:${lookup.second}`;
}

async function getPublicRouteGeometryIndex() {
  const geoJsonIndex = await getPublicGeoJsonRouteGeometryIndex();

  if (geoJsonIndex) {
    return geoJsonIndex;
  }

  const routeIndex = await fetchPublicJson(`${BUSROUTER_BASE_URL}/routes.min.json`);

  return Object.fromEntries(
    PUBLIC_BUS_SERVICES.map((serviceNo) => [
      serviceNo,
      Array.isArray(routeIndex?.[serviceNo])
        ? routeIndex[serviceNo].map((encodedPath) => decodePolyline(encodedPath))
        : [],
    ])
  );
}

async function getPublicGeoJsonRouteGeometryIndex() {
  try {
    const routeCollection = await fetchPublicJson(`${BUSROUTER_BASE_URL}/routes.min.geojson`);
    const features = Array.isArray(routeCollection?.features) ? routeCollection.features : [];
    const geometryIndex = Object.fromEntries(PUBLIC_BUS_SERVICES.map((serviceNo) => [serviceNo, []]));

    for (const feature of features) {
      const serviceNo = String(feature?.properties?.number || '');

      if (!PUBLIC_BUS_SERVICES.includes(serviceNo)) {
        continue;
      }

      const pattern = Number(feature?.properties?.pattern || 0);
      const coordinates = normalizeGeoJsonRouteCoordinates(feature?.geometry);

      if (!coordinates.length) {
        continue;
      }

      geometryIndex[serviceNo][pattern] = coordinates;
    }

    const hasGeometry = PUBLIC_BUS_SERVICES.some((serviceNo) => geometryIndex[serviceNo].length > 0);

    return hasGeometry ? geometryIndex : null;
  } catch {
    return null;
  }
}

function normalizeGeoJsonRouteCoordinates(geometry) {
  if (!geometry) {
    return [];
  }

  if (geometry.type === 'LineString') {
    return geometry.coordinates
      .map((coordinatePair) => normalizeGeoJsonCoordinatePair(coordinatePair))
      .filter(Boolean);
  }

  if (geometry.type === 'MultiLineString') {
    return geometry.coordinates
      .flatMap((segment) => segment.map((coordinatePair) => normalizeGeoJsonCoordinatePair(coordinatePair)))
      .filter(Boolean);
  }

  return [];
}

function normalizeGeoJsonCoordinatePair(coordinatePair) {
  const [lng, lat] = Array.isArray(coordinatePair) ? coordinatePair : [];

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return [lat, lng];
}

function decodePolyline(encodedPath) {
  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encodedPath.length) {
    let result = 0;
    let shift = 0;
    let byte = 0;

    do {
      byte = encodedPath.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;

    do {
      byte = encodedPath.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push([lat / 1e5, lng / 1e5]);
  }

  return coordinates;
}

async function getArrivalResponse(busStopCode, stopMeta) {
  const cacheEntry = arrivalCache.get(busStopCode);
  const cacheAge = cacheEntry ? Date.now() - cacheEntry.fetchedAt : Number.POSITIVE_INFINITY;

  if (cacheEntry?.data && cacheAge < ARRIVAL_CACHE_TTL_MS) {
    return cacheEntry.data;
  }

  if (cacheEntry?.pending) {
    return cacheEntry.pending;
  }

  const pending = fetchMergedArrivalPayload(stopMeta)
    .then((payload) => {
      const response = buildArrivalResponse(busStopCode, stopMeta, payload);

      arrivalCache.set(busStopCode, {
        data: response,
        fetchedAt: Date.now(),
        pending: null,
      });

      return response;
    })
    .catch((error) => {
      if (cacheEntry?.data) {
        return cacheEntry.data;
      }

      throw error;
    })
    .finally(() => {
      const latest = arrivalCache.get(busStopCode);

      if (latest) {
        latest.pending = null;
      }
    });

  arrivalCache.set(busStopCode, {
    data: cacheEntry?.data || null,
    fetchedAt: cacheEntry?.fetchedAt || 0,
    pending,
  });

  return pending;
}

async function fetchMergedArrivalPayload(stopMeta) {
  const publicServices = stopMeta.services.filter((serviceNo) => PUBLIC_LIVE_SERVICE_SET.has(serviceNo));
  const campusServices = stopMeta.services.filter((serviceNo) => CAMPUS_LIVE_SERVICE_SET.has(serviceNo));
  const [publicPayload, campusPayload] = await Promise.all([
    publicServices.length
      ? fetchPublicArrivalPayload(stopMeta, publicServices)
      : Promise.resolve(new Map()),
    campusServices.length ? fetchCampusArrivalPayload(stopMeta, campusServices) : Promise.resolve(new Map()),
  ]);

  return {
    publicPayload,
    campusPayload,
  };
}

async function fetchCampusArrivalPayload(stopMeta, serviceNos) {
  const results = await Promise.all(
    serviceNos.map(async (serviceNo) => {
      try {
        const upstreamStopCode = stopMeta.omnibusCodes?.[serviceNo] || stopMeta.code;
        const payload = await fetchCampusOmnibusEta(upstreamStopCode, serviceNo);

        return [
          serviceNo,
          {
            operator: 'NTU Omnibus',
            upcomingBuses: normalizeCampusUpcomingBuses(payload?.data),
            message: null,
          },
        ];
      } catch (error) {
        return [
          serviceNo,
          {
            operator: 'NTU Omnibus',
            upcomingBuses: [],
            message:
              error instanceof ApiError
                ? error.message
                : 'Campus shuttle timings could not be loaded right now.',
          },
        ];
      }
    })
  );

  return new Map(results);
}

async function fetchPublicArrivalPayload(stopMeta, serviceNos) {
  if (LTA_ACCOUNT_KEY) {
    const payload = await fetchDatamallJson('/v3/BusArrival', {
      BusStopCode: stopMeta.code,
    });

    return normalizeDatamallArrivalPayload(payload, serviceNos);
  }

  const payload = await fetchArriveLahJson(stopMeta.code);
  return normalizeArriveLahArrivalPayload(payload, serviceNos);
}

function normalizeDatamallArrivalPayload(payload, serviceNos) {
  const serviceLookup = new Map(
    (Array.isArray(payload?.Services) ? payload.Services : [])
      .filter((entry) => PUBLIC_BUS_SERVICES.includes(String(entry.ServiceNo)))
      .map((entry) => [String(entry.ServiceNo), entry])
  );

  return new Map(
    serviceNos.map((serviceNo) => {
      const service = serviceLookup.get(serviceNo);
      return [
        serviceNo,
        {
          operator: service?.Operator || null,
          upcomingBuses: [service?.NextBus, service?.NextBus2, service?.NextBus3]
            .map((bus, index) => normalizeNextBus(bus || null, index + 1))
            .filter(Boolean),
          message: null,
        },
      ];
    })
  );
}

function normalizeArriveLahArrivalPayload(payload, serviceNos) {
  const serviceLookup = new Map(
    (Array.isArray(payload?.services) ? payload.services : [])
      .filter((entry) => PUBLIC_BUS_SERVICES.includes(String(entry?.no)))
      .map((entry) => [String(entry.no), entry])
  );

  return new Map(
    serviceNos.map((serviceNo) => {
      const service = serviceLookup.get(serviceNo);
      return [
        serviceNo,
        {
          operator: service?.operator || 'ArriveLah',
          upcomingBuses: normalizeArriveLahUpcomingBuses(service),
          message: null,
        },
      ];
    })
  );
}

function buildArrivalResponse(busStopCode, stopMeta, payload) {
  const publicLiveServices = payload?.publicPayload || new Map();
  const campusLiveServices = payload?.campusPayload || new Map();

  const services = SERVICES.map((serviceNo) => {
    const servesStop = stopMeta.services.includes(serviceNo);
    const campusService = campusLiveServices.get(serviceNo);
    const publicService = publicLiveServices.get(serviceNo);
    const upcomingBuses = servesStop
      ? campusService
        ? campusService.upcomingBuses
        : publicService?.upcomingBuses || []
      : [];

    return {
      serviceNo,
      color: SERVICE_COLORS[serviceNo],
      servesStop,
      nextBus: upcomingBuses[0] || null,
      upcomingBuses,
      operator: campusService?.operator || publicService?.operator || null,
      message: servesStop
        ? upcomingBuses.length
          ? null
          : campusService?.message || publicService?.message || 'No live estimate is available right now.'
        : 'This route does not serve the selected stop.',
    };
  });

  return {
    busStopCode,
    stopName: stopMeta.name,
    roadName: stopMeta.roadName,
    updatedAt: new Date().toISOString(),
    services,
  };
}

function normalizeCampusUpcomingBuses(payload) {
  const values = [payload?.ETA, payload?.NextETA];

  return values
    .map((value, index) => normalizeCampusEtaBus(value, index + 1))
    .filter(Boolean);
}

function normalizeArriveLahUpcomingBuses(service) {
  const candidates = [
    service?.next,
    service?.subsequent,
    service?.next2,
    service?.next3,
  ];
  const seen = new Set();

  return candidates
    .map((bus, index) => normalizeArriveLahBus(bus, index + 1))
    .filter((bus) => {
      if (!bus) {
        return false;
      }

      const dedupeKey = [
        bus.estimatedArrival,
        Number.isFinite(bus.lat) ? bus.lat.toFixed(5) : 'na',
        Number.isFinite(bus.lng) ? bus.lng.toFixed(5) : 'na',
      ].join(':');

      if (seen.has(dedupeKey)) {
        return false;
      }

      seen.add(dedupeKey);
      return true;
    });
}

function normalizeCampusEtaBus(value, visitNumber) {
  const minutes = parseCampusEtaMinutes(value);

  if (minutes == null) {
    return null;
  }

  return {
    estimatedArrival: new Date(Date.now() + minutes * 60_000).toISOString(),
    minutes,
    visitNumber,
    load: null,
    loadLabel: 'Load unavailable',
    type: null,
    typeLabel: 'Campus shuttle',
    wheelchairAccessible: false,
    monitored: true,
    feature: null,
    originCode: null,
    destinationCode: null,
    lat: null,
    lng: null,
  };
}

function normalizeArriveLahBus(bus, visitNumber) {
  if (!bus?.time) {
    return null;
  }

  const estimatedArrival = new Date(bus.time);

  if (Number.isNaN(estimatedArrival.getTime())) {
    return null;
  }

  const rawMinutes = Number.isFinite(Number(bus.duration_ms))
    ? Math.round(Number(bus.duration_ms) / 60000)
    : Math.round((estimatedArrival.getTime() - Date.now()) / 60000);

  return {
    estimatedArrival: estimatedArrival.toISOString(),
    minutes: Math.max(rawMinutes, 0),
    visitNumber: Number(bus.visit_number) || visitNumber,
    load: bus.load || null,
    loadLabel: LOAD_LABELS[bus.load] || 'Load unavailable',
    type: bus.type || null,
    typeLabel: VEHICLE_LABELS[bus.type] || 'Vehicle type unavailable',
    wheelchairAccessible: bus.feature === 'WAB',
    monitored: Number(bus.monitored || 0) === 1,
    feature: bus.feature || null,
    originCode: bus.origin_code || null,
    destinationCode: bus.destination_code || null,
    lat: Number.isFinite(Number(bus.lat)) && Number(bus.lat) > 0 ? Number(bus.lat) : null,
    lng: Number.isFinite(Number(bus.lng)) && Number(bus.lng) > 0 ? Number(bus.lng) : null,
  };
}

function parseCampusEtaMinutes(value) {
  if (value == null) {
    return null;
  }

  const normalizedValue = String(value).trim().toLowerCase();

  if (!normalizedValue || normalizedValue === '-' || normalizedValue === 'na') {
    return null;
  }

  if (normalizedValue === 'arr' || normalizedValue === 'arriving' || normalizedValue === 'due') {
    return 0;
  }

  const minutes = Number.parseInt(normalizedValue.replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(minutes) ? Math.max(minutes, 0) : null;
}

function normalizeNextBus(nextBus, visitNumber) {
  if (!nextBus?.EstimatedArrival) {
    return null;
  }

  const estimatedArrival = new Date(nextBus.EstimatedArrival);
  const rawMinutes = Math.round((estimatedArrival.getTime() - Date.now()) / 60000);

  return {
    estimatedArrival: estimatedArrival.toISOString(),
    minutes: Math.max(rawMinutes, 0),
    visitNumber: nextBus.VisitNumber || visitNumber,
    load: nextBus.Load || null,
    loadLabel: LOAD_LABELS[nextBus.Load] || 'Load unavailable',
    type: nextBus.Type || null,
    typeLabel: VEHICLE_LABELS[nextBus.Type] || 'Vehicle type unavailable',
    wheelchairAccessible: nextBus.Feature === 'WAB',
    monitored: Number(nextBus.Monitored || 0) === 1,
    feature: nextBus.Feature || null,
    originCode: nextBus.OriginCode || null,
    destinationCode: nextBus.DestinationCode || null,
    lat: nextBus.Latitude ? Number(nextBus.Latitude) : null,
    lng: nextBus.Longitude ? Number(nextBus.Longitude) : null,
  };
}

async function collectPublicVehicles(dataset) {
  const stopCodes = dataset.stops
    .filter((stop) => stop.services.some((serviceNo) => PUBLIC_LIVE_SERVICE_SET.has(serviceNo)))
    .map((stop) => stop.code);
  const stopResponses = await mapWithConcurrency(stopCodes, 6, async (busStopCode) => {
    try {
      return await getArrivalResponse(busStopCode, dataset.stopLookup[busStopCode]);
    } catch {
      return null;
    }
  });

  return collectLiveVehicles(stopResponses);
}

async function collectCampusVehicles(dataset) {
  const campusVehicles = await Promise.all(
    CAMPUS_SHUTTLE_SERVICES.map(async (serviceNo) => {
      try {
        const payload = await fetchCampusOmnibusVehicles(serviceNo);
        const vehicleList =
          payload?.data?.Response?.ActiveBusResult?.Activebus?.List ||
          payload?.data?.ActiveBusResult?.Activebus?.List ||
          [];

        return vehicleList
          .map((vehicle) => normalizeCampusVehicle(serviceNo, vehicle, dataset))
          .filter(Boolean);
      } catch {
        return [];
      }
    })
  );

  return campusVehicles.flat();
}

function normalizeCampusVehicle(serviceNo, vehicle, dataset) {
  const lat = Number(vehicle?.Lat);
  const lng = Number(vehicle?.Lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const nearestStop = findNearestServiceStop(dataset.services?.[serviceNo], lat, lng);
  const crowdLevel = String(vehicle?.LoadInfo?.CrowdLevel || '').toLowerCase();

  return {
    id: `${serviceNo}:${String(vehicle?.Vehplate || `${lat.toFixed(5)}:${lng.toFixed(5)}`)}`,
    serviceNo,
    color: SERVICE_COLORS[serviceNo],
    estimatedArrival: new Date().toISOString(),
    minutes: null,
    statusLabel: 'Live shuttle',
    loadLabel: crowdLevel ? `Crowd ${crowdLevel}` : 'Load unavailable',
    typeLabel: 'Campus shuttle',
    wheelchairAccessible: false,
    lat,
    lng,
    bearing: Number.isFinite(Number(vehicle?.Direction)) ? Number(vehicle.Direction) : null,
    nextStopCode: nearestStop?.code || null,
    nextStopName: nearestStop?.name || dataset.services?.[serviceNo]?.title || serviceNo,
  };
}

function findNearestServiceStop(service, lat, lng) {
  const stops = service?.directions?.[0]?.stops || [];
  let nearestStop = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const stop of stops) {
    const distance = getDistanceMeters(lat, lng, stop.lat, stop.lng);

    if (distance < nearestDistance) {
      nearestStop = stop;
      nearestDistance = distance;
    }
  }

  return nearestStop;
}

function collectLiveVehicles(stopResponses) {
  const vehiclesById = new Map();

  for (const stopResponse of stopResponses.filter(Boolean)) {
    for (const service of stopResponse.services) {
      for (const bus of service.upcomingBuses || []) {
        if (!Number.isFinite(bus.lat) || !Number.isFinite(bus.lng)) {
          continue;
        }

        const vehicleId = [
          service.serviceNo,
          bus.lat.toFixed(5),
          bus.lng.toFixed(5),
        ].join(':');

        const existingVehicle = vehiclesById.get(vehicleId);

        if (!existingVehicle || bus.minutes < existingVehicle.minutes) {
          vehiclesById.set(vehicleId, {
            id: vehicleId,
            serviceNo: service.serviceNo,
            color: service.color,
            estimatedArrival: bus.estimatedArrival,
            minutes: bus.minutes,
            loadLabel: bus.loadLabel,
            typeLabel: bus.typeLabel,
            wheelchairAccessible: bus.wheelchairAccessible,
            lat: bus.lat,
            lng: bus.lng,
            nextStopCode: stopResponse.busStopCode,
            nextStopName: stopResponse.stopName,
          });
        }
      }
    }
  }

  return Array.from(vehiclesById.values()).sort(
    (left, right) =>
      left.serviceNo.localeCompare(right.serviceNo) ||
      left.minutes - right.minutes ||
      left.estimatedArrival.localeCompare(right.estimatedArrival)
  );
}

function dedupeVehicles(vehicles) {
  const vehicleLookup = new Map();

  for (const vehicle of vehicles) {
    const existing = vehicleLookup.get(vehicle.id);

    if (!existing) {
      vehicleLookup.set(vehicle.id, vehicle);
      continue;
    }

    if (
      existing.minutes == null ||
      (Number.isFinite(vehicle.minutes) && vehicle.minutes < existing.minutes)
    ) {
      vehicleLookup.set(vehicle.id, vehicle);
    }
  }

  return Array.from(vehicleLookup.values()).sort(
    (left, right) =>
      left.serviceNo.localeCompare(right.serviceNo) ||
      String(left.id).localeCompare(String(right.id))
  );
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

function handleApiError(res, error) {
  const status = error instanceof ApiError ? error.status : 500;
  const message =
    error instanceof ApiError
      ? error.message
      : 'Something unexpected happened while loading NTU transport data.';

  res.status(status).json({
    error: message,
    detail: error instanceof ApiError ? error.detail : String(error),
  });
}

function publicRouteDataset(dataset) {
  const { stopLookup, ...publicDataset } = dataset;
  return publicDataset;
}

function normalizeCoordinatePair(latValue, lngValue) {
  const lat = Number(latValue);
  const lng = Number(lngValue);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return [lat, lng];
}

function groupBy(items, getKey) {
  return items.reduce((groups, item) => {
    const key = getKey(item);

    if (!groups[key]) {
      groups[key] = [];
    }

    groups[key].push(item);
    return groups;
  }, {});
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  const results = [];

  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    const batchResults = await Promise.all(batch.map(iteratee));
    results.push(...batchResults);
  }

  return results;
}

function getDistanceMeters(startLat, startLng, endLat, endLng) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const earthRadiusMeters = 6_371_000;
  const deltaLat = toRadians(endLat - startLat);
  const deltaLng = toRadians(endLng - startLng);
  const startLatRadians = toRadians(startLat);
  const endLatRadians = toRadians(endLat);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(startLatRadians) * Math.cos(endLatRadians) * Math.sin(deltaLng / 2) ** 2;

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isDirectRun() {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === __filename);
}
