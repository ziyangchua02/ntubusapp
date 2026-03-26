const clockFormatter = new Intl.DateTimeFormat('en-SG', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Singapore',
});

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatClockTime(isoString) {
  if (!isoString) {
    return 'No ETA';
  }

  const date = new Date(isoString);

  if (Number.isNaN(date.getTime())) {
    return 'No ETA';
  }

  return clockFormatter.format(date);
}

export function formatUpdatedAt(isoString) {
  if (!isoString) {
    return 'Waiting for live arrival data.';
  }

  return `Last updated ${formatClockTime(isoString)}`;
}

export function formatMinutesValue(minutes) {
  if (!Number.isFinite(minutes)) {
    return '--';
  }

  return minutes <= 0 ? 'Now' : String(minutes);
}

export function formatMinutesLabel(minutes) {
  if (!Number.isFinite(minutes)) {
    return 'no estimate';
  }

  return minutes <= 0 ? 'arriving now' : minutes === 1 ? 'minute away' : 'minutes away';
}

export function getArrivalState(minutes) {
  if (!Number.isFinite(minutes)) {
    return 'idle';
  }

  if (minutes <= 2) {
    return 'soon';
  }

  if (minutes <= 8) {
    return 'steady';
  }

  return 'later';
}

export function normalizeQuery(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function distanceBetween(latA, lngA, latB, lngB) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const deltaLat = toRadians(latB - latA);
  const deltaLng = toRadians(lngB - lngA);
  const startLat = toRadians(latA);
  const endLat = toRadians(latB);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(startLat) * Math.cos(endLat) * Math.sin(deltaLng / 2) ** 2;

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
