# NTU Live Bus Map

A deployable single-page web app that renders public bus services `179` and `199` together with NTU campus shuttle services `CL-B`, `CL-R`, `CR`, and `CWR` on a full-screen Leaflet map.

## Features

- Leaflet map centered on Nanyang Technological University, Singapore
- Route overlays for `179`, `199`, `CL-B`, `CL-R`, `CR`, and `CWR`
- Official NTU Omnibus route geometry, stop list, live shuttle ETA, and live shuttle vehicle positions for campus riders
- LTA DataMall or ArriveLah-backed live data for public buses `179` and `199`
- Minimal stop markers with click popups for route-specific arrival times
- Small Node proxy that keeps upstream API calls server-side and caches route/arrival data

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create an environment file and add your LTA DataMall key:

   ```bash
   cp .env.example .env
   ```

3. Start the app:

   ```bash
   npm run dev
   ```

4. Open `http://localhost:3000`.

## Environment Variables

- `LTA_ACCOUNT_KEY`: Optional. Enables direct LTA DataMall access for `179` and `199`. If omitted, the app falls back to ArriveLah for those public routes.
- `PORT`: Optional. Defaults to `3000`.
- `STATIC_CACHE_TTL_MS`: Optional. Defaults to `43200000` (12 hours).
- `UPSTREAM_TIMEOUT_MS`: Optional. Defaults to `5000`.
- `ARRIVAL_CACHE_TTL_MS`: Optional. Defaults to `8000`.
- `NTU_OMNIBUS_MODULE_VERSION_TTL_MS`: Optional. Defaults to `1800000` (30 minutes).

## Notes

- Public bus routes are sourced from BusRouter geometry, with live public arrivals coming from LTA DataMall or ArriveLah.
- Campus shuttle routes, campus stop timings, and campus shuttle vehicle locations are sourced from NTU's official Omnibus web backend.
- `GET /api/routes` returns combined public and campus geometry in a single frontend-friendly payload.
- `GET /api/vehicles` returns both public buses and campus shuttles in one live marker feed.
- `GET /api/health` is available for a simple deployment health check.
