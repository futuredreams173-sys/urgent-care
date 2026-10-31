/* ==========================================================================
   الرعاية العاجلة — طبقة السحابة (Supabase)
   --------------------------------------------------------------------------
   تحل هذه الطبقة محل كل دوال التخزين المحلي:
     · إنشاء حساب/دخول عبر بريد اصطناعي مشتق من بصمة الوثيقة + رمز الدخول
     · جلب الملف (بيانات المريض + الزيارات + الملاحظات)
     · إضافة/تعديل/حذف الملاحظات
     · تسجيل الخروج

   الخصوصية:
     · لا يُحفظ رقم الوثيقة نفسه؛ يُحفظ فقط SHA-256 (بصمة) ورقم مُقنّع.
     · نص الملاحظة يُشفّر في المتصفح (AES-256-GCM) قبل الإرسال؛ قاعدة البيانات
       لا ترى إلا حمولة مشفّرة.
     · RLS في Supabase يضمن أن كل صف لا يقرأه أو يعدّله إلا صاحبه.

   لا يُستخدم هنا مفتاح service_role إطلاقاً — المفتاح العام فقط.
   ========================================================================== */
(function (global) {
  'use strict';

  var C = global.EnayaCrypto;
  var CONFIG = global.URGENT_CARE_SUPABASE || {};

  var SUPABASE_URL = String(CONFIG.url || '').trim().replace(/\/+$/, '');
  var SUPABASE_KEY = String(CONFIG.anonKey || CONFIG.publishableKey || '').trim();
  var EMAIL_DOMAIN = String(CONFIG.emailDomain || 'patients.urgentcare.app').trim().replace(/^@/, '');

  var TABLES = {
    patients: 'patients',
    visits: 'visits',
    notes: 'notes',
    staff: 'staff',
    staffPatients: 'staff_patients',
  };
  var TITLE_MAX = 80;
  var BODY_MAX = 2000;
  var PIN_MIN = 6;
  var PIN_MAX = 72;
  var VISIT_STATUSES = { waiting: 1, called: 1, done: 1, cancelled: 1 };

  var client = null;
  var session = { user: null, patient: null, key: null, email: null, demoKey: null };
  var demo = { accounts: {} };

  // ─── أدوات ──────────────────────────────────────────────────────────────────

  function apiError(code, extra) {
    var error = new Error(code);
    error.code = code;
    if (extra) Object.assign(error, extra);
    return error;
  }

  function isConfigured() {
    return (
      /^https:\/\/[a-z0-9.-]+$/i.test(SUPABASE_URL) &&
      SUPABASE_KEY.length > 20 &&
      !/YOUR|REPLACE|PASTE|EXAMPLE|<|>/i.test(SUPABASE_KEY)
    );
  }

  function getSessionStorage() {
    try {
      var store = global.sessionStorage;
      var probe = '__urgent_care_probe__';
      store.setItem(probe, '1');
      store.removeItem(probe);
      return store;
    } catch (error) {
      var memory = {};
      return {
        getItem: function (key) { return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null; },
        setItem: function (key, value) { memory[key] = String(value); },
        removeItem: function (key) { delete memory[key]; },
      };
    }
  }

  function getClient() {
    if (client) return client;
    if (!isConfigured()) throw apiError('CLOUD_NOT_CONFIGURED');
    if (!global.supabase || typeof global.supabase.createClient !== 'function') {
      throw apiError('CLOUD_LIB_MISSING');
    }

    client = global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: 'pkce',
        storage: getSessionStorage(),
        storageKey: 'urgent-care-auth',
      },
      global: { headers: { 'x-client-info': 'urgent-care-web' } },
    });

    return client;
  }

  function resetSession() {
    session = { user: null, patient: null, key: null, email: null, demoKey: null };
  }

  function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
  }

  /** يوحّد رقم الجوال: أرقام عربية/فارسية، 00966، +966، أو 5xxxxxxxx. */
  function normalizePhone(value) {
    var v = String(value || '')
      .replace(/[٠-٩]/g, function (d) { return String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)); })
      .replace(/[۰-۹]/g, function (d) { return String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)); })
      .replace(/\D/g, '');
    if (v.indexOf('00966') === 0) v = v.slice(5);
    else if (v.indexOf('966') === 0) v = v.slice(3);
    if (v.length === 9 && v.charAt(0) === '5') v = '0' + v;
    return v;
  }

  function mapAuthError(error) {
    var message = String((error && error.message) || '').toLowerCase();

    if (message.indexOf('invalid login credentials') >= 0) return apiError('INVALID_PIN');
    if (message.indexOf('email not confirmed') >= 0) return apiError('EMAIL_NOT_CONFIRMED');
    if (message.indexOf('email address') >= 0 && message.indexOf('invalid') >= 0) {
      return apiError('EMAIL_DOMAIN_INVALID');
    }
    if (message.indexOf('already registered') >= 0 || message.indexOf('already been registered') >= 0) {
      return apiError('ACCOUNT_EXISTS');
    }
    if (message.indexOf('password') >= 0 && message.indexOf('6') >= 0) return apiError('errPinShort');
    if (message.indexOf('rate limit') >= 0) return apiError('CLOUD_RATE_LIMIT');
    if (message.indexOf('user not found') >= 0) return apiError('INVALID_PIN');
    if (message.indexOf('failed to fetch') >= 0 || message.indexOf('network') >= 0) return apiError('errCloud');

    return apiError('errCloud', { detail: (error && error.message) || 'AUTH_ERROR' });
  }

  function mapPinError(error) {
    var message = String((error && error.message) || '').toLowerCase();

    if (message.indexOf('different from the old') >= 0 || message.indexOf('same password') >= 0) {
      return apiError('PIN_SAME');
    }
    if (message.indexOf('weak') >= 0 || message.indexOf('pwned') >= 0 || message.indexOf('leaked') >= 0) {
      return apiError('PIN_WEAK');
    }
    if (message.indexOf('at least') >= 0 || message.indexOf('too short') >= 0) return apiError('errPinShort');
    if (message.indexOf('too long') >= 0 || message.indexOf('at most') >= 0) return apiError('errPinLong');
    if (message.indexOf('rate limit') >= 0 || message.indexOf('for security purposes') >= 0) {
      return apiError('CLOUD_RATE_LIMIT');
    }
    if (message.indexOf('failed to fetch') >= 0 || message.indexOf('network') >= 0) return apiError('errCloud');

    return apiError('errCloud', { detail: (error && error.message) || 'PIN_ERROR' });
  }

  function mapDbError(error) {
    var code = error && error.code;
    var message = String((error && error.message) || '').toLowerCase();

    if (code === '23505' || message.indexOf('duplicate key') >= 0) return apiError('ACCOUNT_EXISTS');
    if (code === '42501' || message.indexOf('row-level security') >= 0) return apiError('CLOUD_DENIED');
    if (code === 'PGRST116' || message.indexOf('0 rows') >= 0) return apiError('NOT_FOUND');
    if (message.indexOf('failed to fetch') >= 0 || message.indexOf('network') >= 0) return apiError('errCloud');
    if (message.indexOf('jwt') >= 0 || message.indexOf('session') >= 0) return apiError('SESSION_EXPIRED');

    return apiError('errCloud', { detail: (error && error.message) || 'DB_ERROR' });
  }

  function throwIfError(result) {
    if (result && result.error) throw mapDbError(result.error);
    return result ? result.data : null;
  }

  async function emailFor(docType, docNumber) {
    var fingerprint = await C.fingerprint(docType, docNumber);
    return { fingerprint: fingerprint, email: fingerprint + '@' + EMAIL_DOMAIN };
  }

  function accountFromPatient(patient) {
    return {
      id: patient.user_id,
      docType: patient.doc_type,
      masked: patient.masked_doc,
      createdAt: patient.created_at,
    };
  }

  function profileFromPatient(patient) {
    return {
      docType: patient.doc_type,
      docNumber: '',
      masked: patient.masked_doc,
      birthDate: patient.birth_date || '',
      phone: patient.phone || '',
      category: patient.category || 'citizen',
      insurer: patient.insurer || '',
      policyNumber: patient.policy_number || '',
      createdAt: patient.created_at,
    };
  }

  function visitFromRow(row) {
    return {
      id: row.id,
      queueNumber: row.queue_number,
      status: row.status || 'waiting',
      reason: row.reason || null,
      createdAt: row.created_at,
      sync: row.sync || {},
    };
  }

  function noteFromParts(id, title, body, createdAt, updatedAt) {
    return {
      id: id,
      title: title || '',
      body: body || '',
      createdAt: createdAt,
      updatedAt: updatedAt || createdAt,
    };
  }

  function cleanNote(title, body) {
    var cleanTitle = String(title || '').trim().slice(0, TITLE_MAX);
    var cleanBody = String(body || '').trim().slice(0, BODY_MAX);
    if (!cleanTitle && !cleanBody) throw apiError('errRequired');
    return { title: cleanTitle, body: cleanBody };
  }

  function cleanPin(pin) {
    var value = String(pin === null || pin === undefined ? '' : pin);
    if (value.length < PIN_MIN) throw apiError('errPinShort');
    if (value.length > PIN_MAX) throw apiError('errPinLong');
    return value;
  }

  function demoId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  // ─── قراءة الملف كاملاً ──────────────────────────────────────────────────────

  async function fetchRecordData(userId, key) {
    var c = getClient();
    var results = await Promise.all([
      c.from(TABLES.patients).select('*').eq('user_id', userId).maybeSingle(),
      c.from(TABLES.visits).select('*').eq('user_id', userId).order('created_at', { ascending: false }),
      c.from(TABLES.notes).select('*').eq('user_id', userId).order('created_at', { ascending: false }),
    ]);

    var patient = throwIfError(results[0]);
    var visits = throwIfError(results[1]) || [];
    var notes = throwIfError(results[2]) || [];

    if (!patient) throw apiError('NOT_FOUND');

    var decrypted = [];
    for (var i = 0; i < notes.length; i += 1) {
      var row = notes[i];
      try {
        var payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        var plain = await C.decryptString(payload, key);
        var parsed = JSON.parse(plain);
        decrypted.push(noteFromParts(row.id, parsed.title, parsed.body, row.created_at, row.updated_at));
      } catch (error) {
        // ملاحظة تالفة أو مفتاح غير مطابق: لا نُسقط بقية الملف.
        if (global.console && global.console.warn) {
          global.console.warn('[urgent-care] note could not be decrypted', row && row.id);
        }
      }
    }

    return {
      profile: profileFromPatient(patient),
      visits: visits.map(visitFromRow),
      notes: decrypted,
      mode: 'cloud',
      updatedAt: new Date().toISOString(),
    };
  }

  // ─── التسجيل ────────────────────────────────────────────────────────────────

  async function register(input) {
    if (!isConfigured()) return demoRegister(input);

    var c = getClient();
    var identity = await emailFor(input.docType, input.docNumber);

    // لا نكتب ملف مستخدم داخل جلسة مستخدم آخر.
    var current = await c.auth.getSession();
    var currentEmail = current && current.data && current.data.session && current.data.session.user
      ? String(current.data.session.user.email || '').toLowerCase()
      : '';
    if (currentEmail && currentEmail !== identity.email.toLowerCase()) {
      await c.auth.signOut();
      resetSession();
    }

    var userId = null;
    var existingPatient = null;

    var signedIn = await c.auth.signInWithPassword({ email: identity.email, password: input.pin });

    if (!signedIn.error && signedIn.data && signedIn.data.user) {
      userId = signedIn.data.user.id;
      existingPatient = throwIfError(
        await c.from(TABLES.patients).select('*').eq('user_id', userId).maybeSingle()
      );
    } else {
      var authMessage = String((signedIn.error && signedIn.error.message) || '').toLowerCase();
      if (authMessage && authMessage.indexOf('invalid login credentials') < 0) throw mapAuthError(signedIn.error);

      var signedUp = await c.auth.signUp({ email: identity.email, password: input.pin });
      if (signedUp.error) throw mapAuthError(signedUp.error);
      if (!signedUp.data || !signedUp.data.session || !signedUp.data.user) {
        var identities = signedUp.data && signedUp.data.user && signedUp.data.user.identities;
        if (Array.isArray(identities) && identities.length === 0) throw apiError('ACCOUNT_EXISTS');
        throw apiError('EMAIL_NOT_CONFIRMED');
      }
      userId = signedUp.data.user.id;
    }

    // ملح التشفير ثابت لهذا المريض؛ يُنشأ مرة واحدة ويُستخدم لاشتقاق مفتاح الملاحظات.
    var salt = existingPatient ? existingPatient.salt : C.newSalt();
    var key = await C.deriveKey(input.pin, salt);

    var profile = input.profile || {};
    var patientRow = {
      user_id: userId,
      doc_type: input.docType,
      doc_fingerprint: identity.fingerprint,
      masked_doc: profile.masked || C.mask(input.docNumber),
      birth_date: profile.birthDate || null,
      phone: profile.phone || '',
      category: profile.category || 'citizen',
      insurer: profile.insurer || null,
      policy_number: profile.policyNumber || null,
      salt: salt,
    };
    if (existingPatient) patientRow.created_at = existingPatient.created_at;

    var savedPatient = throwIfError(
      await c.from(TABLES.patients).upsert(patientRow, { onConflict: 'user_id' }).select().single()
    );

    var savedVisit = null;
    if (input.visit) {
      var visitRow = {
        user_id: userId,
        queue_number: input.visit.queueNumber === null || input.visit.queueNumber === undefined
          ? null
          : Number(input.visit.queueNumber),
        status: input.visit.status || 'waiting',
        reason: input.visit.reason || null,
        sync: input.visit.sync || {},
        created_at: input.visit.createdAt || new Date().toISOString(),
      };
      if (isUuid(input.visit.id)) visitRow.id = input.visit.id;

      if (visitRow.queue_number === null || isNaN(visitRow.queue_number)) {
        var counted = await c.from(TABLES.visits).select('id', { count: 'exact', head: true }).eq('user_id', userId);
        if (counted.error) throw mapDbError(counted.error);
        visitRow.queue_number = 101 + (counted.count || 0);
      }

      savedVisit = throwIfError(
        await c.from(TABLES.visits).insert(visitRow).select().single()
      );
    }

    session = {
      user: { id: userId, email: identity.email },
      patient: savedPatient,
      key: key,
      email: identity.email,
      demoKey: null,
    };

    return {
      account: accountFromPatient(savedPatient),
      data: await fetchRecordData(userId, key),
      visit: savedVisit ? visitFromRow(savedVisit) : null,
    };
  }

  // ─── الدخول ─────────────────────────────────────────────────────────────────

  async function login(docType, docNumber, pin, phone) {
    if (!isConfigured()) return demoLogin(docType, docNumber, pin, phone);

    var c = getClient();
    var identity = await emailFor(docType, docNumber);

    var signedIn = await c.auth.signInWithPassword({ email: identity.email, password: pin });
    if (signedIn.error) throw mapAuthError(signedIn.error);
    if (!signedIn.data || !signedIn.data.user) throw apiError('INVALID_PIN');

    var userId = signedIn.data.user.id;
    var patient = throwIfError(
      await c.from(TABLES.patients).select('*').eq('user_id', userId).maybeSingle()
    );
    if (!patient) {
      try { await c.auth.signOut(); } catch (error) { /* تجاهل */ }
      resetSession();
      throw apiError('NOT_FOUND');
    }

    var registeredPhone = normalizePhone(patient.phone);
    if (registeredPhone && normalizePhone(phone) !== registeredPhone) {
      try { await c.auth.signOut(); } catch (error) { /* تجاهل */ }
      resetSession();
      throw apiError('PHONE_MISMATCH');
    }

    var key = await C.deriveKey(pin, patient.salt);
    session = {
      user: { id: userId, email: identity.email },
      patient: patient,
      key: key,
      email: identity.email,
      demoKey: null,
    };

    return {
      account: accountFromPatient(patient),
      data: await fetchRecordData(userId, key),
    };
  }

  async function logout() {
    resetSession();
    if (!isConfigured()) return;
    try {
      await getClient().auth.signOut();
    } catch (error) {
      /* مسح الجلسة المحلية يكفي */
    }
  }

  async function refresh() {
    if (!session.user) throw apiError('NOT_FOUND');
    if (!isConfigured()) return clone(demo.accounts[session.demoKey].data);
    return fetchRecordData(session.user.id, session.key);
  }

  // ─── الملاحظات (إضافة / تعديل / حذف) ────────────────────────────────────────

  async function addNote(title, body) {
    var note = cleanNote(title, body);
    if (!isConfigured()) return demoAddNote(note);

    if (!session.user || !session.key) throw apiError('NOT_FOUND');
    var c = getClient();
    var payload = await C.encryptString(JSON.stringify(note), session.key);

    var row = throwIfError(
      await c.from(TABLES.notes)
        .insert({ user_id: session.user.id, payload: payload })
        .select()
        .single()
    );

    return noteFromParts(row.id, note.title, note.body, row.created_at, row.updated_at);
  }

  async function updateNote(id, title, body) {
    var note = cleanNote(title, body);
    if (!isConfigured()) return demoUpdateNote(id, note);

    if (!session.user || !session.key) throw apiError('NOT_FOUND');
    var c = getClient();
    var payload = await C.encryptString(JSON.stringify(note), session.key);

    var row = throwIfError(
      await c.from(TABLES.notes)
        .update({ payload: payload })
        .eq('id', id)
        .eq('user_id', session.user.id)
        .select()
        .single()
    );

    return noteFromParts(row.id, note.title, note.body, row.created_at, row.updated_at);
  }

  async function deleteNote(id) {
    if (!isConfigured()) return demoDeleteNote(id);

    if (!session.user) throw apiError('NOT_FOUND');
    var c = getClient();
    var result = await c.from(TABLES.notes)
      .delete()
      .eq('id', id)
      .eq('user_id', session.user.id);

    if (result.error) throw mapDbError(result.error);
    return { id: id };
  }

  // ─── تغيير رمز الدخول (إعادة تشفير الملاحظات) ───────────────────────────────

  /**
   * يغيّر رمز الدخول مع الحفاظ على الملاحظات:
   *   1. يتحقق من الرمز الحالي عبر خادم Supabase (إعادة تسجيل دخول).
   *   2. يفك تشفير كل الملاحظات بالمفتاح القديم.
   *   3. يشفّرها مسبقاً بالمفتاح الجديد (قبل أي كتابة).
   *   4. يحدّث كلمة مرور الحساب.
   *   5. يكتب الحمولات الجديدة، ويرجع كل شيء للحالة الأصلية عند أي فشل.
   */
  async function changePin(currentPin, newPin) {
    var current = String(currentPin === null || currentPin === undefined ? '' : currentPin);
    var next = cleanPin(newPin);

    if (!current) throw apiError('errRequired');
    if (current === next) throw apiError('PIN_SAME');

    if (!isConfigured()) return demoChangePin(current, next);

    if (!session.user || !session.patient || !session.key) throw apiError('NOT_FOUND');

    var c = getClient();
    var userId = session.user.id;
    var email = session.email;
    var salt = session.patient.salt;

    // 1) تحقق الخادم من الرمز الحالي
    var reauth = await c.auth.signInWithPassword({ email: email, password: current });
    if (reauth.error || !reauth.data || !reauth.data.user || reauth.data.user.id !== userId) {
      throw apiError('WRONG_PIN');
    }

    // 2) فك تشفير كل الملاحظات قبل أي تعديل
    var rows = throwIfError(
      await c.from(TABLES.notes)
        .select('id,payload,updated_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
    ) || [];

    var oldKey = await C.deriveKey(current, salt);
    var plains = [];
    for (var i = 0; i < rows.length; i += 1) {
      try {
        plains.push({
          id: rows[i].id,
          plain: await C.decryptString(rows[i].payload, oldKey),
          payload: rows[i].payload,
          updatedAt: rows[i].updated_at,
        });
      } catch (error) {
        // ملاحظة لا تُفك بالرمز الحالي: نوقف العملية بدل إتلافها.
        throw apiError('NOTES_LOCKED');
      }
    }

    // 3) تشفير مسبق بالمفتاح الجديد — لا نكتب شيئاً قبل نجاح هذه الخطوة كاملة
    var newKey = await C.deriveKey(next, salt);
    var sealed = [];
    for (var j = 0; j < plains.length; j += 1) {
      sealed.push({
        id: plains[j].id,
        payload: await C.encryptString(plains[j].plain, newKey),
        updatedAt: plains[j].updatedAt,
      });
    }

    // 4) تحديث كلمة مرور الحساب في Supabase Auth
    var updated = await c.auth.updateUser({ password: next });
    if (updated.error) throw mapPinError(updated.error);

    // 5) كتابة الملاحظات، مع تراجع كامل عند أي فشل
    try {
      for (var k = 0; k < sealed.length; k += 1) {
        var res = await c.from(TABLES.notes)
          .update({ payload: sealed[k].payload, updated_at: sealed[k].updatedAt })
          .eq('id', sealed[k].id)
          .eq('user_id', userId)
          .select('id')
          .maybeSingle();
        if (res.error) throw mapDbError(res.error);
        if (!res.data) throw apiError('CLOUD_DENIED');
      }
    } catch (error) {
      var rollbackFailed = false;

      for (var m = 0; m < plains.length; m += 1) {
        var back = await c.from(TABLES.notes)
          .update({ payload: plains[m].payload, updated_at: plains[m].updatedAt })
          .eq('id', plains[m].id)
          .eq('user_id', userId);
        if (back.error) rollbackFailed = true;
      }

      var restored = await c.auth.updateUser({ password: current });
      if (restored.error) rollbackFailed = true;

      if (rollbackFailed) throw apiError('PIN_ROLLBACK');
      throw error;
    }

    session.key = newKey;
    return { changed: true, notes: sealed.length };
  }

  // ─── الموظفون ───────────────────────────────────────────────────────────────

  /**
   * دخول فريق المركز: نفس رقم الوثيقة ورمز الدخول، ثم التحقق من عضوية
   * جدول staff على الخادم. أي حساب غير موظف يُفصل فوراً.
   */
  async function staffLogin(docType, docNumber, pin) {
    if (!isConfigured()) return demoStaffLogin(docType, docNumber, pin);

    var c = getClient();
    var identity = await emailFor(docType, docNumber);

    var signedIn = await c.auth.signInWithPassword({ email: identity.email, password: pin });
    if (signedIn.error) throw mapAuthError(signedIn.error);
    if (!signedIn.data || !signedIn.data.user) throw apiError('INVALID_PIN');

    var userId = signedIn.data.user.id;

    var check = await c.rpc('is_staff');
    if (check.error) {
      await signOutQuietly(c);
      if (isMissingFunction(check.error)) throw apiError('STAFF_SETUP_REQUIRED');
      throw mapDbError(check.error);
    }

    if (check.data !== true) {
      await signOutQuietly(c);
      throw apiError('NOT_STAFF');
    }

    var row = null;
    var profile = await c.from(TABLES.staff)
      .select('full_name,role,created_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (!profile.error && profile.data) row = profile.data;

    session = {
      user: { id: userId, email: identity.email },
      patient: null,
      key: null,
      email: identity.email,
      demoKey: null,
    };

    return {
      staff: {
        id: userId,
        name: (row && row.full_name) || '',
        role: (row && row.role) || 'staff',
        since: (row && row.created_at) || null,
      },
      visits: await staffVisits(),
      patients: await staffPatients(),
    };
  }

  function isMissingFunction(error) {
    var code = error && error.code;
    var message = String((error && error.message) || '').toLowerCase();
    return code === 'PGRST202' || message.indexOf('could not find the function') >= 0 ||
      message.indexOf('does not exist') >= 0 || code === '42883';
  }

  async function signOutQuietly(c) {
    try { await c.auth.signOut(); } catch (error) { /* تجاهل */ }
    resetSession();
  }

  /** يقرأ الزيارات وبيانات المراجع المحدودة التي تسمح بها سياسات الموظفين. */
  async function staffVisits() {
    if (!isConfigured()) return demoStaffVisits();
    if (!session.user) throw apiError('NOT_FOUND');

    var c = getClient();
    var results = await Promise.all([
      c.from(TABLES.visits).select('*').order('created_at', { ascending: false }).limit(300),
      c.from(TABLES.staffPatients)
        .select('user_id,doc_type,masked_doc,phone,category,birth_date,created_at')
        .limit(500),
    ]);

    var visits = throwIfError(results[0]) || [];
    var patients = throwIfError(results[1]) || [];

    var byUser = {};
    patients.forEach(function (patient) { byUser[patient.user_id] = patient; });

    return visits.map(function (row) {
      var patient = byUser[row.user_id] || null;
      return {
        id: row.id,
        userId: row.user_id,
        queueNumber: row.queue_number,
        status: VISIT_STATUSES[row.status] ? row.status : 'waiting',
        reason: row.reason || null,
        createdAt: row.created_at,
        patient: patient
          ? {
            docType: patient.doc_type,
            masked: patient.masked_doc,
            phone: patient.phone,
            category: patient.category,
            since: patient.created_at,
          }
          : null,
      };
    });
  }

  /**
   * يقرأ كل المرضى المسجّلين من العرض المحدود staff_patients
   * (بلا بصمة الوثيقة وبلا ملح التشفير) مع عدد زيارات كل واحد.
   */
  async function staffPatients() {
    if (!isConfigured()) return demoStaffPatients();
    if (!session.user) throw apiError('NOT_FOUND');

    var c = getClient();
    var results = await Promise.all([
      c.from(TABLES.staffPatients)
        .select('user_id,doc_type,masked_doc,phone,category,birth_date,created_at')
        .order('created_at', { ascending: false })
        .limit(1000),
      c.from(TABLES.visits)
        .select('user_id')
        .limit(5000),
    ]);

    var patients = throwIfError(results[0]) || [];
    var visits = throwIfError(results[1]) || [];

    var counts = {};
    visits.forEach(function (row) {
      counts[row.user_id] = (counts[row.user_id] || 0) + 1;
    });

    return patients.map(function (row) {
      return {
        userId: row.user_id,
        docType: row.doc_type,
        masked: row.masked_doc,
        phone: row.phone,
        category: row.category,
        birthDate: row.birth_date,
        since: row.created_at,
        visits: counts[row.user_id] || 0,
      };
    });
  }

  /** يحدّث حالة زيارة واحدة — الأعمدة الأخرى محمية في القاعدة. */
  async function staffSetVisitStatus(visitId, status) {
    if (!VISIT_STATUSES[status]) throw apiError('errGeneric');

    if (!isConfigured()) return demoStaffSetStatus(visitId, status);
    if (!session.user) throw apiError('NOT_FOUND');

    var c = getClient();
    var row = throwIfError(
      await c.from(TABLES.visits)
        .update({ status: status })
        .eq('id', visitId)
        .select('id,status')
        .maybeSingle()
    );

    if (!row) throw apiError('CLOUD_DENIED');
    return { id: row.id, status: row.status };
  }

  // ─── الوضع التجريبي (عند غياب مفاتيح Supabase) ──────────────────────────────
  // يعمل في الذاكرة فقط لهذه الصفحة، ولا يكتب أي شيء على القرص أو localStorage.
  // الهدف إبقاء الواجهة قابلة للتجربة قبل ربط المشروع.

  async function demoRegister(input) {
    var identity = await emailFor(input.docType, input.docNumber);
    var entry = demo.accounts[identity.fingerprint];

    if (entry) {
      if (entry.pin !== input.pin) throw apiError('ACCOUNT_EXISTS');
    } else {
      entry = {
        pin: input.pin,
        account: {
          id: demoId('demo'),
          docType: input.docType,
          masked: (input.profile && input.profile.masked) || C.mask(input.docNumber),
          createdAt: new Date().toISOString(),
        },
        data: {
          profile: null,
          visits: [],
          notes: [],
          mode: 'demo',
          updatedAt: new Date().toISOString(),
        },
      };
      demo.accounts[identity.fingerprint] = entry;
    }

    var profile = input.profile || {};
    entry.data.profile = {
      docType: input.docType,
      docNumber: '',
      masked: profile.masked || C.mask(input.docNumber),
      birthDate: profile.birthDate || '',
      phone: profile.phone || '',
      category: profile.category || 'citizen',
      insurer: profile.insurer || '',
      policyNumber: profile.policyNumber || '',
      createdAt: (entry.data.profile && entry.data.profile.createdAt) || entry.account.createdAt,
    };

    var savedVisit = null;
    if (input.visit) {
      savedVisit = {
        id: isUuid(input.visit.id) ? input.visit.id : demoId('demo-visit'),
        queueNumber: input.visit.queueNumber === null || input.visit.queueNumber === undefined
          ? 101 + entry.data.visits.length
          : Number(input.visit.queueNumber),
        status: input.visit.status || 'waiting',
        reason: input.visit.reason || null,
        createdAt: input.visit.createdAt || new Date().toISOString(),
        sync: input.visit.sync || {},
      };
      entry.data.visits = [savedVisit].concat(entry.data.visits);
    }

    entry.data.updatedAt = new Date().toISOString();
    session = {
      user: { id: entry.account.id },
      patient: null,
      key: null,
      email: null,
      demoKey: identity.fingerprint,
    };

    return {
      account: clone(entry.account),
      data: clone(entry.data),
      visit: savedVisit ? clone(savedVisit) : null,
    };
  }

  async function demoLogin(docType, docNumber, pin, phone) {
    var identity = await emailFor(docType, docNumber);
    var entry = demo.accounts[identity.fingerprint];
    if (!entry) throw apiError('NOT_FOUND');
    if (entry.pin !== pin) throw apiError('INVALID_PIN');

    var registeredPhone = normalizePhone((entry.data.profile || {}).phone);
    if (registeredPhone && normalizePhone(phone) !== registeredPhone) throw apiError('PHONE_MISMATCH');

    session = {
      user: { id: entry.account.id },
      patient: null,
      key: null,
      email: null,
      demoKey: identity.fingerprint,
    };

    return { account: clone(entry.account), data: clone(entry.data) };
  }

  function demoEntry() {
    var entry = demo.accounts[session.demoKey];
    if (!entry) throw apiError('NOT_FOUND');
    return entry;
  }

  function demoAddNote(note) {
    var entry = demoEntry();
    var now = new Date().toISOString();
    var saved = noteFromParts(demoId('demo-note'), note.title, note.body, now, now);
    entry.data.notes = [saved].concat(entry.data.notes);
    entry.data.updatedAt = now;
    return clone(saved);
  }

  function demoUpdateNote(id, note) {
    var entry = demoEntry();
    var found = null;
    entry.data.notes = entry.data.notes.map(function (item) {
      if (item.id !== id) return item;
      found = noteFromParts(item.id, note.title, note.body, item.createdAt, new Date().toISOString());
      return found;
    });
    if (!found) throw apiError('NOT_FOUND');
    entry.data.updatedAt = new Date().toISOString();
    return clone(found);
  }

  function demoDeleteNote(id) {
    var entry = demoEntry();
    var before = entry.data.notes.length;
    entry.data.notes = entry.data.notes.filter(function (item) { return item.id !== id; });
    if (entry.data.notes.length === before) throw apiError('NOT_FOUND');
    entry.data.updatedAt = new Date().toISOString();
    return { id: id };
  }

  function demoChangePin(current, next) {
    var entry = demoEntry();
    if (entry.pin !== current) throw apiError('WRONG_PIN');
    entry.pin = next;
    return { changed: true, notes: entry.data.notes.length };
  }

  async function demoStaffLogin(docType, docNumber, pin) {
    var identity = await emailFor(docType, docNumber);
    var entry = demo.accounts[identity.fingerprint];
    if (!entry) throw apiError('NOT_FOUND');
    if (entry.pin !== pin) throw apiError('INVALID_PIN');

    session = {
      user: { id: entry.account.id },
      patient: null,
      key: null,
      email: null,
      demoKey: identity.fingerprint,
    };

    return {
      staff: { id: entry.account.id, name: '', role: 'staff', since: entry.account.createdAt },
      visits: demoStaffVisits(),
      patients: demoStaffPatients(),
    };
  }

  function demoStaffVisits() {
    var out = [];
    Object.keys(demo.accounts).forEach(function (fingerprint) {
      var entry = demo.accounts[fingerprint];
      var profile = entry.data.profile || {};
      (entry.data.visits || []).forEach(function (visit) {
        out.push({
          id: visit.id,
          userId: entry.account.id,
          queueNumber: visit.queueNumber,
          status: visit.status || 'waiting',
          reason: visit.reason || null,
          createdAt: visit.createdAt,
          patient: {
            docType: profile.docType || entry.account.docType,
            masked: profile.masked || entry.account.masked,
            phone: profile.phone || '',
            category: profile.category || 'citizen',
            since: entry.account.createdAt,
          },
        });
      });
    });

    return out.sort(function (a, b) {
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
  }

  function demoStaffPatients() {
    return Object.keys(demo.accounts).map(function (fingerprint) {
      var entry = demo.accounts[fingerprint];
      var profile = entry.data.profile || {};
      return {
        userId: entry.account.id,
        docType: profile.docType || entry.account.docType,
        masked: profile.masked || entry.account.masked,
        phone: profile.phone || '',
        category: profile.category || 'citizen',
        birthDate: profile.birthDate || '',
        since: entry.account.createdAt,
        visits: (entry.data.visits || []).length,
      };
    }).sort(function (a, b) {
      return String(b.since).localeCompare(String(a.since));
    });
  }

  function demoStaffSetStatus(visitId, status) {
    var found = null;
    Object.keys(demo.accounts).forEach(function (fingerprint) {
      (demo.accounts[fingerprint].data.visits || []).forEach(function (visit) {
        if (visit.id !== visitId) return;
        visit.status = status;
        found = { id: visitId, status: status };
      });
    });
    if (!found) throw apiError('NOT_FOUND');
    return found;
  }

  // ─── عدد المراجعين المسجّلين (رقم فقط، بلا أي بيانات شخصية) ────────────────

  async function registeredCount() {
    if (!isConfigured()) return null;
    try {
      var result = await getClient().rpc('registered_count');
      if (!result || result.error) return null;
      var value = result.data;
      if (typeof value === 'string') value = parseInt(value, 10);
      return typeof value === 'number' && isFinite(value) ? value : null;
    } catch (error) {
      return null;
    }
  }

  // ─── الواجهة العامة ─────────────────────────────────────────────────────────

  global.UrgentCloud = {
    init: function () {
      return {
        configured: isConfigured(),
        mode: isConfigured() ? 'cloud' : 'demo',
        url: SUPABASE_URL,
      };
    },

    get configured() { return isConfigured(); },
    get mode() { return isConfigured() ? 'cloud' : 'demo'; },
    get isDemo() { return !isConfigured(); },

    register: register,
    login: login,
    logout: logout,

    registeredCount: registeredCount,
    refresh: refresh,
    fetchRecord: refresh,

    addNote: addNote,
    updateNote: updateNote,
    deleteNote: deleteNote,

    changePin: changePin,

    staffLogin: staffLogin,
    staffVisits: staffVisits,
    staffPatients: staffPatients,
    staffSetVisitStatus: staffSetVisitStatus,
  };
})(window);
