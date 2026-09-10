/*
 * GPS-X wloc-settings.js
 * Redirects setting save requests back to VPN Client
 */

const url = $request.url;

try {
    // استخراج المعاملات الممررة من صفحة الخريطة
    const queryIndex = url.indexOf('?');
    if (queryIndex !== -1) {
        const queryString = url.substring(queryIndex + 1);
        const params = new URLSearchParams(queryString);
        
        const lat = params.get('latitude') || params.get('lat');
        const lng = params.get('longitude') || params.get('lng') || params.get('lon');
        const acc = params.get('accuracy') || '25';

        if (lat && lng) {
            const argumentStr = `longitude=${lng}&latitude=${lat}&accuracy=${acc}&randomRadius=0&logLevel=info`;
            
            // إنشاء رابط التوجيه للتطبيق لتحديث الإعدادات تلقائياً
            const targetScheme = `loon://import?plugin=${encodeURIComponent('https://raw.githubusercontent.com/s22ea/gos-x/main/wloc.module')}&argument=${encodeURIComponent(argumentStr)}`;

            $done({
                status: 302,
                headers: {
                    "Location": targetScheme,
                    "Access-Control-Allow-Origin": "*"
                }
            });
        } else {
            $done({ status: 400, body: JSON.stringify({ error: "Missing coordinates" }) });
        }
    } else {
        $done({ status: 400, body: JSON.stringify({ error: "No query parameters" }) });
    }
} catch (err) {
    $done({ status: 500, body: JSON.stringify({ error: err.message }) });
}
