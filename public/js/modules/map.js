import { DEFAULT_VISIBLE_SERVICES, INITIAL_VIEW, SERVICE_COLORS, SERVICES } from './constants.js';
import { escapeHtml } from './formatters.js';

export function createMapController(containerId, { onStopSelect } = {}) {
  if (!window.L) {
    throw new Error('Leaflet failed to load.');
  }

  const { L } = window;
  const map = L.map(containerId, {
    attributionControl: false,
    zoomControl: false,
    preferCanvas: true,
    minZoom: 12,
  }).setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
  }).addTo(map);

  map.createPane('route-glow-pane');
  map.getPane('route-glow-pane').style.zIndex = '390';
  map.createPane('route-casing-pane');
  map.getPane('route-casing-pane').style.zIndex = '400';
  map.createPane('route-line-pane');
  map.getPane('route-line-pane').style.zIndex = '410';
  map.createPane('stop-pane');
  map.getPane('stop-pane').style.zIndex = '420';
  map.createPane('user-pane');
  map.getPane('user-pane').style.zIndex = '430';
  map.createPane('vehicle-pane');
  map.getPane('vehicle-pane').style.zIndex = '440';

  const routeGroup = L.layerGroup().addTo(map);
  const stopGroup = L.layerGroup().addTo(map);
  const vehicleGroup = L.layerGroup().addTo(map);

  let visibleServices = new Set(DEFAULT_VISIBLE_SERVICES);
  let selectedStopCode = null;
  let stopLookup = new Map();
  let stopServiceLookup = new Map();
  let markerLookup = new Map();
  let routeLookup = new Map();
  let userLocationMarker = null;
  let vehicleLookup = new Map();

  map.on('zoomend', updateRouteOffsets);

  return {
    openStopPopup,
    openStopPopupError,
    openStopPopupLoading,
    openStaticStopPopup,
    getStop,
    highlightStop,
    isStopPopupOpen,
    clearUserLocation,
    resetView,
    setUserLocation,
    setVisibleServices,
    setDataset,
    setVehicles,
  };

  function setDataset(dataset) {
    clearLayers();

    stopLookup = new Map(dataset.stops.map((stop) => [stop.code, stop]));
    stopServiceLookup = buildStopServiceLookup(dataset.services || {});

    for (const serviceNo of SERVICES) {
      const service = dataset.services?.[serviceNo];

      if (!service) {
        continue;
      }

      const layers = service.directions.map((directionData) => {
        const dashed = Number(directionData.direction) === 2;
        const routeOffset = getRouteOffset(
          serviceNo,
          Number(directionData.direction),
          service.directions.length
        );
        const glowLayer = L.polyline(directionData.path, {
          color: SERVICE_COLORS[serviceNo],
          pane: 'route-glow-pane',
          weight: 8,
          opacity: 0.12,
          offset: routeOffset,
          lineCap: 'round',
          lineJoin: 'round',
          smoothFactor: 0,
        });
        const casingLayer = L.polyline(directionData.path, {
          color: '#ffffff',
          pane: 'route-casing-pane',
          weight: 5,
          opacity: 0.94,
          offset: routeOffset,
          lineCap: 'round',
          lineJoin: 'round',
          smoothFactor: 0,
        });
        const lineLayer = L.polyline(directionData.path, {
          color: SERVICE_COLORS[serviceNo],
          pane: 'route-line-pane',
          weight: 3,
          opacity: 0.98,
          dashArray: dashed ? '14 10' : null,
          offset: routeOffset,
          lineCap: 'round',
          lineJoin: 'round',
          smoothFactor: 0,
        });
        const tooltipLayer = L.polyline(directionData.path, {
          color: SERVICE_COLORS[serviceNo],
          weight: 8,
          opacity: 0,
          offset: routeOffset,
          lineCap: 'round',
          lineJoin: 'round',
          smoothFactor: 0,
        })
          .bindTooltip(
            service.title
              ? `${escapeHtml(service.title)} • ${escapeHtml(serviceNo)}`
              : `Route ${serviceNo} • Direction ${directionData.direction}`,
            {
            direction: 'top',
            sticky: true,
            }
          );
        return {
          baseOffset: routeOffset,
          casingLayer,
          direction: directionData.direction,
          glowLayer,
          lineLayer,
          tooltipLayer,
        };
      });

      routeLookup.set(serviceNo, layers);
    }

    for (const stop of dataset.stops) {
      const marker = L.marker([stop.lat, stop.lng], {
        icon: buildStopIcon(stop),
        title: stop.name,
        keyboard: true,
        pane: 'stop-pane',
        riseOnHover: true,
      })
        .bindTooltip(escapeHtml(stop.name), {
          className: 'stop-tooltip',
          direction: 'top',
          offset: [0, -12],
          opacity: 1,
        })
        .addTo(stopGroup);

      marker.on('click', () => {
        marker.openTooltip();
        onStopSelect?.(stop.code);
      });

      markerLookup.set(stop.code, marker);
    }

    updateRouteOffsets();
    updateRouteVisibility();
    updateStopStyles();
    updateVehicleVisibility();
  }

  function setVisibleServices(serviceNos) {
    visibleServices = new Set(serviceNos);
    updateRouteVisibility();
    updateStopStyles();
    updateVehicleVisibility();
  }

  function highlightStop(stopCode, { focus = true } = {}) {
    selectedStopCode = stopCode;
    updateStopStyles();

    const marker = markerLookup.get(stopCode);
    const stop = stopLookup.get(stopCode);

    if (marker) {
      marker.openTooltip();
    }

    if (focus && stop) {
      map.flyTo([stop.lat, stop.lng], Math.max(map.getZoom(), 16), {
        animate: true,
        duration: 0.55,
      });
    }
  }

  function resetView() {
    map.flyTo(INITIAL_VIEW.center, INITIAL_VIEW.zoom, {
      animate: true,
      duration: 0.55,
    });
  }

  function getStop(stopCode) {
    return stopLookup.get(stopCode) || null;
  }

  function isStopPopupOpen(stopCode) {
    const marker = markerLookup.get(stopCode);
    return Boolean(marker?.isPopupOpen());
  }

  function clearLayers() {
    routeGroup.clearLayers();
    stopGroup.clearLayers();
    vehicleGroup.clearLayers();
    markerLookup = new Map();
    routeLookup = new Map();
    stopServiceLookup = new Map();
    vehicleLookup = new Map();
  }

  function setUserLocation({ lat, lng } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      clearUserLocation();
      return;
    }

    const latLng = [lat, lng];

    if (!userLocationMarker) {
      userLocationMarker = L.marker(latLng, {
        icon: buildUserLocationIcon(),
        keyboard: false,
        pane: 'user-pane',
        zIndexOffset: 1600,
      })
        .bindTooltip('Your location', {
          className: 'stop-tooltip',
          direction: 'top',
          offset: [0, -12],
          opacity: 1,
        })
        .addTo(map);

      return;
    }

    userLocationMarker.setLatLng(latLng);
  }

  function clearUserLocation() {
    if (!userLocationMarker) {
      return;
    }

    userLocationMarker.remove();
    userLocationMarker = null;
  }

  function updateRouteVisibility() {
    for (const [serviceNo, layers] of routeLookup.entries()) {
      const visible = visibleServices.has(serviceNo);

      for (const record of layers) {
        syncLayerVisibility(record.glowLayer, visible);
        syncLayerVisibility(record.casingLayer, visible);
        syncLayerVisibility(record.lineLayer, visible);
        syncLayerVisibility(record.tooltipLayer, visible);
      }
    }
  }

  function updateRouteOffsets() {
    for (const layers of routeLookup.values()) {
      for (const record of layers) {
        const scaledOffset = getScaledRouteOffset(record.baseOffset);

        record.glowLayer.setOffset(scaledOffset);
        record.casingLayer.setOffset(scaledOffset);
        record.lineLayer.setOffset(scaledOffset);
        record.tooltipLayer.setOffset(scaledOffset);
      }
    }
  }

  function updateStopStyles() {
    if (selectedStopCode) {
      const selectedStop = stopLookup.get(selectedStopCode);

      if (!selectedStop || !selectedStop.services.some((serviceNo) => visibleServices.has(serviceNo))) {
        selectedStopCode = null;
      }
    }

    for (const [stopCode, marker] of markerLookup.entries()) {
      const stop = stopLookup.get(stopCode);
      const activeStopServices = stop.services.filter((serviceNo) => visibleServices.has(serviceNo));
      const visible = activeStopServices.length > 0;

      syncLayerVisibility(marker, visible);

      if (!visible) {
        continue;
      }

      marker.setIcon(buildStopIcon(stop, activeStopServices, { selected: selectedStopCode === stopCode }));
      marker.setZIndexOffset(selectedStopCode === stopCode ? 1000 : 0);
    }
  }

  function setVehicles(vehicles) {
    vehicleGroup.clearLayers();
    vehicleLookup = new Map();

    for (const vehicle of vehicles) {
      const marker = L.marker([vehicle.lat, vehicle.lng], {
        icon: buildVehicleIcon(vehicle),
        keyboard: false,
        pane: 'vehicle-pane',
        zIndexOffset: 2000,
      })
        .bindTooltip(buildVehicleTooltip(vehicle), {
          direction: 'top',
          offset: [0, -12],
          opacity: 1,
          className: 'stop-tooltip',
        })
        .addTo(vehicleGroup);

      vehicleLookup.set(vehicle.id, {
        marker,
        serviceNo: vehicle.serviceNo,
      });
    }

    updateVehicleVisibility();
  }

  function buildStopIcon(stop, services = stop.services, { selected = false } = {}) {
    const classNames = ['stop-marker-icon'];

    if (selected) {
      classNames.push('is-selected');
    }

    return L.divIcon({
      className: classNames.join(' '),
      html: `<span class="stop-marker" style="--marker-fill:${getMarkerFill(services)}"></span>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
      tooltipAnchor: [0, -12],
    });
  }

  function buildUserLocationIcon() {
    return L.divIcon({
      className: 'user-location-icon',
      html: `
        <span class="user-location-marker">
          <span class="user-location-pulse" aria-hidden="true"></span>
          <span class="user-location-core" aria-hidden="true"></span>
        </span>
      `,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
      tooltipAnchor: [0, -12],
    });
  }

  function buildVehicleIcon(vehicle) {
    const bearing = getVehicleBearing(vehicle);
    const accentColor = vehicle.color || SERVICE_COLORS[vehicle.serviceNo] || '#2d6cdf';
    const accentShade = shadeColor(accentColor, -18);

    return L.divIcon({
      className: 'vehicle-marker-icon',
      html: `
        <span
          class="vehicle-marker"
          style="--vehicle-color:${accentColor};--vehicle-color-shade:${accentShade}"
        >
          <span class="vehicle-direction" style="transform: rotate(${bearing}deg)" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
              <path d="M12 3l6 7h-4v11h-4V10H6z"></path>
            </svg>
          </span>
          <span class="vehicle-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
              <path d="M6 3h12l2 7v8a1 1 0 0 1-1 1h-1a2 2 0 0 1-4 0h-4a2 2 0 0 1-4 0H5a1 1 0 0 1-1-1v-8l2-7Zm1.5 2L6.2 9h11.6L16.5 5h-9ZM6 11v4h12v-4H6Z"></path>
            </svg>
          </span>
          <span class="vehicle-service">${vehicle.serviceNo}</span>
        </span>
      `,
      iconSize: [46, 20],
      iconAnchor: [23, 10],
      tooltipAnchor: [0, -12],
    });
  }

  function buildVehicleTooltip(vehicle) {
    const parts = [`Bus ${vehicle.serviceNo}`];

    if (Number.isFinite(vehicle.minutes)) {
      parts.push(vehicle.minutes <= 0 ? 'Arriving now' : `${vehicle.minutes} min`);
      if (vehicle.nextStopName) {
        parts.push(`to ${escapeHtml(vehicle.nextStopName)}`);
      }
      return parts.join(' • ');
    }

    if (vehicle.statusLabel) {
      parts.push(escapeHtml(vehicle.statusLabel));
    }

    if (vehicle.nextStopName) {
      parts.push(`near ${escapeHtml(vehicle.nextStopName)}`);
    }

    return parts.join(' • ');
  }

  function getVehicleBearing(vehicle) {
    if (Number.isFinite(vehicle.bearing)) {
      return vehicle.bearing;
    }

    const nextStop = stopLookup.get(vehicle.nextStopCode);

    if (!nextStop) {
      return 0;
    }

    return getBearingDegrees(vehicle.lat, vehicle.lng, nextStop.lat, nextStop.lng);
  }

  function openStopPopupLoading(stopCode) {
    const marker = markerLookup.get(stopCode);
    const stop = stopLookup.get(stopCode);

    if (!marker || !stop) {
      return;
    }

    marker
      .bindPopup(buildStopPopupShell(stop, '<p class="stop-popup-state">Loading live timings...</p>'), {
        closeButton: false,
        minWidth: 214,
        maxWidth: 296,
        offset: [0, -10],
      })
      .openPopup();
  }

  function openStopPopup(stopCode, arrivalPayload) {
    const marker = markerLookup.get(stopCode);

    if (!marker) {
      return;
    }

    marker
      .bindPopup(buildStopPopupMarkup(arrivalPayload), {
        closeButton: false,
        minWidth: 214,
        maxWidth: 296,
        offset: [0, -10],
      })
      .openPopup();
  }

  function openStaticStopPopup(stopCode) {
    const marker = markerLookup.get(stopCode);
    const stop = stopLookup.get(stopCode);

    if (!marker || !stop) {
      return;
    }

    marker
      .bindPopup(buildStaticStopPopupMarkup(stopCode), {
        closeButton: false,
        minWidth: 214,
        maxWidth: 296,
        offset: [0, -10],
      })
      .openPopup();
  }

  function openStopPopupError(stopCode, message) {
    const marker = markerLookup.get(stopCode);
    const stop = stopLookup.get(stopCode);

    if (!marker || !stop) {
      return;
    }

    marker
      .bindPopup(
        buildStopPopupShell(
          stop,
          `<p class="stop-popup-state stop-popup-state-error">${escapeHtml(message)}</p>`
        ),
        {
          closeButton: false,
          minWidth: 214,
          maxWidth: 296,
          offset: [0, -10],
        }
      )
      .openPopup();
  }

  function buildStopPopupMarkup(arrivalPayload) {
    const visibleServices = arrivalPayload.services.filter((service) => service.servesStop);
    const cards = visibleServices
      .map((service) => {
        const buses = (service.upcomingBuses || [])
          .slice(0, 3)
          .map((bus) => {
            const etaLabel = bus.minutes <= 0 ? 'Now' : `${bus.minutes} min`;
            return `
              <span class="stop-popup-eta-pill">
                <span class="stop-popup-eta-topline">
                  <strong>${escapeHtml(etaLabel)}</strong>
                  ${buildAccessibilityBadge(bus)}
                </span>
                ${buildLoadBar(bus)}
              </span>
            `;
          })
          .join('');
        const emptyState = escapeHtml(service.message || 'No live estimate');

        return `
          <div class="stop-popup-service" style="--service-accent:${escapeHtml(service.color)}">
            <div class="stop-popup-etas">
              ${buses || `<span class="stop-popup-state">${emptyState}</span>`}
            </div>
          </div>
        `;
      })
      .join('');

    return buildStopPopupShell(
      {
        code: arrivalPayload.busStopCode,
        name: arrivalPayload.stopName,
        roadName: arrivalPayload.roadName,
      },
      cards
        ? `<div class="stop-popup-services">${cards}</div>`
        : '<p class="stop-popup-state">No live estimate</p>',
      {
        headerBadges: buildStopPopupHeaderBadges(visibleServices),
      }
    );
  }

  function buildLoadBar(bus) {
    if (!bus.load) {
      return '';
    }

    const loadClass = getLoadClass(bus.load);

    return `
      <span class="stop-popup-load" aria-label="${escapeHtml(bus.loadLabel)}">
        <span class="stop-popup-load-track">
          <span class="stop-popup-load-fill stop-popup-load-fill-${loadClass}"></span>
        </span>
      </span>
    `;
  }

  function buildAccessibilityBadge(bus) {
    if (!bus.wheelchairAccessible) {
      return '';
    }

    return `
      <span class="stop-popup-wheelchair" aria-label="Wheelchair accessible" title="Wheelchair accessible">
        <span class="stop-popup-wheelchair-symbol" aria-hidden="true">&#9855;</span>
      </span>
    `;
  }

  function buildStopPopupShell(stop, bodyMarkup, { headerBadges = '' } = {}) {
    return `
      <div class="stop-popup">
        <div class="stop-popup-head">
          <div class="stop-popup-title-row">
            <p class="stop-popup-title">${escapeHtml(stop.name)}</p>
            ${headerBadges ? `<div class="stop-popup-title-badges">${headerBadges}</div>` : ''}
          </div>
          ${buildStopMetaMarkup(stop)}
        </div>
        ${bodyMarkup}
      </div>
    `;
  }

  function buildStopPopupHeaderBadges(entries) {
    const seen = new Set();

    return entries
      .filter((entry) => {
        if (!entry?.serviceNo || seen.has(entry.serviceNo)) {
          return false;
        }

        seen.add(entry.serviceNo);
        return true;
      })
      .map(
        (entry) => `
          <span class="stop-popup-route stop-popup-route-header" style="background:${escapeHtml(entry.color)}">
            ${escapeHtml(entry.serviceNo)}
          </span>
        `
      )
      .join('');
  }

  function buildStopMetaMarkup(stop) {
    const subtitle = stop.roadName ? `<span class="stop-popup-subtitle">${escapeHtml(stop.roadName)}</span>` : '';
    const displayCode =
      stop.displayCode ?? (/^\d+$/.test(String(stop.code || '')) ? String(stop.code) : '');
    const code = displayCode
      ? `<span class="stop-popup-code">${escapeHtml(displayCode)}</span>`
      : '';

    if (!subtitle && !code) {
      return '';
    }

    const dot = subtitle && code ? '<span class="stop-popup-meta-dot" aria-hidden="true">&bull;</span>' : '';

    return `<p class="stop-popup-meta">${subtitle}${dot}${code}</p>`;
  }

  function buildStaticStopPopupMarkup(stopCode) {
    const stop = stopLookup.get(stopCode);
    const serviceEntries = stopServiceLookup.get(stopCode) || [];
    const visibleEntries = serviceEntries.filter((entry) => visibleServices.has(entry.serviceNo));
    const cards = visibleEntries
      .map((entry) => {
        const firstBusLabel = entry.firstBusTime ? `First bus ${entry.firstBusTime}` : 'See route notice';
        const noteParts = [];

        if (entry.operates && !/omnibus/i.test(entry.operates)) {
          noteParts.push(entry.operates);
        }

        noteParts.push(firstBusLabel);
        const noteMarkup = noteParts.length
          ? `<p class="stop-popup-note">${escapeHtml(noteParts.join(' · '))}</p>`
          : '';

        return `
          <div class="stop-popup-service" style="--service-accent:${escapeHtml(entry.color)}">
            <div class="stop-popup-service-head">
              <span class="stop-popup-service-label">${escapeHtml(entry.shortLabel || entry.serviceNo)}</span>
            </div>
            <p class="stop-popup-detail">${escapeHtml(entry.stopLabel)}</p>
            ${noteMarkup}
          </div>
        `;
      })
      .join('');

    return buildStopPopupShell(
      stop,
      cards
        ? `<div class="stop-popup-services">${cards}</div>`
        : '<p class="stop-popup-state">No visible campus routes at this stop.</p>',
      {
        headerBadges: buildStopPopupHeaderBadges(visibleEntries),
      }
    );
  }

  function getLoadClass(loadCode) {
    if (loadCode === 'SEA') {
      return 'high';
    }

    if (loadCode === 'SDA') {
      return 'medium';
    }

    if (loadCode === 'LSD') {
      return 'low';
    }

    return 'unknown';
  }

  function getMarkerFill(services) {
    const colors = services.map((serviceNo) => SERVICE_COLORS[serviceNo]).filter(Boolean);

    if (colors.length <= 1) {
      return colors[0] || '#ffd166';
    }

    const step = 100 / colors.length;

    return `conic-gradient(${colors
      .map((color, index) => `${color} ${index * step}% ${(index + 1) * step}%`)
      .join(', ')})`;
  }

  function getRouteOffset(serviceNo, direction, directionCount = 1) {
    const leftHandLaneOffsets = {
      '179': -7.2,
      '199': 7.2,
      'CL-B': -4.8,
      'CL-R': 4.8,
      CR: -2.4,
      CWR: 2.4,
    };

    const directionStackOffset = directionCount > 1 ? (direction === 2 ? -0.75 : 0) : 0;

    return (leftHandLaneOffsets[serviceNo] || 0) + directionStackOffset;
  }

  function getScaledRouteOffset(baseOffset) {
    const zoom = map.getZoom();
    const minZoomForOffset = 16.2;
    const fullOffsetZoom = 17;

    if (zoom <= minZoomForOffset) {
      return 0;
    }

    if (zoom >= fullOffsetZoom) {
      return baseOffset;
    }

    const progress = (zoom - minZoomForOffset) / (fullOffsetZoom - minZoomForOffset);
    const easedProgress = progress * progress * (3 - 2 * progress);
    const scaledMagnitude = Math.abs(baseOffset) * easedProgress;

    return Math.sign(baseOffset) * scaledMagnitude;
  }

  function getBearingDegrees(startLat, startLng, endLat, endLng) {
    const toRadians = (value) => (value * Math.PI) / 180;
    const toDegrees = (value) => (value * 180) / Math.PI;
    const lat1 = toRadians(startLat);
    const lat2 = toRadians(endLat);
    const deltaLng = toRadians(endLng - startLng);

    const y = Math.sin(deltaLng) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

    return (toDegrees(Math.atan2(y, x)) + 360) % 360;
  }

  function syncLayerVisibility(layer, visible) {
    if (!layer) {
      return;
    }

    const hasLayer = routeGroup.hasLayer(layer) || stopGroup.hasLayer(layer) || vehicleGroup.hasLayer(layer);

    if (visible && !hasLayer) {
      if (layer instanceof L.Marker) {
        if (vehicleLookup.has(getVehicleIdForMarker(layer))) {
          vehicleGroup.addLayer(layer);
        } else {
          stopGroup.addLayer(layer);
        }
      } else {
        routeGroup.addLayer(layer);
      }
    }

    if (!visible && hasLayer) {
      if (layer instanceof L.Marker) {
        if (vehicleGroup.hasLayer(layer)) {
          vehicleGroup.removeLayer(layer);
        } else {
          stopGroup.removeLayer(layer);
        }
      } else {
        routeGroup.removeLayer(layer);
      }
    }
  }

  function updateVehicleVisibility() {
    for (const { marker, serviceNo } of vehicleLookup.values()) {
      syncLayerVisibility(marker, visibleServices.has(serviceNo));
    }
  }

  function getVehicleIdForMarker(marker) {
    for (const [vehicleId, record] of vehicleLookup.entries()) {
      if (record.marker === marker) {
        return vehicleId;
      }
    }

    return null;
  }

  function buildStopServiceLookup(services) {
    const lookup = new Map();

    for (const [serviceNo, service] of Object.entries(services)) {
      const direction = service.directions?.[0];

      if (!direction) {
        continue;
      }

      for (const stop of direction.stops) {
        if (!lookup.has(stop.code)) {
          lookup.set(stop.code, []);
        }

        const existingEntries = lookup.get(stop.code);

        if (existingEntries.some((entry) => entry.serviceNo === serviceNo)) {
          continue;
        }

        existingEntries.push({
          color: service.color,
          firstBusTime: stop.firstBusTime,
          operates: service.operates,
          serviceNo,
          shortLabel: service.shortLabel || service.title || serviceNo,
          stopLabel: stop.label || stop.name,
          title: service.title || serviceNo,
        });
      }
    }

    return lookup;
  }

  function shadeColor(hexColor, percent) {
    const normalized = String(hexColor || '').replace('#', '');

    if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
      return hexColor;
    }

    const numericValue = Number.parseInt(normalized, 16);
    const adjustment = Math.round((255 * percent) / 100);
    const red = clampColorChannel((numericValue >> 16) + adjustment);
    const green = clampColorChannel(((numericValue >> 8) & 0xff) + adjustment);
    const blue = clampColorChannel((numericValue & 0xff) + adjustment);

    return `#${[red, green, blue]
      .map((channel) => channel.toString(16).padStart(2, '0'))
      .join('')}`;
  }

  function clampColorChannel(value) {
    return Math.max(0, Math.min(255, value));
  }
}
