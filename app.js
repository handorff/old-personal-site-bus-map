/* =========================
   Configuration
========================= */

const ROUTES = ["1", "66", "77"];
const MAP_CENTER = [-71.0589, 42.3601];
const MAP_ZOOM = 12;

const OPENFREEMAP_STYLE_URL = "./styles/background.json";
const MBTA_BASE = "https://api-v3.mbta.com";

const ENABLE_SSE = false;
const POLL_INTERVAL_MS = 10000;

const TELEPORT_METERS = 450;
const HISTORY_MS = 90000;
const SOURCE_UPDATE_EVERY_MS = 120;

const SEGMENT_DURATION_MODE = "observed"; // "observed" | "poll"
const SEGMENT_DUR_MIN_MS = Math.floor(POLL_INTERVAL_MS * 0.6);
const SEGMENT_DUR_MAX_MS = Math.floor(POLL_INTERVAL_MS * 1.6);

/* =========================
   Utilities
========================= */

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    sp.set(k, v);
  }
  return sp.toString();
}

// Rough haversine distance in meters
function haversineMeters(lon1, lat1, lon2, lat2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function nowMs() {
  return Date.now();
}

function parseTimeMs(value) {
  // MBTA v3 updated_at is ISO8601. If absent, fallback to now.
  if (!value) return nowMs();
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : nowMs();
}

/* =========================
   State
========================= */

/**
 * Per vehicle:
 * - p0: previous observed point {lon, lat, t}
 * - p1: latest observed point {lon, lat, t}
 * - segStartMs: local wallclock when we started animating toward p1
 * - segDurMs: duration over which we animate p0 -> p1
 * - rendered: {lon, lat} current drawn position
 * - lastSeenMs: last observed timestamp (for stale eviction)
 */
const vehicles = new Map();

// Map + source bookkeeping
let map;
let lastSourceUpdateMs = 0;

// Footer elements (optional)
const footerMode = document.getElementById("footer-mode");
const footerStatusDot = document.getElementById("footer-status-dot");
const footerLast = document.getElementById("footer-last");
const footerCount = document.getElementById("footer-count");

let lastUpdateMs = null;

function setFooterMode(text) {
  if (footerMode) footerMode.textContent = text;
}

function setFooterStatus(state) {
  if (footerStatusDot) footerStatusDot.dataset.state = state;
}

function setFooterLast(ts) {
  if (!footerLast) return;
  lastUpdateMs = ts ?? null;
}

function updateFooterLastRelative() {
  if (!footerLast) return;
  if (!lastUpdateMs) {
    footerLast.textContent = "--";
    return;
  }
  const seconds = Math.max(0, Math.floor((nowMs() - lastUpdateMs) / 1000));
  footerLast.textContent = `${seconds} seconds ago`;
}

/* =========================
   MBTA URL builders
========================= */

function vehiclesUrl() {
  const params = {
    "filter[route]": ROUTES.join(","),
    "fields[vehicle]": [
      "latitude",
      "longitude",
      "bearing",
      "speed",
      "updated_at",
      "route_id",
      "label",
      "current_status",
    ].join(","),
    "page[limit]": "200",
  };

  return `${MBTA_BASE}/vehicles?${qs(params)}`;
}

/* =========================
   Ingest updates (segment playback)
========================= */

function upsertVehiclePoint(vehicleId, observedT, lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;

  const now = nowMs();
  let v = vehicles.get(vehicleId);

  if (!v) {
    v = {
      p0: { lon, lat, t: observedT },
      p1: { lon, lat, t: observedT },
      segStartMs: now,
      segDurMs: POLL_INTERVAL_MS,
      rendered: { lon, lat },
      lastSeenMs: observedT,
    };
    vehicles.set(vehicleId, v);
    return;
  }

  v.lastSeenMs = observedT;

  // If the observation is identical or extremely close in time, update p1 only.
  if (Math.abs(observedT - v.p1.t) < 500) {
    v.p1 = { lon, lat, t: observedT };
    // If we are basically at the end of the segment, keep rendered aligned.
    return;
  }

  // Shift p1 -> p0, store new p1
  v.p0 = v.p1;
  v.p1 = { lon, lat, t: observedT };

  // Teleport detection: if huge jump, snap instead of animating across the map
  const dist = haversineMeters(v.p0.lon, v.p0.lat, v.p1.lon, v.p1.lat);
  if (dist > TELEPORT_METERS) {
    v.rendered.lon = v.p1.lon;
    v.rendered.lat = v.p1.lat;
    v.segStartMs = now;
    v.segDurMs = POLL_INTERVAL_MS;
    return;
  }

  // Segment duration: either based on observed timestamps or just the poll interval.
  let dur;
  if (SEGMENT_DURATION_MODE === "observed") {
    const dtObs = Math.max(1, v.p1.t - v.p0.t);
    dur = clamp(dtObs, SEGMENT_DUR_MIN_MS, SEGMENT_DUR_MAX_MS);
  } else {
    dur = POLL_INTERVAL_MS;
  }

  // Start a new playback segment at "now" from p0 -> p1
  v.segStartMs = now;
  v.segDurMs = dur;
}

function ingestJsonApiDocument(doc) {
  if (!doc || !doc.data) return;

  const items = Array.isArray(doc.data) ? doc.data : [doc.data];

  for (const item of items) {
    if (!item || item.type !== "vehicle") continue;
    const id = item.id;
    const a = item.attributes || {};
    const lon = a.longitude;
    const lat = a.latitude;
    const t = parseTimeMs(a.updated_at);

    if (!id) continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    upsertVehiclePoint(id, t, lon, lat);
  }
}

/* =========================
   Streaming (SSE) + fallback polling
========================= */

let sse;
let pollTimer = null;
let hadSseData = false;

function startSse() {
  if (!ENABLE_SSE) return false;

  const url = vehiclesUrl();

  try {
    setFooterMode("streaming");
    setFooterStatus("idle");
    sse = new EventSource(url);

    sse.onopen = () => setFooterStatus("ok");
    sse.onerror = () => {
      setFooterStatus("error");
      if (!hadSseData) {
        setTimeout(() => {
          if (!hadSseData) {
            stopSse();
            startPolling();
          }
        }, 4000);
      }
    };

    sse.onmessage = (evt) => {
      hadSseData = true;
      try {
        const doc = JSON.parse(evt.data);
        ingestJsonApiDocument(doc);
        setFooterStatus("ok");
        setFooterLast(nowMs());
      } catch {
        // ignore
      }
    };

    return true;
  } catch {
    setFooterStatus("error");
    return false;
  }
}

function stopSse() {
  if (sse) {
    try {
      sse.close();
    } catch {}
    sse = null;
  }
}

async function pollOnce() {
  const url = vehiclesUrl();
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    ingestJsonApiDocument(doc);
    setFooterMode("polling");
    setFooterStatus("ok");
    setFooterLast(nowMs());
  } catch {
    setFooterMode("polling");
    setFooterStatus("error");
  }
}

function startPolling() {
  if (pollTimer) return;
  setFooterMode("polling");
  setFooterStatus("idle");
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/* =========================
   Rendering (segment playback)
========================= */

function animateFrame() {
  const tNow = nowMs();

  // Update per-vehicle rendered positions by playing back p0 -> p1 over segDurMs.
  for (const v of vehicles.values()) {
    const u = (tNow - v.segStartMs) / v.segDurMs;
    const a = clamp01(u);

    v.rendered.lon = v.p0.lon + (v.p1.lon - v.p0.lon) * a;
    v.rendered.lat = v.p0.lat + (v.p1.lat - v.p0.lat) * a;
  }

  // Purge vehicles not seen recently
  const staleCutoff = tNow - Math.max(HISTORY_MS, POLL_INTERVAL_MS * 5);
  for (const [id, v] of vehicles.entries()) {
    if (v.lastSeenMs < staleCutoff) vehicles.delete(id);
  }

  // Push GeoJSON to the map at a controlled cadence
  if (map && map.getSource("vehicles") && (tNow - lastSourceUpdateMs) > SOURCE_UPDATE_EVERY_MS) {
    lastSourceUpdateMs = tNow;

    const features = [];
    for (const [id, v] of vehicles.entries()) {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [v.rendered.lon, v.rendered.lat],
        },
        properties: { id },
      });
    }

    map.getSource("vehicles").setData({ type: "FeatureCollection", features });
    if (footerCount) footerCount.textContent = String(features.length);
  }

  updateFooterLastRelative();
  requestAnimationFrame(animateFrame);
}

/* =========================
   Map init
========================= */

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: OPENFREEMAP_STYLE_URL,
    center: MAP_CENTER,
    zoom: MAP_ZOOM,
    interactive: false,
    attributionControl: true,
  });

  // Optional: make it feel more “background”
  map.scrollZoom.disable();
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();

  map.on("load", () => {
    map.addSource("vehicles", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    // Marker styling (high-contrast for light basemaps)
    map.addLayer({
      id: "vehicles-glow",
      type: "circle",
      source: "vehicles",
      paint: {
        "circle-radius": 10,
        "circle-color": "rgba(0, 0, 0, 0.20)",
        "circle-blur": 0.9,
      },
    });

    map.addLayer({
      id: "vehicles-core",
      type: "circle",
      source: "vehicles",
      paint: {
        "circle-radius": 4,
        "circle-color": "rgba(20, 20, 20, 0.90)",
        "circle-stroke-width": 1,
        "circle-stroke-color": "rgba(255, 255, 255, 0.80)",
      },
    });

    // Start data
    const ok = startSse();
    if (!ok) startPolling();

    // Start animation loop
    requestAnimationFrame(animateFrame);
  });
}

/* =========================
   Boot
========================= */

initMap();
