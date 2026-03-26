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
const LTA_ACCOUNT_KEY = process.env.LTA_ACCOUNT_KEY;
const LTA_BASE_URL = 'https://datamall2.mytransport.sg/ltaodataservice';
const BUSROUTER_BASE_URL = 'https://data.busrouter.sg/v1';
const ARRIVELAH_BASE_URL = 'https://arrivelah2.busrouter.sg/';
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
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 5000);
const NTU_OMNIBUS_MODULE_VERSION_TTL_MS = Number(
  process.env.NTU_OMNIBUS_MODULE_VERSION_TTL_MS || 30 * 60 * 1000
);
const NTU_VIEW = {
  center: {
    lat: 1.3483,
    lng: 103.6831,
  },
  zoom: 14.7,
};

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
  NTU_RouteColorCode: '0054A6',
};

const NTU_OMNIBUS_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json; charset=UTF-8',
  'X-CSRFToken': 'T6C+9iB49TLra4jEsMeSckDMNhQ=',
};

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
    publicLiveSource: LTA_ACCOUNT_KEY ? 'lta-datamall' : 'arrivelah-fallback',
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

async function fetchArriveLahJson(busStopCode) {
  const url = new URL(ARRIVELAH_BASE_URL);
  url.searchParams.set('id', busStopCode);

  try {
    return await fetchPublicJson(url.toString());
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ApiError(error.status, 'Live bus timings could not be loaded right now.', error.detail);
    }

    throw error;
  }
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
    publicServices.length ? fetchLiveArrivalPayload(stopMeta.code) : Promise.resolve(null),
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

function fetchLiveArrivalPayload(busStopCode) {
  if (LTA_ACCOUNT_KEY) {
    return fetchDatamallJson('/v3/BusArrival', {
      BusStopCode: busStopCode,
    });
  }

  return fetchArriveLahJson(busStopCode);
}

function buildArrivalResponse(busStopCode, stopMeta, payload) {
  const publicLiveServices = new Map(normalizeLiveServices(payload?.publicPayload));
  const campusLiveServices = payload?.campusPayload || new Map();

  const services = SERVICES.map((serviceNo) => {
    const servesStop = stopMeta.services.includes(serviceNo);
    const campusService = campusLiveServices.get(serviceNo);
    const publicService = publicLiveServices.get(serviceNo);
    const upcomingBuses = servesStop
      ? campusService
        ? campusService.upcomingBuses
        : [publicService?.NextBus, publicService?.NextBus2, publicService?.NextBus3]
            .map((bus, index) => normalizeNextBus(bus || null, index + 1))
            .filter(Boolean)
      : [];

    return {
      serviceNo,
      color: SERVICE_COLORS[serviceNo],
      servesStop,
      nextBus: upcomingBuses[0] || null,
      upcomingBuses,
      operator: campusService?.operator || publicService?.Operator || null,
      message: servesStop
        ? upcomingBuses.length
          ? null
          : campusService?.message || 'No live estimate is available right now.'
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

function normalizeLiveServices(payload) {
  if (LTA_ACCOUNT_KEY) {
    return (Array.isArray(payload?.Services) ? payload.Services : [])
      .filter((entry) => PUBLIC_BUS_SERVICES.includes(String(entry.ServiceNo)))
      .map((entry) => [String(entry.ServiceNo), entry]);
  }

  return (Array.isArray(payload?.services) ? payload.services : [])
    .filter((entry) => PUBLIC_BUS_SERVICES.includes(String(entry.no)))
    .map((entry) => [
      String(entry.no),
      {
        ServiceNo: String(entry.no),
        Operator: entry.operator || null,
        NextBus: normalizeArriveLahBus(entry.next),
        NextBus2: normalizeArriveLahBus(entry.next2 || entry.subsequent),
        NextBus3: normalizeArriveLahBus(entry.next3),
      },
    ]);
}

function normalizeCampusUpcomingBuses(payload) {
  const values = [payload?.ETA, payload?.NextETA];

  return values
    .map((value, index) => normalizeCampusEtaBus(value, index + 1))
    .filter(Boolean);
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

function normalizeArriveLahBus(bus) {
  if (!bus?.time) {
    return null;
  }

  return {
    EstimatedArrival: bus.time,
    Load: bus.load || null,
    Feature: bus.feature || null,
    Type: bus.type || null,
    VisitNumber: bus.visit_number || null,
    OriginCode: bus.origin_code || null,
    DestinationCode: bus.destination_code || null,
    Latitude: Number(bus.lat || 0),
    Longitude: Number(bus.lng || 0),
    Monitored: Number(bus.monitored || 0),
  };
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
