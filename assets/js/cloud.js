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

  var TABLES = { patients: 'patients', visits: 'visits', notes: 'notes' };
  var TITLE_MAX = 80;
  var BODY_MAX = 2000;

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

  async function login(docType, docNumber, pin) {
    if (!isConfigured()) return demoLogin(docType, docNumber, pin);

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

  async function demoLogin(docType, docNumber, pin) {
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
    refresh: refresh,
    fetchRecord: refresh,

    addNote: addNote,
    updateNote: updateNote,
    deleteNote: deleteNote,
  };
})(window);
