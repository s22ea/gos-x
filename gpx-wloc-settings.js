/**
 * Local settings plane for Shadowrocket (also works on Surge/Loon/Stash/QX).
 *
 * The picker page calls:
 *   GET https://gs-loc.apple.com/wloc-settings/save?lon=&lat=&acc=&randomRadius=
 *   GET https://gs-loc.apple.com/wloc-settings/save?action=query
 *   GET https://gs-loc.apple.com/wloc-settings/save?action=clear
 *
 * This request is MITM'd on-device. Nothing is stored on Cloudflare.
 * Key: wloc_settings  (JSON, no TTL)
 */
const STORE_KEY = "wloc_settings";

function platform() {
  if (typeof $task !== "undefined") return "qx";
  if (typeof $loon !== "undefined") return "loon";
  if (typeof $rocket !== "undefined") return "shadowrocket";
  if (typeof $environment !== "undefined" && $environment["surge-version"]) return "surge";
  if (typeof $environment !== "undefined" && $environment["stash-version"]) return "stash";
  return "unknown";
}

function looksState(raw) {
  try {
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    return !!(o && Number.isFinite(+o.latitude) && Number.isFinite(+o.longitude));
  } catch (e) {
    return false;
  }
}

function readStore() {
  try {
    if (platform() === "qx") return $prefs.valueForKey(STORE_KEY);
    const a = $persistentStore.read(STORE_KEY);
    if (looksState(a)) return typeof a === "string" ? a : JSON.stringify(a);
    const b = $persistentStore.read("wloc_settings");
    if (looksState(b)) return typeof b === "string" ? b : JSON.stringify(b);
    return typeof a === "string" ? a : (a ? JSON.stringify(a) : null);
  } catch (e) {
    return null;
  }
}

function writeStore(text) {
  try {
    if (platform() === "qx") return !!$prefs.setValueForKey(text, STORE_KEY);
    $persistentStore.write(text, STORE_KEY);
    if (!looksState($persistentStore.read(STORE_KEY))) {
      $persistentStore.write(STORE_KEY, text);
    }
    return looksState(readStore());
  } catch (e) {
    return false;
  }
}

function removeStore() {
  try {
    if (platform() === "qx") return $prefs.removeValueForKey(STORE_KEY);
    return $persistentStore.write(null, STORE_KEY);
  } catch (e) {
    return false;
  }
}

function jsonDone(obj, status) {
  const body = JSON.stringify(obj);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
  };
  if (typeof $task !== "undefined") {
    $done({ status: status || 200, headers, body });
    return;
  }
  $done({ response: { status: status || 200, headers, body } });
}

function num(v) {
  const n = parseFloat(String(v == null ? "" : v).replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function parseQuery(url) {
  const q = {};
  const i = url.indexOf("?");
  if (i < 0) return q;
  url.slice(i + 1).split("&").forEach((pair) => {
    if (!pair) return;
    const eq = pair.indexOf("=");
    const k = decodeURIComponent((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, " "));
    const v = decodeURIComponent((eq < 0 ? "" : pair.slice(eq + 1)).replace(/\+/g, " "));
    q[k] = v;
  });
  return q;
}

const url = $request && $request.url ? $request.url : "";
const method = String(($request && ($request.method || $request.verb)) || "GET").toUpperCase();
if (method === "OPTIONS") {
  jsonDone({ ok: true }, 200);
} else {
const q = parseQuery(url);
const action = (q.action || "save").toLowerCase();

if (action === "query") {
  const raw = readStore();
  if (!raw) {
    jsonDone({ success: false, message: "empty" });
  } else {
    try {
      const data = JSON.parse(raw);
      jsonDone({
        success: true,
        latitude: data.latitude,
        longitude: data.longitude,
        accuracy: data.accuracy,
        wanderRadius: data.wanderRadius || data.randomRadius || 5,
        randomRadius: data.wanderRadius || data.randomRadius || 5,
        walkLat: data.walkLat,
        walkLon: data.walkLon,
      });
    } catch (e) {
      jsonDone({ success: false, message: "corrupt" }, 500);
    }
  }
} else if (action === "clear") {
  removeStore();
  jsonDone({ success: true, cleared: true });
} else {
  const lon = num(q.lon || q.longitude);
  const lat = num(q.lat || q.latitude);
  const acc = num(q.acc || q.accuracy);
  const wander = num(q.wanderRadius || q.randomRadius);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    jsonDone({ success: false, message: "missing or invalid lon/lat" }, 400);
  } else {
    var prev = {};
    try {
      var rawPrev = readStore();
      if (rawPrev) prev = JSON.parse(rawPrev) || {};
    } catch (e) {
      prev = {};
    }
    const accuracy = Number.isFinite(acc) && acc > 0 ? acc : (Number(prev.accuracy) || 35);
    const radius = Number.isFinite(wander)
      ? (wander > 0 ? wander : 5)
      : (Number(prev.wanderRadius || prev.randomRadius) || 5);
    const payload = {
      longitude: lon,
      latitude: lat,
      accuracy: accuracy,
      wanderRadius: radius,
      randomRadius: radius,
      walkLat: lat,
      walkLon: lon,
      walkHeading: Math.random() * Math.PI * 2,
      walkAcc: accuracy,
      walkTs: Date.now(),
      updatedAt: Date.now(),
    };
    const ok = writeStore(JSON.stringify(payload));
    jsonDone({
      success: !!ok,
      latitude: payload.latitude,
      longitude: payload.longitude,
      accuracy: payload.accuracy,
      wanderRadius: payload.wanderRadius,
    });
  }
}
}
