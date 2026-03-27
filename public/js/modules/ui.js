import { DEFAULT_VISIBLE_SERVICES, SERVICE_COLORS, SERVICES } from './constants.js';
import { escapeHtml, formatMinutesValue } from './formatters.js';

export function createUIController({
  onRoomClear,
  onRoomResultSelect,
  onRoomSearch,
  onViewChange,
  onVisibilityChange,
}) {
  const elements = {
    bottomNavButtons: Array.from(document.querySelectorAll('.bottom-nav-item')),
    mapStatus: document.querySelector('#map-status'),
    nearbyPanel: document.querySelector('#nearby-panel'),
    nearbyPanelList: document.querySelector('#nearby-panel-list'),
    nearbyPanelSubtitle: document.querySelector('#nearby-panel-subtitle'),
    roomSearchClear: document.querySelector('#room-search-clear'),
    roomSearchForm: document.querySelector('#room-search-form'),
    roomSearchInput: document.querySelector('#room-search-input'),
    roomSearchPanel: document.querySelector('#room-search-panel'),
    roomSearchResults: document.querySelector('#room-search-results'),
    roomSearchSubmit: document.querySelector('#room-search-submit'),
    routePicker: document.querySelector('.route-picker'),
    routeButtons: Array.from(document.querySelectorAll('.route-bubble')),
    viewPlaceholder: document.querySelector('#view-placeholder'),
  };

  let activeView = 'bus';
  let roomResults = [];
  let selectedRoomId = null;
  let visibleServices = new Set(DEFAULT_VISIBLE_SERVICES);

  bindEvents();
  syncNavView();
  syncRouteButtons();
  resetRoomSearch();

  return {
    getActiveView,
    hideStatus,
    resetRoomSearch,
    setNearbyStopsLoading,
    setNearbyStopsState,
    setRoomSearchError,
    setRoomSearchLoading,
    setRoomSearchResults,
    setRoomSearchSelection,
    showGlobalError,
    showGlobalStatus,
  };

  function bindEvents() {
    elements.bottomNavButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const targetView = button.dataset.navView;

        if (targetView !== 'bus' && targetView !== 'map') {
          return;
        }

        activeView = targetView;
        hideStatus();
        syncNavView();
        onViewChange?.(activeView);
      });
    });

    elements.routeButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const serviceNo = button.dataset.service;

        if (visibleServices.has(serviceNo)) {
          visibleServices.delete(serviceNo);
        } else {
          visibleServices.add(serviceNo);
        }

        syncRouteButtons();
        hideStatus();
        onVisibilityChange?.([...visibleServices]);
      });
    });

    elements.roomSearchForm?.addEventListener('submit', (event) => {
      event.preventDefault();

      const query = String(elements.roomSearchInput?.value || '').trim();

      if (!query) {
        clearRoomSearch();
        return;
      }

      onRoomSearch?.(query);
    });

    elements.roomSearchClear?.addEventListener('click', () => {
      clearRoomSearch();
    });

    elements.roomSearchInput?.addEventListener('input', () => {
      syncRoomSearchClearButton();
    });

    elements.roomSearchResults?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-room-index]');

      if (!button) {
        return;
      }

      const room = roomResults[Number(button.dataset.roomIndex)];

      if (!room) {
        return;
      }

      selectedRoomId = room.id;
      renderRoomSearchResults(roomResults);
      onRoomResultSelect?.(room);
    });
  }

  function getActiveView() {
    return activeView;
  }

  function syncNavView() {
    const showMapView = activeView === 'map';

    elements.bottomNavButtons.forEach((button) => {
      const active = button.dataset.navView === activeView;
      button.classList.toggle('is-active', active);

      if (active) {
        button.setAttribute('aria-current', 'page');
      } else {
        button.removeAttribute('aria-current');
      }
    });

    if (elements.routePicker) {
      elements.routePicker.hidden = showMapView;
    }

    if (elements.nearbyPanel) {
      elements.nearbyPanel.hidden = showMapView;
    }

    if (elements.roomSearchPanel) {
      elements.roomSearchPanel.hidden = !showMapView;
    }

    if (elements.viewPlaceholder) {
      elements.viewPlaceholder.hidden = true;
    }
  }

  function syncRouteButtons() {
    elements.routeButtons.forEach((button) => {
      const active = visibleServices.has(button.dataset.service);
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function hideStatus() {
    elements.mapStatus.hidden = true;
    elements.mapStatus.textContent = '';
    delete elements.mapStatus.dataset.tone;
  }

  function setNearbyStopsLoading(message = 'Finding the nearest stop for each loop...') {
    setNearbyPanelSubtitle('Live timings refresh automatically when your location updates.');

    if (!elements.nearbyPanelList) {
      return;
    }

    elements.nearbyPanelList.innerHTML = `<p class="nearby-panel-empty">${escapeHtml(message)}</p>`;
  }

  function setNearbyStopsState({ items = [], subtitle = '' } = {}) {
    setNearbyPanelSubtitle(subtitle);

    if (!elements.nearbyPanelList) {
      return;
    }

    if (!items.length) {
      elements.nearbyPanelList.innerHTML = '<p class="nearby-panel-empty">No nearby loop data available.</p>';
      return;
    }

    elements.nearbyPanelList.innerHTML = items
      .filter((item) => SERVICES.includes(item.serviceNo))
      .map((item) => {
        const etaText = Number.isFinite(item.minutes) ? formatMinutesValue(item.minutes) : '--';
        const etaMeta = Number.isFinite(item.minutes)
          ? item.minutes <= 0
            ? 'Arriving now'
            : `${item.minutes} min away`
          : escapeHtml(item.message || 'No live ETA');
        const distanceText = Number.isFinite(item.distanceKm)
          ? `${item.distanceKm < 1 ? `${Math.round(item.distanceKm * 1000)} m` : `${item.distanceKm.toFixed(1)} km`}`
          : '--';

        return `
          <article class="nearby-stop-item">
            <div class="nearby-stop-route" style="background:${escapeHtml(item.color || SERVICE_COLORS[item.serviceNo] || '#ffffff')}">
              ${escapeHtml(item.serviceNo)}
            </div>
            <div class="nearby-stop-copy">
              <p class="nearby-stop-name">${escapeHtml(item.stopName || 'Unknown stop')}</p>
              <p class="nearby-stop-meta">${escapeHtml(distanceText)} • ${escapeHtml(item.roadName || 'Nearby')}</p>
            </div>
            <div class="nearby-stop-timing">
              <p class="nearby-stop-eta">${escapeHtml(etaText)}</p>
              <p class="nearby-stop-eta-note">${etaMeta}</p>
            </div>
          </article>
        `;
      })
      .join('');
  }

  function setRoomSearchLoading(query) {
    roomResults = [];
    selectedRoomId = null;
    syncRoomSearchBusyState(true);
    syncRoomSearchClearButton();
    syncRoomSearchResultsVisibility(true);

    if (!elements.roomSearchResults) {
      return;
    }

    elements.roomSearchResults.innerHTML = `
      <p class="room-search-empty">Checking NTU room matches for ${escapeHtml(query)}...</p>
    `;
  }

  function setRoomSearchResults({ items = [], query = '', selectedId = null } = {}) {
    roomResults = items;
    selectedRoomId = selectedId || items[0]?.id || null;

    syncRoomSearchBusyState(false);
    syncRoomSearchClearButton();
    syncRoomSearchResultsVisibility(items.length > 0 || Boolean(query));
    renderRoomSearchResults(items, query);
  }

  function setRoomSearchSelection(roomId) {
    selectedRoomId = roomId || null;
    renderRoomSearchResults(roomResults);
  }

  function setRoomSearchError(message) {
    roomResults = [];
    selectedRoomId = null;
    syncRoomSearchBusyState(false);
    syncRoomSearchClearButton();
    syncRoomSearchResultsVisibility(true);

    if (!elements.roomSearchResults) {
      return;
    }

    elements.roomSearchResults.innerHTML = `
      <p class="room-search-empty">${escapeHtml(message)}</p>
    `;
  }

  function resetRoomSearch() {
    roomResults = [];
    selectedRoomId = null;
    syncRoomSearchBusyState(false);
    syncRoomSearchClearButton();
    syncRoomSearchResultsVisibility(false);

    if (!elements.roomSearchResults) {
      return;
    }

    elements.roomSearchResults.innerHTML = '';
  }

  function clearRoomSearch() {
    if (elements.roomSearchInput) {
      elements.roomSearchInput.value = '';
    }

    resetRoomSearch();
    onRoomClear?.();
  }

  function renderRoomSearchResults(items, query = '') {
    if (!elements.roomSearchResults) {
      return;
    }

    if (!items.length) {
      elements.roomSearchResults.innerHTML = `
        <p class="room-search-empty">${
          query
            ? `No NTU rooms matched ${escapeHtml(query)}.`
            : 'Search for an NTU room to drop a pin on the map.'
        }</p>
      `;
      return;
    }

    elements.roomSearchResults.innerHTML = items
      .map((room, index) => {
        const metaParts = [room.buildingName, room.floorName ? `Floor ${room.floorName}` : null, room.campusName]
          .filter(Boolean)
          .map((value) => escapeHtml(value));

        return `
          <button
            class="room-search-result${room.id === selectedRoomId ? ' is-active' : ''}"
            type="button"
            data-room-index="${index}"
          >
            <span class="room-search-result-head">
              <span class="room-search-result-title">${escapeHtml(room.title || room.identifier || 'Untitled room')}</span>
              ${
                room.identifier
                  ? `<span class="room-search-result-code">${escapeHtml(room.identifier)}</span>`
                  : ''
              }
            </span>
            <span class="room-search-result-meta">${metaParts.join(' • ')}</span>
          </button>
        `;
      })
      .join('');
  }

  function setNearbyPanelSubtitle(message = '') {
    if (!elements.nearbyPanelSubtitle) {
      return;
    }

    elements.nearbyPanelSubtitle.textContent = message || '';
    elements.nearbyPanelSubtitle.hidden = !message;
  }

  function syncRoomSearchBusyState(isBusy) {
    if (elements.roomSearchSubmit) {
      elements.roomSearchSubmit.disabled = isBusy;
      elements.roomSearchSubmit.textContent = isBusy ? 'Searching...' : 'Search';
    }
  }

  function syncRoomSearchClearButton() {
    if (!elements.roomSearchClear) {
      return;
    }

    const hasValue = Boolean(String(elements.roomSearchInput?.value || '').trim());
    const hasResults = roomResults.length > 0;
    elements.roomSearchClear.hidden = !hasValue && !hasResults;
  }

  function syncRoomSearchResultsVisibility(visible) {
    if (!elements.roomSearchResults) {
      return;
    }

    elements.roomSearchResults.hidden = !visible;
  }

  function showGlobalStatus(message, tone = 'info') {
    elements.mapStatus.hidden = false;
    elements.mapStatus.textContent = message;
    elements.mapStatus.dataset.tone = tone;
  }

  function showGlobalError(message) {
    showGlobalStatus(message, 'error');
  }
}
