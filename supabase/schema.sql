-- ============================================================================
--  الرعاية العاجلة — مخطط Supabase الكامل
--  انسخ هذا الملف كاملاً والصقه في: Supabase Dashboard → SQL Editor → New query
--  ثم اضغط Run.
--
--  ما ينشئه هذا الملف:
--    1. جدول patients  : بيانات المريض الأساسية + ملح التشفير (صف واحد لكل مستخدم)
--    2. جدول visits    : زيارات المريض وحالة المزامنة مع رقيم/صحتي
--    3. جدول notes     : الملاحظات، محفوظة كحمولة مشفّرة (AES-256-GCM) من المتصفح
--    4. الفهارس، ومُشغّل updated_at
--    5. تفعيل RLS وسياسات تمنع أي مستخدم من رؤية أو تعديل صفوف غيره
--    6. سحب كل الصلاحيات من anon ومنحها للمستخدمين المسجّلين فقط
--
--  مهم:
--    · شغّل الملف مرة واحدة على مشروع جديد. إعادة تشغيله آمنة نسبياً
--      (الجداول if not exists، والسياسات تُحذف ثم تُنشأ).
--    · لا تستخدم مفتاح service_role في الواجهة أبداً. المفتاح العام (anon /
--      publishable) فقط هو الذي يوضع في assets/js/supabase-config.js.
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
-- 1) جدول المرضى
--    لا يُخزَّن رقم الوثيقة الخام؛ فقط بصمة SHA-256 ورقم مُقنّع للعرض.
--    salt عام وليس سراً: يُستخدم لاشتقاق مفتاح تشفير الملاحظات من رمز الدخول.
-- ============================================================================
create table if not exists public.patients (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  doc_type        text not null check (doc_type in ('nid', 'iqama', 'passport')),
  doc_fingerprint text not null,
  masked_doc      text not null,
  birth_date      date,
  phone           text not null default '',
  category        text not null default 'citizen'
                    check (category in ('citizen', 'domestic', 'insured')),
  insurer         text,
  policy_number   text,
  salt            text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint patients_doc_fingerprint_key unique (doc_fingerprint)
);

comment on table public.patients is 'ملف المريض الأساسي — صف واحد لكل مستخدم Supabase Auth';
comment on column public.patients.doc_fingerprint is 'SHA-256(doc_type + ":" + doc_number) — لا يُخزَّن رقم الوثيقة نفسه';
comment on column public.patients.salt is 'ملح PBKDF2 لاشتقاق مفتاح تشفير الملاحظات (ليس سراً)';

-- ============================================================================
-- 2) جدول الزيارات
-- ============================================================================
create table if not exists public.visits (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  queue_number integer,
  status       text not null default 'waiting'
                 check (status in ('waiting', 'called', 'done', 'cancelled')),
  reason       text,
  sync         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.visits is 'زيارات المريض وحالة الإرسال إلى رقيم/صحتي';
comment on column public.visits.sync is 'مثال: {"raqeem":{"status":"ok"},"sehhaty":{"status":"wait"}}';

-- ============================================================================
-- 3) جدول الملاحظات
--    payload شكلها: {"v":1,"iv":"...","d":"..."} — نص مشفّر في المتصفح.
--    القاعدة لا تستطيع قراءة عنوان الملاحظة أو نصها.
-- ============================================================================
create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  payload    jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint notes_payload_object check (jsonb_typeof(payload) = 'object')
);

comment on table public.notes is 'ملاحظات المريض — حمولة مشفّرة من طرف العميل';
comment on column public.notes.payload is 'AES-256-GCM ciphertext: {"v":1,"iv":"base64","d":"base64"}';

-- ============================================================================
-- 4) الفهارس
-- ============================================================================
create index if not exists patients_doc_fingerprint_idx on public.patients (doc_fingerprint);
create index if not exists visits_user_created_idx        on public.visits (user_id, created_at desc);
create index if not exists notes_user_created_idx         on public.notes (user_id, created_at desc);

-- ============================================================================
-- 5) تحديث updated_at تلقائياً
-- ============================================================================
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists patients_touch_updated_at on public.patients;
create trigger patients_touch_updated_at
  before update on public.patients
  for each row execute function public.touch_updated_at();

drop trigger if exists visits_touch_updated_at on public.visits;
create trigger visits_touch_updated_at
  before update on public.visits
  for each row execute function public.touch_updated_at();

drop trigger if exists notes_touch_updated_at on public.notes;
create trigger notes_touch_updated_at
  before update on public.notes
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- 6) تفعيل RLS
--    بعد التفعيل لا يرى المستخدم إلا الصفوف التي user_id = auth.uid().
--    حتى لو حصل أحدهم على المفتاح العام، لن يستطيع قراءة بيانات غيره.
-- ============================================================================
alter table public.patients enable row level security;
alter table public.visits   enable row level security;
alter table public.notes    enable row level security;

-- ------------------------- patients -----------------------------------------
drop policy if exists patients_select_own on public.patients;
create policy patients_select_own
  on public.patients for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists patients_insert_own on public.patients;
create policy patients_insert_own
  on public.patients for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists patients_update_own on public.patients;
create policy patients_update_own
  on public.patients for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists patients_delete_own on public.patients;
create policy patients_delete_own
  on public.patients for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ------------------------- visits -------------------------------------------
drop policy if exists visits_select_own on public.visits;
create policy visits_select_own
  on public.visits for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists visits_insert_own on public.visits;
create policy visits_insert_own
  on public.visits for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists visits_update_own on public.visits;
create policy visits_update_own
  on public.visits for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists visits_delete_own on public.visits;
create policy visits_delete_own
  on public.visits for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ------------------------- notes --------------------------------------------
drop policy if exists notes_select_own on public.notes;
create policy notes_select_own
  on public.notes for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists notes_insert_own on public.notes;
create policy notes_insert_own
  on public.notes for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists notes_update_own on public.notes;
create policy notes_update_own
  on public.notes for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists notes_delete_own on public.notes;
create policy notes_delete_own
  on public.notes for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================================
-- 7) الصلاحيات
--    anon (الزائر غير المسجّل) لا يملك أي صلاحية على الجداول.
--    authenticated يملك CRUD، لكن RLS تحدّد الصفوف المسموحة.
-- ============================================================================
revoke all on table public.patients from anon;
revoke all on table public.patients from public;
revoke all on table public.visits   from anon;
revoke all on table public.visits   from public;
revoke all on table public.notes    from anon;
revoke all on table public.notes    from public;

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.patients to authenticated;
grant select, insert, update, delete on table public.visits   to authenticated;
grant select, insert, update, delete on table public.notes    to authenticated;

-- ============================================================================
-- 8) تحقق سريع (اختياري)
--    يجب أن تظهر الجداول الثلاثة بـ rowsecurity = true، و12 سياسة تقريباً.
-- ============================================================================
-- select tablename, rowsecurity
-- from pg_tables
-- where schemaname = 'public' and tablename in ('patients', 'visits', 'notes');

-- select tablename, policyname, cmd, roles
-- from pg_policies
-- where schemaname = 'public' and tablename in ('patients', 'visits', 'notes')
-- order by tablename, cmd;
