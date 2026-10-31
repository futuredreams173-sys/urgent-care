-- ============================================================================
--  عدد المراجعين المسجّلين — دالة عامة تُرجع رقماً واحداً فقط
-- ----------------------------------------------------------------------------
--  لماذا دالة منفصلة؟
--    جدول public.patients محمي بـ RLS: لا يستطيع الزائر المجهول قراءته إطلاقاً.
--    الأيقونة في الصفحة الرئيسية تحتاج **العدد فقط** (لا أسماء، لا وثائق، لا
--    جوالات). لذلك نعرّف دالة SECURITY DEFINER تُرجع count(*) وحده، ونمنح
--    صلاحية تنفيذها للزوار. لا تكشف الدالة أي صف ولا أي عمود.
--
--  التنفيذ: SQL Editor → New query → الصق هذا الملف → Run.
--  التنفيذ متكرر الآمان (idempotent): يمكن تشغيله أكثر من مرة.
-- ============================================================================

create or replace function public.registered_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.patients;
$$;

-- لا نسمح بتنفيذها إلا للزوار والمستخدمين المسجّلين.
revoke all on function public.registered_count() from public;
grant execute on function public.registered_count() to anon, authenticated;

-- تحقق سريع بعد التنفيذ:
-- select public.registered_count();
