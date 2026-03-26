async function requestJson(pathname, { signal } = {}) {
  const response = await fetch(pathname, {
    headers: {
      Accept: 'application/json',
    },
    signal,
  });

  let payload = null;
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    payload = await response.json();
  } else {
    const text = await response.text();
    payload = {
      error: text,
    };
  }

  if (!response.ok) {
    throw new Error(payload?.error || 'The server could not complete the request.');
  }

  return payload;
}

export function fetchRouteDataset(options) {
  return requestJson('/api/routes', options);
}

export function fetchHealth(options) {
  return requestJson('/api/health', options);
}

export function fetchArrivals(busStopCode, options) {
  const query = new URLSearchParams({
    busStopCode,
  });

  return requestJson(`/api/arrivals?${query.toString()}`, options);
}

export function fetchVehicles(options) {
  return requestJson('/api/vehicles', options);
}
