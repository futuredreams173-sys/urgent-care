-- ============================================================================
--  الرعاية العاجلة — إزالة صلاحيات الموظفين (بقايا v2)
--  شغّل هذا الملف مرة واحدة في: Supabase Dashboard → SQL Editor → New query → Run
--
--  لماذا؟
--    الموقع لم يعد يحتوي لوحة موظفين. ما تبقّى في القاعدة من v2 يسمح لحساب
--    موظف واحد بقراءة كل زيارات وبيانات المراجعين الأساسية. هذا الملف يُلغي
--    ذلك نهائياً ويعيد النظام إلى: كل مستخدم يرى بياناته فقط.
--
--  ماذا يحذف؟
--    1. سياستَي الموظفين على جدول الزيارات (قراءة/تحديث)
--    2. عرض public.staff_patients
--    3. الدالة public.is_staff()
--    4. جدول public.staff وكل صفوفه (صلاحية أي موظف تُلغى فوراً)
--
--  ما لا يمسّه (يبقى كما هو):
--    · جداول patients / visits / notes وسياسات RLS الخاصة بكل مريض
--    · حماية هوية الزيارة (visits_guard_update) في الأسفل
--    · تحديث updated_at باحترام القيمة المرسلة (touch_updated_at) في الأسفل
--
--  التنفيذ آمن ومتكرر: يمكن تشغيله أكثر من مرة دون أخطاء.
--
--  ملاحظة: حساب الموظف السابق (1012345678) يبقى حساب مراجع عادياً معزولاً
--  كأي مريض. لحذف الحساب نفسه: Authentication → Users في لوحة Supabase.
-- ============================================================================

begin;

-- 1) سياسات الموظفين على الزيارات
drop policy if exists staff_read_visits   on public.visits;
drop policy if exists staff_update_visits on public.visits;

-- 2) عرض بيانات المراجعين للموظفين (يعتمد على is_staff، لذلك يُحذف أولاً)
drop view if exists public.staff_patients;

-- 3) الدالة التي تتحقق من عضوية الموظف
--    نتحقق من وجود الجدول أولاً: عبارة "drop policy ... on public.staff"
--    تفشل إذا كان الجدول محذوفاً، فيتعطل الملف عند إعادة تشغيله.
do $$
begin
  if to_regclass('public.staff') is not null then
    execute 'drop policy if exists staff_select_self on public.staff';
  end if;
end $$;

drop function if exists public.is_staff();

-- 4) جدول الموظفين نفسه
drop table if exists public.staff;

commit;

-- ============================================================================
--  الجزء الذي نُقل من هذا الملف إلى schema.sql (يبقى مطلوباً في القاعدة)
--  إن كانت القاعدة قد شغّلت النسخة القديمة من staff.sql فهذان العنصران
--  موجودان أصلاً؛ إعادة تعريفهما آمنة وتضمنان نفس الحماية.
-- ============================================================================

-- حماية هوية الزيارة: لا يمكن نقل زيارة إلى مريض آخر أو تغيير معرّفها.
create or replace function public.visits_guard_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.created_at is distinct from old.created_at then
    raise exception 'visit identity columns are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists visits_guard_update on public.visits;
create trigger visits_guard_update
  before update on public.visits
  for each row execute function public.visits_guard_update();

-- updated_at يحترم القيمة المرسلة صراحةً (يستخدمه التطبيق عند تغيير رمز الدخول).
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.updated_at is not null
     and new.updated_at is distinct from old.updated_at then
    return new;
  end if;
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
--  تحقق سريع بعد التنفيذ
-- ============================================================================
-- select tablename, policyname, cmd from pg_policies
-- where schemaname = 'public' and tablename in ('patients', 'visits', 'notes')
-- order by tablename, policyname;   -- يجب ألا تظهر أي سياسة باسم staff_*

-- select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname in ('is_staff');   -- يجب أن تكون فارغة

-- select count(*) from public.patients;   -- العدد لم يتغيّر

notify pgrst, 'reload schema';
