import { DEFAULT_VISIBLE_SERVICES, SERVICES } from './constants.js';

export function createUIController({ onVisibilityChange }) {
  const elements = {
    floatingLegend: document.querySelector('.floating-legend'),
    legendButtons: Array.from(document.querySelectorAll('.legend-chip')),
    legendToggle: document.querySelector('#legend-toggle'),
    legendToggleLabel: document.querySelector('.legend-toggle-label'),
    mapStatus: document.querySelector('#map-status'),
  };

  let visibleServices = new Set(DEFAULT_VISIBLE_SERVICES);
  let mobileLegendExpanded = false;

  bindEvents();
  syncLegendPanel();
  syncLegendButtons();

  return {
    hideStatus,
    showGlobalError,
  };

  function bindEvents() {
    elements.legendButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const serviceNo = button.dataset.service;

        if (visibleServices.has(serviceNo)) {
          visibleServices.delete(serviceNo);
        } else {
          visibleServices.add(serviceNo);
        }

        syncLegendButtons();
        hideStatus();
        onVisibilityChange?.([...visibleServices]);
      });
    });

    elements.legendToggle?.addEventListener('click', () => {
      mobileLegendExpanded = !mobileLegendExpanded;
      syncLegendPanel();
    });

    window.addEventListener('resize', () => {
      syncLegendPanel();
    });
  }

  function syncLegendButtons() {
    elements.legendButtons.forEach((button) => {
      const active = visibleServices.has(button.dataset.service);
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function syncLegendPanel() {
    if (!elements.floatingLegend || !elements.legendToggle) {
      return;
    }

    const isMobile = window.matchMedia('(max-width: 640px)').matches;
    const expanded = isMobile ? mobileLegendExpanded : true;

    elements.floatingLegend.classList.toggle('is-collapsed', isMobile && !expanded);
    elements.legendToggle.hidden = !isMobile;
    elements.legendToggle.setAttribute('aria-expanded', String(expanded));
    elements.legendToggleLabel.textContent = expanded ? 'Hide Routes' : 'Show Routes';
  }

  function hideStatus() {
    elements.mapStatus.hidden = true;
    elements.mapStatus.textContent = '';
    delete elements.mapStatus.dataset.tone;
  }

  function showGlobalError(message) {
    elements.mapStatus.hidden = false;
    elements.mapStatus.textContent = message;
    elements.mapStatus.dataset.tone = 'error';
  }
}
