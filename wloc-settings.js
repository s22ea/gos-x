/* 
 * GPS-X Settings Handler
 * حفظ وتعديل الإحداثيات على الخريطة
 */

if (typeof $request !== "undefined" && $request.body) {
    try {
        let bodyData = $request.body;
        
        // تحويل النص إلى JSON في حال وصوله كـ String
        if (typeof bodyData === "string") {
            bodyData = JSON.parse(bodyData);
        }

        // قراءة الإحداثيات وحفظها في الذاكرة الدائمة للتطبيق
        if (bodyData.latitude && bodyData.longitude) {
            $persistentStore.write(String(bodyData.latitude), "LOC_LATITUDE");
            $persistentStore.write(String(bodyData.longitude), "LOC_LONGITUDE");
            
            if (bodyData.accuracy) {
                $persistentStore.write(String(bodyData.accuracy), "LOC_ACCURACY");
            }
            
            console.log("📍 [GPS-X] تم حفظ الموقع بنجاح: " + bodyData.latitude + ", " + bodyData.longitude);
        }
    } catch (err) {
        console.log("⚠️ [GPS-X] خطأ في معالجة بيانات الحفظ: " + err);
    }
}

// إرجاع استجابة ناجحة 200 للخريطة لتأكيد الحفظ
$done({
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ status: "success", message: "Location saved successfully" })
});
