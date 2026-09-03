/**
 * WLOC Hybrid rewriter — Shadowrocket binary-body-mode.
 *
 * Drift model (not Yu9191's independent jump):
 *   Anchor stays in wloc_settings.
 *   Each intercepted /clls/wloc takes one small step (~0.2 m/s fidget)
 *   and is clamped to wanderRadius metres (default 5).
 *   Wi-Fi + cell in the SAME response share the same offset.
 *   horizontalAccuracy also breathes so the fix is not a frozen 35.000 m.
 *
 * Encoding: Apple uses proto int64 (two's-complement varint), scale 1e8.
 * Patch policy: only lat/lon/hAcc inside existing Location submessages.
 */
var STORE_KEY = "wloc_settings";
var SCALE = 100000000;
var WIFI_FIELD = 2;
var CELL_FIELDS = { 22: 1, 24: 1 };
var PREFIX = [0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00];
var MARKER = [0x00, 0x00, 0x00, 0x01, 0x00, 0x00];
var M_PER_DEG = 111320;

function log(m) {
  try { console.log("[wloc-hybrid] " + m); } catch (e) {}
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

function isQx() {
  return typeof $task !== "undefined";
}

function parseState(raw) {
  if (!raw) return null;
  try {
    var o = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!o || !isFinite(+o.latitude) || !isFinite(+o.longitude)) return null;
    return o;
  } catch (e) {
    return null;
  }
}

function readStoreRaw() {
  try {
    if (isQx()) return $prefs.valueForKey(STORE_KEY);
    var a = $persistentStore.read(STORE_KEY);
    if (parseState(a)) return a;
    var b = $persistentStore.read("wloc_settings");
    if (parseState(b)) return b;
    return a;
  } catch (e) {
    return null;
  }
}

function writeStoreRaw(text) {
  try {
    if (isQx()) return $prefs.setValueForKey(text, STORE_KEY);
    var ok = $persistentStore.write(text, STORE_KEY);
    if (!parseState($persistentStore.read(STORE_KEY))) {
      $persistentStore.write(STORE_KEY, text);
    }
    return ok !== false;
  } catch (e) {
    return false;
  }
}

function readState() {
  return parseState(readStoreRaw());
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function metersToDeg(lat, northM, eastM) {
  var cos = Math.cos((lat * Math.PI) / 180);
  if (Math.abs(cos) < 0.2) cos = cos < 0 ? -0.2 : 0.2;
  return {
    dLat: northM / M_PER_DEG,
    dLon: eastM / (M_PER_DEG * cos),
  };
}

function distM(lat1, lon1, lat2, lon2) {
  var p = metersToDeg(lat1, 1, 1);
  var dn = (lat2 - lat1) / p.dLat;
  var de = (lon2 - lon1) / p.dLon;
  return Math.sqrt(dn * dn + de * de);
}

/**
 * Persistent fidget walk inside a disk.
 * Independent Math.random() per packet (Yu9191 randomRadius) looks like teleporting.
 */
function stepWander(state, args) {
  var radius = +state.wanderRadius;
  if (!isFinite(radius) || radius <= 0) radius = +args.wanderRadius;
  if (!isFinite(radius) || radius <= 0) radius = 5;
  radius = clamp(radius, 0.5, 50);

  var now = Date.now();
  var prevTs = +state.walkTs || now;
  var dt = clamp((now - prevTs) / 1000, 0.3, 8);

  var heading = +state.walkHeading;
  if (!isFinite(heading)) heading = Math.random() * Math.PI * 2;
  heading += (Math.random() - 0.5) * 0.7 * dt;

  var speed = 0.12 + Math.random() * 0.28;
  var step = speed * dt;

  var curLat = isFinite(+state.walkLat) ? +state.walkLat : +state.latitude;
  var curLon = isFinite(+state.walkLon) ? +state.walkLon : +state.longitude;
  var off = metersToDeg(+state.latitude, Math.cos(heading) * step, Math.sin(heading) * step);
  curLat += off.dLat;
  curLon += off.dLon;

  var d = distM(+state.latitude, +state.longitude, curLat, curLon);
  if (d > radius) {
    var pull = metersToDeg(+state.latitude, 0, 0);
    var back = (d - radius * 0.72) / d;
    curLat -= (curLat - state.latitude) * back;
    curLon -= (curLon - state.longitude) * back;
    heading += Math.PI * (0.6 + Math.random() * 0.8);
  }

  var accBase = +state.accuracy || +args.accuracy || 35;
  var acc = +state.walkAcc;
  if (!isFinite(acc)) acc = accBase;
  acc += (Math.random() - 0.5) * 3;
  acc = clamp(acc, Math.max(18, accBase - 12), accBase + 14);

  state.walkLat = curLat;
  state.walkLon = curLon;
  state.walkHeading = heading;
  state.walkAcc = acc;
  state.walkTs = now;
  state.wanderRadius = radius;
  try { writeStoreRaw(JSON.stringify(state)); } catch (e) {}

  return { lat: curLat, lon: curLon, accuracy: Math.round(acc) };
}

function encodeInt64(n) {
  var b = BigInt(Math.round(n));
  if (b < 0n) b += 1n << 64n;
  var out = [];
  while (b >= 0x80n) {
    out.push(Number(b & 0x7fn) | 0x80);
    b >>= 7n;
  }
  out.push(Number(b));
  return new Uint8Array(out);
}

function encodeVarint(n) {
  if (n < 0) return encodeInt64(n);
  var out = [];
  var v = Math.round(n);
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return new Uint8Array(out);
}

function readVarint(bytes, offset) {
  var v = 0n;
  var s = 0n;
  for (var i = 0; i < 10; i++) {
    if (offset + i >= bytes.length) throw new Error("varint eof");
    var b = bytes[offset + i];
    v += BigInt(b & 0x7f) << s;
    if ((b & 0x80) === 0) return { value: v, size: i + 1 };
    s += 7n;
  }
  throw new Error("varint long");
}

function parseFields(bytes) {
  var fields = [];
  var o = 0;
  while (o < bytes.length) {
    var tag = readVarint(bytes, o);
    o += tag.size;
    var fieldNumber = Number(tag.value >> 3n);
    var wireType = Number(tag.value & 7n);
    var start = o - tag.size;
    if (wireType === 0) {
      var val = readVarint(bytes, o);
      o += val.size;
      fields.push({ fieldNumber: fieldNumber, wireType: wireType, raw: bytes.slice(start, o) });
    } else if (wireType === 2) {
      var len = readVarint(bytes, o);
      o += len.size;
      var n = Number(len.value);
      var end = o + n;
      if (end > bytes.length) throw new Error("len overflow");
      fields.push({
        fieldNumber: fieldNumber,
        wireType: wireType,
        raw: bytes.slice(start, end),
        valueBytes: bytes.slice(o, end),
      });
      o = end;
    } else if (wireType === 1) {
      o += 8;
      fields.push({ fieldNumber: fieldNumber, wireType: wireType, raw: bytes.slice(start, o) });
    } else if (wireType === 5) {
      o += 4;
      fields.push({ fieldNumber: fieldNumber, wireType: wireType, raw: bytes.slice(start, o) });
    } else {
      throw new Error("wire " + wireType);
    }
  }
  return fields;
}

function concat(parts) {
  var n = 0;
  var i;
  for (i = 0; i < parts.length; i++) n += parts[i].length;
  var out = new Uint8Array(n);
  var o = 0;
  for (i = 0; i < parts.length; i++) {
    out.set(parts[i], o);
    o += parts[i].length;
  }
  return out;
}

function makeVarintField(num, value) {
  return concat([encodeVarint(num * 8), encodeInt64(value)]);
}

function makeLenField(num, payload) {
  return concat([encodeVarint(num * 8 + 2), encodeVarint(payload.length), payload]);
}

function coordToInt(x) {
  return Math.round(x * SCALE);
}

function patchLocation(payload, cfg) {
  var fields;
  try {
    fields = parseFields(payload);
  } catch (e) {
    return payload;
  }
  var hasLat = false;
  var hasLon = false;
  var i;
  for (i = 0; i < fields.length; i++) {
    if (fields[i].fieldNumber === 1 && fields[i].wireType === 0) hasLat = true;
    if (fields[i].fieldNumber === 2 && fields[i].wireType === 0) hasLon = true;
  }
  if (!hasLat || !hasLon) return payload;
  var parts = [];
  for (i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.fieldNumber === 1 && f.wireType === 0) parts.push(makeVarintField(1, coordToInt(cfg.lat)));
    else if (f.fieldNumber === 2 && f.wireType === 0) parts.push(makeVarintField(2, coordToInt(cfg.lon)));
    else if (f.fieldNumber === 3 && f.wireType === 0) parts.push(makeVarintField(3, cfg.accuracy));
    else parts.push(f.raw);
  }
  return concat(parts);
}

function patchWifi(payload, cfg) {
  var fields = parseFields(payload);
  var parts = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.fieldNumber === 2 && f.wireType === 2) parts.push(makeLenField(2, patchLocation(f.valueBytes, cfg)));
    else parts.push(f.raw);
  }
  return concat(parts);
}

function patchCell(payload, cfg) {
  var fields = parseFields(payload);
  var parts = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.fieldNumber === 5 && f.wireType === 2) parts.push(makeLenField(5, patchLocation(f.valueBytes, cfg)));
    else parts.push(f.raw);
  }
  return concat(parts);
}

function patchRoot(payload, cfg) {
  var fields = parseFields(payload);
  var parts = [];
  var wifi = 0;
  var cell = 0;
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.fieldNumber === WIFI_FIELD && f.wireType === 2) {
      parts.push(makeLenField(WIFI_FIELD, patchWifi(f.valueBytes, cfg)));
      wifi++;
    } else if (CELL_FIELDS[f.fieldNumber] && f.wireType === 2) {
      parts.push(makeLenField(f.fieldNumber, patchCell(f.valueBytes, cfg)));
      cell++;
    } else {
      parts.push(f.raw);
    }
  }
  return { payload: concat(parts), wifi: wifi, cell: cell };
}

function u16(n) {
  return new Uint8Array([(n >> 8) & 255, n & 255]);
}

function looksPb(bytes) {
  if (!bytes || !bytes.length) return false;
  var fn = bytes[0] >> 3;
  var wt = bytes[0] & 7;
  return fn > 0 && (wt === 0 || wt === 2);
}

function tryPrefixedFrame(bytes, base) {
  if (base + 10 > bytes.length) return null;
  if (bytes[base] !== 0 || bytes[base + 1] !== 1) return null;
  var len = (bytes[base + 8] << 8) | bytes[base + 9];
  if (len <= 0 || base + 10 + len > bytes.length) return null;
  var payload = bytes.slice(base + 10, base + 10 + len);
  try {
    parseFields(payload);
    return {
      kind: "prefix",
      payload: payload,
      prefix: bytes.slice(0, base + 8),
      suffix: bytes.slice(base + 10 + len),
    };
  } catch (e) {
    return null;
  }
}

function extract(bytes) {
  var framed = tryPrefixedFrame(bytes, 0);
  if (framed) return framed;
  var off;
  for (off = 2; off <= 16 && off + 10 < bytes.length; off += 2) {
    framed = tryPrefixedFrame(bytes, off);
    if (framed) return framed;
  }
  if (bytes.length >= 10 && bytes[0] === 0 && bytes[1] === 1 && bytes[6] === 0 && bytes[7] === 0) {
    var len = (bytes[8] << 8) | bytes[9];
    if (len > 0 && 10 + len <= bytes.length) {
      var payload = bytes.slice(10, 10 + len);
      try {
        parseFields(payload);
        return { kind: "prefix", payload: payload, prefix: bytes.slice(0, 8), suffix: bytes.slice(10 + len) };
      } catch (e) {}
    }
  }
  var i;
  for (i = 0; i + 8 < bytes.length; i++) {
    var ok = true;
    var j;
    for (j = 0; j < MARKER.length; j++) {
      if (bytes[i + j] !== MARKER[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    var ln = (bytes[i + 6] << 8) | bytes[i + 7];
    var start = i + 8;
    if (ln > 0 && start + ln <= bytes.length) {
      var cand = bytes.slice(start, start + ln);
      try {
        parseFields(cand);
        return {
          kind: "marker",
          payload: cand,
          prefix: bytes.slice(0, i),
          marker: bytes.slice(i, i + 6),
          suffix: bytes.slice(start + ln),
        };
      } catch (e) {}
    }
  }
  if (looksPb(bytes)) {
    try {
      parseFields(bytes);
      return { kind: "bare", payload: bytes };
    } catch (e) {}
  }
  return null;
}

function rebuild(ext, payload) {
  if (ext.kind === "marker") {
    return concat([ext.prefix, ext.marker, u16(payload.length), payload, ext.suffix]);
  }
  if (ext.kind === "prefix") {
    return concat([ext.prefix || new Uint8Array(PREFIX), u16(payload.length), payload, ext.suffix || new Uint8Array(0)]);
  }
  return concat([new Uint8Array(PREFIX), u16(payload.length), payload]);
}

function scanPatch(bytes, cfg) {
  var limit = Math.min(bytes.length - 8, 256);
  for (var off = 0; off <= limit; off++) {
    var slice = bytes.slice(off);
    if (!looksPb(slice)) continue;
    try {
      var r = patchRoot(slice, cfg);
      if (r.wifi || r.cell) return { payload: r.payload, wifi: r.wifi, cell: r.cell, offset: off };
    } catch (e) {}
  }
  return null;
}

function bodyToBytes() {
  var msg = $response || {};
  if (msg.bodyBytes instanceof Uint8Array) return msg.bodyBytes;
  if (msg.bodyBytes && typeof msg.bodyBytes.length === "number") return new Uint8Array(msg.bodyBytes);
  if (typeof msg.body === "string") {
    var u = new Uint8Array(msg.body.length);
    for (var i = 0; i < msg.body.length; i++) u[i] = msg.body.charCodeAt(i) & 255;
    return u;
  }
  return null;
}

function bytesToBinary(u8) {
  var cs = 0x8000;
  var parts = [];
  for (var i = 0; i < u8.length; i += cs) {
    parts.push(String.fromCharCode.apply(null, Array.prototype.slice.call(u8.subarray(i, i + cs))));
  }
  return parts.join("");
}

function b64Encode(u8) {
  var bin = bytesToBinary(u8);
  try {
    return btoa(bin);
  } catch (e) {
    return "";
  }
}

function b64Decode(s) {
  try {
    var bin = atob(s);
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i) & 255;
    return u;
  } catch (e) {
    return null;
  }
}

function finish(bytes) {
  var bin = bytesToBinary(bytes);
  var headers = ($response && $response.headers) ? $response.headers : {};
  try { delete headers["Content-Encoding"]; } catch (e) {}
  try { delete headers["content-encoding"]; } catch (e) {}
  try { delete headers["Transfer-Encoding"]; } catch (e) {}
  try { delete headers["transfer-encoding"]; } catch (e) {}
  headers["Content-Encoding"] = "identity";
  headers["Content-Length"] = String(bytes.length);
  if (isQx()) {
    $done({ body: bin, headers: headers });
    return;
  }
  $done({ body: bin, bodyBytes: bytes, headers: headers });
}

function rememberGood(state, bytes) {
  // Do not persist the raw Apple body. A stale BSSID/cell list replayed
  // minutes later is a common silent failure mode, and 40–70KB blows
  // Shadowrocket persistentStore.
}

(function main() {
  var args = parseArg(typeof $argument !== "undefined" ? $argument : "");
  var state = readState();
  var raw = bodyToBytes();
  if (!raw || !raw.length) {
    $done({});
    return;
  }
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    log("gzip body still compressed; client did not decode. cannot patch");
    $done({});
    return;
  }
  if (!state) {
    log("no target; passthrough");
    $done({});
    return;
  }

  var cfg = stepWander(state, args);
  try {
    var result = null;
    var ext = extract(raw);
    if (ext) {
      var patched = patchRoot(ext.payload, cfg);
      if (patched.wifi || patched.cell) {
        result = { bytes: rebuild(ext, patched.payload), wifi: patched.wifi, cell: patched.cell, kind: ext.kind };
      }
    }
    if (!result) {
      var scanned = scanPatch(raw, cfg);
      if (scanned) {
        result = {
          bytes: concat([raw.slice(0, scanned.offset), scanned.payload]),
          wifi: scanned.wifi,
          cell: scanned.cell,
          kind: "scan",
        };
      }
    }
    if (!result) throw new Error("no patchable fields");
    log("ok " + result.kind + " wifi=" + result.wifi + " cell=" + result.cell + " acc=" + cfg.accuracy + " -> " + cfg.lat.toFixed(6) + "," + cfg.lon.toFixed(6));
    finish(result.bytes);
  } catch (e) {
    log("fail " + e.message);
    $done({});
  }
})();
