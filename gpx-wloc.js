/**
 * Hybrid WLOC rewriter for Shadowrocket.
 * Frame + field map follow Yu9191/dist/wloc.js.
 * $done shape follows Yu platform adapter (Shadowrocket: { response }).
 * Added: persistent 5 m walk, no lastGood replay, no BigInt (JSC-safe).
 */
var STORE_KEY = "wloc_settings";
var SCALE = 1e8;
var M_PER_DEG = 111320;

function log(m) {
  try { console.log("[wloc-hybrid] " + m); } catch (e) {}
}

function platform() {
  if (typeof $task !== "undefined") return "qx";
  if (typeof $rocket !== "undefined") return "sr";
  if (typeof $loon !== "undefined") return "loon";
  return "surge";
}

function parseArg(raw) {
  var out = {};
  String(raw || "").split("&").forEach(function (p) {
    var i = p.indexOf("=");
    if (i < 0) return;
    try {
      out[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1));
    } catch (e) {}
  });
  return out;
}

function parseState(raw) {
  if (!raw) return null;
  try {
    var o = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!o) return null;
    if (!isFinite(+o.latitude) || !isFinite(+o.longitude)) return null;
    return o;
  } catch (e) {
    return null;
  }
}

function readStore() {
  try {
    if (platform() === "qx") return parseState($prefs.valueForKey(STORE_KEY));
    var s = parseState($persistentStore.read(STORE_KEY));
    if (s) return s;
    return parseState($persistentStore.read("wloc_settings"));
  } catch (e) {
    return null;
  }
}

function writeStore(obj) {
  try {
    var text = JSON.stringify(obj);
    if (platform() === "qx") {
      $prefs.setValueForKey(text, STORE_KEY);
      return;
    }
    $persistentStore.write(text, STORE_KEY);
    if (!parseState($persistentStore.read(STORE_KEY))) $persistentStore.write(STORE_KEY, text);
  } catch (e) {}
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function stepWander(state, args) {
  var lat = +state.latitude;
  var lon = +state.longitude;
  var radius = +state.wanderRadius || +state.randomRadius || +args.wanderRadius || +args.randomRadius || 5;
  if (!(radius > 0)) radius = 5;
  var accBase = +state.accuracy || +args.accuracy || 35;
  var now = Date.now();
  var prev = +state.walkTs || now;
  var dt = clamp((now - prev) / 1000, 0.3, 8);
  var heading = +state.walkHeading;
  if (!isFinite(heading)) heading = Math.random() * Math.PI * 2;
  heading += (Math.random() - 0.5) * 0.9;
  var step = (0.12 + Math.random() * 0.18) * dt;
  var curLat = +state.walkLat;
  var curLon = +state.walkLon;
  if (!isFinite(curLat) || !isFinite(curLon)) { curLat = lat; curLon = lon; }
  var cos = Math.cos((lat * Math.PI) / 180);
  if (Math.abs(cos) < 0.2) cos = cos < 0 ? -0.2 : 0.2;
  curLat += (Math.cos(heading) * step) / M_PER_DEG;
  curLon += (Math.sin(heading) * step) / (M_PER_DEG * cos);
  var dLatM = (curLat - lat) * M_PER_DEG;
  var dLonM = (curLon - lon) * M_PER_DEG * cos;
  var dist = Math.sqrt(dLatM * dLatM + dLonM * dLonM);
  if (dist > radius) {
    var k = radius / dist;
    curLat = lat + (dLatM * k) / M_PER_DEG;
    curLon = lon + (dLonM * k) / (M_PER_DEG * cos);
    heading += Math.PI * (0.6 + Math.random() * 0.8);
  }
  var acc = +state.walkAcc;
  if (!isFinite(acc)) acc = accBase;
  acc = clamp(acc + (Math.random() - 0.5) * 3, Math.max(8, accBase - 12), accBase + 14);
  state.walkLat = curLat;
  state.walkLon = curLon;
  state.walkHeading = heading;
  state.walkAcc = acc;
  state.walkTs = now;
  state.wanderRadius = radius;
  state.randomRadius = radius;
  writeStore(state);
  return { lat: curLat, lon: curLon, accuracy: Math.round(acc) };
}

function encodeU64(lo, hi) {
  var out = [];
  for (var i = 0; i < 10; i++) {
    var b = lo & 0x7f;
    lo = ((lo >>> 7) | ((hi & 0x7f) << 25)) >>> 0;
    hi = hi >>> 7;
    if (lo || hi) out.push(b | 0x80);
    else { out.push(b); break; }
  }
  return new Uint8Array(out);
}

function encodeInt64(n) {
  n = Math.round(Number(n) || 0);
  var lo, hi;
  if (n >= 0) {
    lo = n % 4294967296; if (lo < 0) lo += 4294967296;
    hi = Math.floor(n / 4294967296);
  } else {
    var p = -n;
    var plo = p % 4294967296; if (plo < 0) plo += 4294967296;
    var phi = Math.floor(p / 4294967296);
    lo = (~plo + 1) >>> 0;
    hi = (~phi + (lo === 0 ? 1 : 0)) >>> 0;
  }
  return encodeU64(lo >>> 0, hi >>> 0);
}

function encodeVarint(n) {
  n = Math.round(Number(n) || 0);
  if (n < 0) return encodeInt64(n);
  return encodeU64(n % 4294967296, Math.floor(n / 4294967296));
}

function readVarint(bytes, offset) {
  var lo = 0, sh = 0, i;
  for (i = 0; i < 10; i++) {
    if (offset + i >= bytes.length) throw new Error("varint eof");
    var b = bytes[offset + i];
    lo += (b & 0x7f) * Math.pow(2, sh);
    if ((b & 0x80) === 0) return { value: lo, size: i + 1 };
    sh += 7;
  }
  throw new Error("varint long");
}

function concat(parts) {
  var n = 0, i, o = 0;
  for (i = 0; i < parts.length; i++) n += parts[i].length;
  var out = new Uint8Array(n);
  for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
  return out;
}

function parseFields(bytes) {
  var fields = [], o = 0;
  while (o < bytes.length) {
    var tag = readVarint(bytes, o);
    o += tag.size;
    var fieldNo = Math.floor(tag.value / 8);
    var wireType = tag.value % 8;
    var start = o - tag.size;
    if (wireType === 0) {
      var val = readVarint(bytes, o);
      o += val.size;
      fields.push({ fieldNo: fieldNo, wireType: wireType, raw: bytes.slice(start, o) });
    } else if (wireType === 2) {
      var ln = readVarint(bytes, o);
      o += ln.size;
      var end = o + ln.value;
      if (end > bytes.length) throw new Error("len overflow");
      fields.push({ fieldNo: fieldNo, wireType: wireType, raw: bytes.slice(start, end), value: bytes.slice(o, end) });
      o = end;
    } else if (wireType === 1) {
      o += 8; if (o > bytes.length) throw new Error("64 eof");
      fields.push({ fieldNo: fieldNo, wireType: wireType, raw: bytes.slice(start, o) });
    } else if (wireType === 5) {
      o += 4; if (o > bytes.length) throw new Error("32 eof");
      fields.push({ fieldNo: fieldNo, wireType: wireType, raw: bytes.slice(start, o) });
    } else throw new Error("wire " + wireType);
  }
  return fields;
}

function fieldVarint(num, value) { return concat([encodeVarint(num * 8), encodeInt64(value)]); }
function fieldLen(num, payload) { return concat([encodeVarint(num * 8 + 2), encodeVarint(payload.length), payload]); }
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function patchLocation(payload, cfg, stats) {
  var fields; try { fields = parseFields(payload); } catch (e) { return payload; }
  var hasLat = false, hasLon = false, i;
  for (i = 0; i < fields.length; i++) {
    if (fields[i].fieldNo === 1 && fields[i].wireType === 0) hasLat = true;
    if (fields[i].fieldNo === 2 && fields[i].wireType === 0) hasLon = true;
  }
  if (!hasLat || !hasLon) return payload;
  var parts = [];
  for (i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.fieldNo === 1 && f.wireType === 0) parts.push(fieldVarint(1, Math.round(cfg.lat * SCALE)));
    else if (f.fieldNo === 2 && f.wireType === 0) parts.push(fieldVarint(2, Math.round(cfg.lon * SCALE)));
    else if (f.fieldNo === 3 && f.wireType === 0) parts.push(fieldVarint(3, cfg.accuracy));
    else parts.push(f.raw);
  }
  stats.locations++;
  return concat(parts);
}

function patchWifi(payload, cfg, stats) {
  var fields = parseFields(payload), parts = [], i;
  for (i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.fieldNo === 2 && f.wireType === 2) { parts.push(fieldLen(2, patchLocation(f.value, cfg, stats))); stats.wifi++; }
    else parts.push(f.raw);
  }
  return concat(parts);
}

function patchCell(payload, cfg, stats) {
  var fields = parseFields(payload), parts = [], i;
  for (i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.fieldNo === 5 && f.wireType === 2) { parts.push(fieldLen(5, patchLocation(f.value, cfg, stats))); stats.cell++; }
    else parts.push(f.raw);
  }
  return concat(parts);
}

function patchRoot(payload, cfg, stats) {
  var fields = parseFields(payload), parts = [], i;
  for (i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.fieldNo === 2 && f.wireType === 2) parts.push(fieldLen(2, patchWifi(f.value, cfg, stats)));
    else if ((f.fieldNo === 22 || f.fieldNo === 24) && f.wireType === 2) parts.push(fieldLen(f.fieldNo, patchCell(f.value, cfg, stats)));
    else parts.push(f.raw);
  }
  return concat(parts);
}

function patchFrame(bytes, base, cfg) {
  if (bytes.length < base + 10) return null;
  var len = ((bytes[base + 8] & 255) << 8) | (bytes[base + 9] & 255);
  if (len <= 0 || base + 10 + len > bytes.length) return null;
  var head = bytes.slice(0, base + 8);
  var payload = bytes.slice(base + 10, base + 10 + len);
  var tail = bytes.slice(base + 10 + len);
  var stats = { wifi: 0, cell: 0, locations: 0 };
  var patched = patchRoot(payload, cfg, stats);
  if (stats.locations <= 0 || sameBytes(payload, patched)) return null;
  if (patched.length > 65535) return null;
  return { bytes: concat([head, new Uint8Array([patched.length >> 8, patched.length & 255]), patched, tail]), stats: stats, offset: base };
}

function patchScan(bytes, cfg) {
  var max = Math.min(256, bytes.length), off;
  for (off = 0; off <= max; off++) {
    try {
      var stats = { wifi: 0, cell: 0, locations: 0 };
      var slice = bytes.slice(off);
      var patched = patchRoot(slice, cfg, stats);
      if (stats.locations > 0 && !sameBytes(slice, patched)) return { bytes: concat([bytes.slice(0, off), patched]), stats: stats, offset: off };
    } catch (e) {}
  }
  return null;
}

function applyPatch(bytes, cfg) {
  var offsets = [0, 2, 4, 6, 8, 10, 12, 14, 16];
  var extra = Math.min(96, Math.max(0, bytes.length - 10));
  var i;
  for (i = 0; i <= extra; i++) if (offsets.indexOf(i) < 0) offsets.push(i);
  for (i = 0; i < offsets.length; i++) {
    try { var framed = patchFrame(bytes, offsets[i], cfg); if (framed) return framed; } catch (e) {}
  }
  return patchScan(bytes, cfg);
}

function toBytes() {
  var msg = $response || {};
  if (msg.bodyBytes instanceof Uint8Array) return msg.bodyBytes;
  if (msg.bodyBytes && typeof msg.bodyBytes.length === "number") return new Uint8Array(msg.bodyBytes);
  if (msg.rawBody instanceof Uint8Array) return msg.rawBody;
  if (typeof msg.body === "string") {
    var u = new Uint8Array(msg.body.length), i;
    for (i = 0; i < msg.body.length; i++) u[i] = msg.body.charCodeAt(i) & 255;
    return u;
  }
  return null;
}

function donePass() { $done({}); }

function donePatched(bytes) {
  var headers = ($response && $response.headers) ? $response.headers : {};
  try { delete headers["Content-Encoding"]; } catch (e) {}
  try { delete headers["content-encoding"]; } catch (e) {}
  try { delete headers["Transfer-Encoding"]; } catch (e) {}
  try { delete headers["transfer-encoding"]; } catch (e) {}
  headers["Content-Encoding"] = "identity";
  headers["Content-Length"] = String(bytes.length);
  var plat = platform();
  if (plat === "qx") {
    var bin = "", i;
    for (i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(i, i + 32768)));
    $done({ body: bin, headers: headers, status: "HTTP/1.1 200 OK" });
    return;
  }
  if ($response) {
    $response.body = bytes;
    $response.bodyBytes = bytes;
    $response.rawBody = bytes;
    $response.headers = headers;
    $response.status = 200;
    $response.statusCode = 200;
  }
  if (plat === "sr" || plat === "surge" || plat === "loon") {
    $done({ response: $response || { status: 200, headers: headers, body: bytes, bodyBytes: bytes } });
    return;
  }
  $done($response || { body: bytes, bodyBytes: bytes, headers: headers });
}

(function main() {
  try {
    if (typeof $response === "undefined") { donePass(); return; }
    var args = parseArg(typeof $argument !== "undefined" ? $argument : "");
    var state = readStore();
    var raw = toBytes();
    log("hit bytes=" + (raw ? raw.length : 0) + " store=" + (state ? state.latitude + "," + state.longitude : "empty"));
    if (!raw || !raw.length) { donePass(); return; }
    if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) { log("gzip still compressed"); donePass(); return; }
    if (!state) { log("no target; passthrough"); donePass(); return; }
    var cfg = stepWander(state, args);
    var result = applyPatch(raw, cfg);
    if (!result) throw new Error("no patchable fields");
    log("ok off=" + result.offset + " wifi=" + result.stats.wifi + " cell=" + result.stats.cell + " loc=" + result.stats.locations + " -> " + cfg.lat.toFixed(6) + "," + cfg.lon.toFixed(6));
    donePatched(result.bytes);
  } catch (e) {
    log("fail " + e.message);
    donePass();
  }
})();
