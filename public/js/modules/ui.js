import { DEFAULT_VISIBLE_SERVICES, SERVICE_COLORS, SERVICES } from './constants.js';
import { escapeHtml, formatMinutesValue } from './formatters.js';

export function createUIController({ onVisibilityChange }) {
  const elements = {
    bottomNavButtons: Array.from(document.querySelectorAll('.bottom-nav-item')),
    nearbyPanel: document.querySelector('#nearby-panel'),
    nearbyPanelList: document.querySelector('#nearby-panel-list'),
    nearbyPanelSubtitle: document.querySelector('#nearby-panel-subtitle'),
    routePicker: document.querySelector('.route-picker'),
    routeButtons: Array.from(document.querySelectorAll('.route-bubble')),
    mapStatus: document.querySelector('#map-status'),
    viewPlaceholder: document.querySelector('#view-placeholder'),
  };

  let activeView = 'bus';
  let visibleServices = new Set(DEFAULT_VISIBLE_SERVICES);

  bindEvents();
  syncNavView();
  syncRouteButtons();

  return {
    hideStatus,
    setNearbyStopsLoading,
    setNearbyStopsState,
    showGlobalStatus,
    showGlobalError,
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
  }

  function syncNavView() {
    const showPlaceholder = activeView === 'map';

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
      elements.routePicker.hidden = showPlaceholder;
    }

    if (elements.nearbyPanel) {
      elements.nearbyPanel.hidden = showPlaceholder;
    }

    if (elements.viewPlaceholder) {
      elements.viewPlaceholder.hidden = !showPlaceholder;
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

  function setNearbyPanelSubtitle(message = '') {
    if (!elements.nearbyPanelSubtitle) {
      return;
    }

    elements.nearbyPanelSubtitle.textContent = message || '';
    elements.nearbyPanelSubtitle.hidden = !message;
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
