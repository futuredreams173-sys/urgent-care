/* ==========================================================================
   الرعاية العاجلة — إعدادات Supabase
   --------------------------------------------------------------------------
   ضع هنا رابط المشروع والمفتاح العام (anon / publishable) فقط.
   لا تضع أبداً مفتاح service_role أو أي مفتاح سري في هذا الملف:
   أي شيء في الواجهة يُنزَّل إلى المتصفح ويُعدّ علنياً.

   · المفتاح العام آمن للنشر بشرط تفعيل RLS (ملف supabase/schema.sql).
   · الملفات المحلية التي تحتوي أسراراً مستثناة في .gitignore.
   ========================================================================== */
(function (global) {
  'use strict';

  global.URGENT_CARE_SUPABASE = {
    // مثال: https://abcdefghijklmnop.supabase.co
    url: '',

    // مثال: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...  أو  sb_publishable_...
    anonKey: '',

    // نطاق بريد اصطناعي يُشتق من بصمة الوثيقة (لا يُرسل إليه بريد فعلي).
    // يجب أن يطابق أي تغيير هنا إعدادات المشروع إن كنت تستخدم نطاقاً مخصصاً.
    emailDomain: 'patients.urgentcare.app',
  };

  // دعم تحميل إعدادات محلية غير مرفوعة إن وُجدت (اختياري).
  // هذا الملف مستثنى في .gitignore ولا يُنشر.
  if (global.URGENT_CARE_SUPABASE_LOCAL) {
    global.URGENT_CARE_SUPABASE = Object.assign(
      {},
      global.URGENT_CARE_SUPABASE,
      global.URGENT_CARE_SUPABASE_LOCAL
    );
  }
})(window);
