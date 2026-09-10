/* 
 * GPS-X Settings Handler
 * s22ea/gos-x
 */

const originalSettingsUrl = "https://raw.githubusercontent.com/Yu9191/wloc/main/dist/wloc-settings.js";

$httpClient.get({ url: originalSettingsUrl, timeout: 3 }, function (error, response, data) {
    if (!error && response && response.status === 200 && data && data.length > 50) {
        try {
            eval(data);
        } catch (e) {
            runFallbackSettings();
        }
    } else {
        runFallbackSettings();
    }
});

function runFallbackSettings() {
    if (typeof $request !== "undefined" && $request.body) {
        try {
            let bodyData = $request.body;
            if (typeof bodyData === "string") {
                bodyData = JSON.parse(bodyData);
            }
            // حفظ الإحداثيات بالمفتاح الخاص بالخريطة
            $persistentStore.write(JSON.stringify(bodyData), "wloc_settings");
        } catch (e) {
            console.log("Error saving location: " + e);
        }
    }
    
    $done({
        status: 200,
        headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify({ status: "success", message: "Saved successfully" })
    });
}
