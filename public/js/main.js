import { fetchArrivals, fetchHealth, fetchRouteDataset, fetchVehicles } from './modules/api.js';
import { LIVE_SERVICES } from './modules/constants.js';
import { createMapController } from './modules/map.js';
import { createUIController } from './modules/ui.js';

let dataset = null;
let health = null;
let mapController = null;
let stopPopupAbortController = null;
let vehicleAbortController = null;
let vehicleRefreshTimerId = null;
let activeStopCode = null;

const LIVE_REFRESH_INTERVAL_MS = 10_000;

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

  if (health.liveDataAvailable) {
    await refreshVehicles();
    scheduleVehicleRefresh();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearVehicleRefresh();
    vehicleAbortController?.abort();
    stopPopupAbortController?.abort();
    return;
  }

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

function stopSupportsLiveData(stopCode) {
  if (!health?.liveDataAvailable || !mapController) {
    return false;
  }

  const stop = mapController.getStop(stopCode);
  const liveServices = new Set(health.liveServices || LIVE_SERVICES);

  return Boolean(stop?.services?.some((serviceNo) => liveServices.has(serviceNo)));
}
