/* 
 * GPS-X Settings Handler
 * حفظ البيانات في المفتاح الموحد wloc_settings
 */

if (typeof $request !== "undefined" && $request.body) {
    try {
        let body = $request.body;
        if (typeof body === "string") {
            body = JSON.parse(body);
        }
        
        // حفظ البيانات تحت المفتاح الصحيح الذي ينتظره النظام
        $persistentStore.write(JSON.stringify(body), "wloc_settings");
        console.log("📍 [GPS-X] تم حفظ الإحداثيات بنجاح في wloc_settings:", JSON.stringify(body));
    } catch (e) {
        console.log("⚠️ [GPS-X] خطأ في حفظ البيانات:", e);
    }
}

$done({
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ status: "ok" })
});
