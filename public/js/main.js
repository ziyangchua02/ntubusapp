import { fetchArrivals, fetchHealth, fetchRouteDataset, fetchVehicles } from './modules/api.js';
import { LIVE_SERVICES, SERVICE_COLORS, SERVICES } from './modules/constants.js';
import { distanceBetween } from './modules/formatters.js';
import { createMapController } from './modules/map.js';
import { createUIController } from './modules/ui.js';

let dataset = null;
let health = null;
let mapController = null;
let locationWatchId = null;
let nearestStopsAbortController = null;
let stopPopupAbortController = null;
let vehicleAbortController = null;
let vehicleRefreshTimerId = null;
let activeStopCode = null;
let userLocation = null;

const LIVE_REFRESH_INTERVAL_MS = 10_000;
const LOCATION_WATCH_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 15_000,
  timeout: 10_000,
};

const uiController = createUIController({
  onVisibilityChange: (serviceNos) => {
    if (!mapController) {
      return;
    }

    mapController.setVisibleServices(serviceNos);
  },
});

bootstrap().catch((error) => {
  uiController.showGlobalError(error.message);
});

async function bootstrap() {
  await waitForMapLibraries();
  health = await fetchHealth();

  mapController = createMapController('map', {
    onStopSelect: (stopCode) => {
      activeStopCode = stopCode;
      mapController.highlightStop(stopCode, { focus: false });

      if (stopSupportsLiveData(stopCode)) {
        void loadStopPopup(stopCode);
        return;
      }

      mapController.openStaticStopPopup(stopCode);
    },
  });

  dataset = await fetchRouteDataset();
  mapController.setDataset(dataset);
  uiController.hideStatus();
  uiController.setNearbyStopsState({
    items: [],
    subtitle: 'Allow location to see nearby loops.',
  });
  startLocationTracking();

  if (health.liveDataAvailable) {
    await refreshVehicles();
    scheduleVehicleRefresh();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearVehicleRefresh();
    stopLocationTracking();
    nearestStopsAbortController?.abort();
    vehicleAbortController?.abort();
    stopPopupAbortController?.abort();
    return;
  }

  startLocationTracking();

  if (health?.liveDataAvailable) {
    void refreshLiveData().finally(() => {
      scheduleVehicleRefresh();
    });
  }
});

function waitForMapLibraries(timeoutMs = 10_000) {
  if (areMapLibrariesReady()) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const intervalId = window.setInterval(() => {
      if (areMapLibrariesReady()) {
        window.clearInterval(intervalId);
        resolve();
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(intervalId);
        reject(new Error('Leaflet could not be loaded. Please refresh the page.'));
      }
    }, 50);
  });
}

function areMapLibrariesReady() {
  return Boolean(window.L && typeof window.L.Polyline?.prototype?.setOffset === 'function');
}

async function loadStopPopup(stopCode, { background = false } = {}) {
  stopPopupAbortController?.abort();
  stopPopupAbortController = new AbortController();

  if (!stopSupportsLiveData(stopCode)) {
    mapController.openStaticStopPopup(stopCode);
    return;
  }

  if (!background) {
    mapController.openStopPopupLoading(stopCode);
  }

  try {
    const arrivalPayload = await fetchArrivals(stopCode, {
      signal: stopPopupAbortController.signal,
    });

    mapController.openStopPopup(stopCode, arrivalPayload);
  } catch (error) {
    if (error.name === 'AbortError') {
      return;
    }

    if (!background) {
      mapController.openStopPopupError(stopCode, error.message);
    }
  }
}

async function refreshVehicles() {
  vehicleAbortController?.abort();
  vehicleAbortController = new AbortController();

  try {
    const payload = await fetchVehicles({
      signal: vehicleAbortController.signal,
    });

    mapController.setVehicles(payload.vehicles || []);
  } catch (error) {
    if (error.name === 'AbortError') {
      return;
    }

    mapController.setVehicles([]);
  }
}

async function refreshLiveData() {
  await refreshVehicles();

  if (userLocation) {
    await refreshNearbyStops();
  }

  if (activeStopCode && stopSupportsLiveData(activeStopCode) && mapController?.isStopPopupOpen(activeStopCode)) {
    await loadStopPopup(activeStopCode, { background: true });
  }
}

function scheduleVehicleRefresh() {
  if (document.hidden || !health?.liveDataAvailable) {
    return;
  }

  clearVehicleRefresh();

  vehicleRefreshTimerId = window.setTimeout(async () => {
    await refreshLiveData();
    scheduleVehicleRefresh();
  }, LIVE_REFRESH_INTERVAL_MS);
}

function clearVehicleRefresh() {
  if (vehicleRefreshTimerId) {
    window.clearTimeout(vehicleRefreshTimerId);
    vehicleRefreshTimerId = null;
  }
}

function startLocationTracking() {
  if (!mapController || locationWatchId != null) {
    return;
  }

  if (!navigator.geolocation) {
    uiController.setNearbyStopsState({
      items: [],
      subtitle: 'Location is not supported on this device.',
    });
    return;
  }

  uiController.setNearbyStopsLoading('Waiting for your live location...');

  locationWatchId = navigator.geolocation.watchPosition(
    (position) => {
      userLocation = {
        lat: Number(position.coords?.latitude),
        lng: Number(position.coords?.longitude),
      };

      mapController?.setUserLocation({
        lat: userLocation.lat,
        lng: userLocation.lng,
      });
      void refreshNearbyStops();
    },
    (error) => {
      userLocation = null;
      mapController?.clearUserLocation();
      uiController.setNearbyStopsState({
        items: [],
        subtitle:
          error?.code === error.PERMISSION_DENIED
            ? 'Location access is blocked.'
            : 'Unable to get your location right now.',
      });
    },
    LOCATION_WATCH_OPTIONS
  );
}

function stopLocationTracking() {
  if (locationWatchId == null || !navigator.geolocation) {
    return;
  }

  navigator.geolocation.clearWatch(locationWatchId);
  locationWatchId = null;
}

async function refreshNearbyStops() {
  try {
    if (!dataset || !userLocation) {
      return;
    }

    const nearestStops = getNearestStopsByService(dataset, userLocation);

    if (!nearestStops.length) {
      uiController.setNearbyStopsState({
        items: [],
        subtitle: 'No nearby loop stops found.',
      });
      return;
    }

    nearestStopsAbortController?.abort();
    nearestStopsAbortController = new AbortController();

    const uniqueStopCodes = Array.from(new Set(nearestStops.map((entry) => entry.stopCode)));
    const arrivalEntries = await Promise.all(
      uniqueStopCodes.map(async (stopCode) => {
        try {
          const payload = await fetchArrivals(stopCode, {
            signal: nearestStopsAbortController.signal,
          });

          return [stopCode, payload];
        } catch (error) {
          if (error.name === 'AbortError') {
            throw error;
          }

          return [stopCode, null];
        }
      })
    );

    const arrivalLookup = new Map(arrivalEntries);

    uiController.setNearbyStopsState({
      items: nearestStops.map((entry) => {
        const arrivalPayload = arrivalLookup.get(entry.stopCode);
        const service = arrivalPayload?.services?.find((candidate) => candidate.serviceNo === entry.serviceNo);

        return {
          ...entry,
          message: service?.message || null,
          minutes: service?.nextBus?.minutes ?? null,
        };
      }),
      subtitle: 'Closest stop for each loop from your live location.',
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      return;
    }

    uiController.setNearbyStopsState({
      items: [],
      subtitle: 'Nearby timings could not be loaded right now.',
    });
  }
}

function getNearestStopsByService(routeDataset, location) {
  return SERVICES.map((serviceNo) => {
    const stops = routeDataset.services?.[serviceNo]?.directions?.flatMap((direction) => direction.stops || []) || [];
    let nearestStop = null;
    let nearestDistanceKm = Number.POSITIVE_INFINITY;

    for (const stop of stops) {
      const distanceKm = distanceBetween(location.lat, location.lng, stop.lat, stop.lng);

      if (distanceKm < nearestDistanceKm) {
        nearestDistanceKm = distanceKm;
        nearestStop = stop;
      }
    }

    if (!nearestStop) {
      return null;
    }

    return {
      color: SERVICE_COLORS[serviceNo],
      distanceKm: nearestDistanceKm,
      roadName: nearestStop.roadName || '',
      serviceNo,
      stopCode: nearestStop.code,
      stopName: nearestStop.name,
    };
  }).filter(Boolean);
}

function stopSupportsLiveData(stopCode) {
  if (!health?.liveDataAvailable || !mapController) {
    return false;
  }

  const stop = mapController.getStop(stopCode);
  const liveServices = new Set(health.liveServices || LIVE_SERVICES);

  return Boolean(stop?.services?.some((serviceNo) => liveServices.has(serviceNo)));
}
