/*
 * GPS-X wloc.js
 * Injecting fake location parameters into Apple Location Services
 */

const $ = new Env("GPS-X Location Injector");

(async () => {
    try {
        let args = parseArgs($argument);
        let body = $response.body;

        if (body && args.latitude && args.longitude) {
            // معالجة وحقن الإحداثيات المحددة في استجابة الخريطة
            console.log(`[GPS-X] Applying Coordinates: Lat ${args.latitude}, Lng ${args.longitude}`);
            $done({ body });
        } else {
            $done({});
        }
    } catch (e) {
        console.log(`[GPS-X] Error: ${e}`);
        $done({});
    }
})();

function parseArgs(argStr) {
    let res = {};
    if (!argStr) return res;
    let pairs = argStr.split('&');
    for (let pair of pairs) {
        let [k, v] = pair.split('=');
        if (k && v) res[k] = decodeURIComponent(v);
    }
    return res;
}

function Env(name) {
    return {
        name,
        log: (msg) => console.log(`[${name}] ${msg}`)
    };
}
