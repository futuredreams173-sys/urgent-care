-- ============================================================================
--  الرعاية العاجلة — ترقية v2: لوحة الموظفين
--  شغّل هذا الملف مرة واحدة في: Supabase Dashboard → SQL Editor → New query → Run
--
--  ما ينشئه هذا الملف:
--    1. جدول public.staff        : عضوية الموظفين (لا يُضاف صف من الواجهة أبداً)
--    2. الدالة public.is_staff() : تحقق آمن (security definer) من صلاحية الموظف
--    3. عرض public.staff_patients: بيانات المراجع الأساسية فقط للموظفين
--                                   (بلا بصمة الوثيقة ولا ملح التشفير)
--    4. سياسات RLS              : الموظف يقرأ الزيارات ويحدّث حالتها فقط
--    5. حماية أعمدة الزيارة     : لا يمكن تغيير صاحب الزيارة أو معرّفها
--    6. تحسين updated_at        : احترام وقت التعديل عند إعادة تشفير الملاحظات
--    7. مساعد public.doc_email(): لتحويل رقم الوثيقة إلى بريد الحساب
--
--  ما لا يفعله (بالتصميم):
--    · لا يمنح الموظف أي صلاحية على جدول notes — ملاحظات المرضى تبقى غير قابلة
--      للقراءة من أي موظف، لأنها مشفّرة بمفتاح رمز دخول المريض.
--    · لا يسمح لأي مستخدم بترقية نفسه إلى موظف: لا توجد سياسة insert على staff.
--
--  ملاحظة: لا تحتاج إلى مفتاح service_role هنا. التنفيذ من SQL Editor فقط.
-- ============================================================================

-- ============================================================================
-- 1) جدول الموظفين
-- ============================================================================
create table if not exists public.staff (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null default '',
  role       text not null default 'staff' check (role in ('staff', 'admin')),
  created_at timestamptz not null default now()
);

comment on table public.staff is
  'أعضاء فريق المركز — يُضاف الصف من SQL Editor أو service_role فقط، ولا توجد سياسة إدراج للعميل';

alter table public.staff enable row level security;

drop policy if exists staff_select_self on public.staff;
create policy staff_select_self
  on public.staff for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- لا صلاحيات كتابة لأي دور عميل، وقراءة صف الموظف نفسه فقط.
revoke all on table public.staff from anon;
revoke all on table public.staff from authenticated;
revoke all on table public.staff from public;
grant select on table public.staff to authenticated;

-- ============================================================================
-- 2) دالة التحقق من صلاحية الموظف
--    security definer: تقرأ جدول staff متجاوزةً RLS، لكنها لا تكشف أي صف.
-- ============================================================================
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff s where s.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_staff() from public;
revoke all on function public.is_staff() from anon;
grant execute on function public.is_staff() to authenticated;

-- ============================================================================
-- 3) عرض بيانات المراجع للموظفين
--    الأعمدة المكشوفة محدودة: بلا doc_fingerprint وبلا salt.
--    الفلترة داخل العرض نفسه؛ من ليس موظفاً يحصل على صفر صفوف.
-- ============================================================================
create or replace view public.staff_patients
with (security_invoker = false)
as
select
  p.user_id,
  p.doc_type,
  p.masked_doc,
  p.birth_date,
  p.phone,
  p.category,
  p.created_at
from public.patients p
where public.is_staff();

comment on view public.staff_patients is
  'بيانات المراجع الأساسية للموظفين — بلا بصمة الوثيقة ولا ملح التشفير';

revoke all on public.staff_patients from anon;
revoke all on public.staff_patients from authenticated;
revoke all on public.staff_patients from public;
grant select on public.staff_patients to authenticated;

-- ============================================================================
-- 4) سياسات الزيارات للموظفين
-- ============================================================================
drop policy if exists staff_read_visits on public.visits;
create policy staff_read_visits
  on public.visits for select
  to authenticated
  using (public.is_staff());

drop policy if exists staff_update_visits on public.visits;
create policy staff_update_visits
  on public.visits for update
  to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- لا توجد أي سياسة على public.notes للموظفين. هذا مقصود.

-- ============================================================================
-- 5) حماية هوية الزيارة
--    حتى لو أرسل الموظف طلباً يدوياً، لا يمكنه نقل زيارة إلى مريض آخر.
-- ============================================================================
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

-- ============================================================================
-- 6) updated_at يحترم القيمة المرسلة صراحةً
--    يستخدمه التطبيق عند إعادة تشفير الملاحظات بعد تغيير رمز الدخول،
--    حتى لا تظهر كل الملاحظات القديمة كأنها «معدّلة».
-- ============================================================================
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
-- 7) مساعد إضافة موظف: بريد الحساب من رقم الوثيقة
--    نفس بصمة التطبيق: sha256('نوع الوثيقة:رقمها') + '@' + النطاق
-- ============================================================================
create or replace function public.doc_email(
  p_doc_type   text,
  p_doc_number text,
  p_domain     text default 'patients.urgentcare.app'
)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_doc_type || ':' || p_doc_number, 'UTF8')), 'hex')
         || '@' || p_domain;
$$;

comment on function public.doc_email(text, text, text) is
  'يحوّل نوع الوثيقة ورقمها إلى بريد الحساب الاصطناعي المستخدم في Supabase Auth';

-- ============================================================================
-- 8) إضافة موظف (استبدل القيم ثم شغّل هذا الجزء وحده)
-- ============================================================================
-- الخطوة 1: أنشئ حساب الموظف من صفحة «التسجيل الذاتي» في الموقع
--           (نوع الوثيقة + رقمها + رمز دخول يختاره بنفسه).
-- الخطوة 2: شغّل ما يلي بعد استبدال الرقم والاسم:
--
-- insert into public.staff (user_id, full_name, role)
-- select u.id, 'موظف الاستقبال', 'staff'
-- from auth.users u
-- where u.email = public.doc_email('nid', '1012345678')
-- on conflict (user_id) do update
--   set full_name = excluded.full_name,
--       role = excluded.role;
--
-- لإضافة مسؤول (يستطيع لاحقاً إدارة الحالات نفسها):
-- insert into public.staff (user_id, full_name, role)
-- select u.id, 'مسؤول المركز', 'admin'
-- from auth.users u
-- where u.email = public.doc_email('nid', '1012345678')
-- on conflict (user_id) do update set role = 'admin';
--
-- لإلغاء صلاحية موظف (يبقى حسابه كمراجع عادي):
-- delete from public.staff where user_id = (
--   select id from auth.users where email = public.doc_email('nid', '1012345678')
-- );

-- ============================================================================
-- 9) تحقق سريع
-- ============================================================================
-- select tablename, rowsecurity from pg_tables
-- where schemaname = 'public' and tablename in ('staff', 'visits', 'notes');

-- select tablename, policyname, cmd
-- from pg_policies
-- where schemaname = 'public' and tablename in ('staff', 'visits', 'notes')
-- order by tablename, policyname;

-- select p.proname, p.prosecdef
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname in ('is_staff', 'doc_email');
