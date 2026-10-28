/* ==========================================================================
   الرعاية العاجلة — عميل الواجهة البرمجية (HTTP)
   الواجهة لا تحتوي أي محاكاة ولا أي أسرار: كل التحقق والمزامنة على الخادم.
   إن لم يوجد خادم متاح تعمل المنصة في وضع محلي (ملف مشفّر على الجهاز فقط).
   ========================================================================== */
(function (global) {
  'use strict';

  var PROBE_TIMEOUT = 1800;
  var state = { base: null, online: false, checked: false, checking: null };

  function candidateBases() {
    var list = [];

    if (global.ENAYA_API) list.push(String(global.ENAYA_API).replace(/\/+$/, ''));

    var host = global.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      list.push('http://localhost:3311');
      list.push('http://localhost:3000');
    }

    // نفس الأصل (إن كان الخادم يقدّم الواجهة أيضاً).
    // نستثني مضيفي الاستضافة الثابتة لأن /health غير موجود عليها أصلاً.
    var staticHost = /\.github\.io$/i.test(host) || /\.gitlab\.io$/i.test(host) || /\.netlify\.app$/i.test(host);
    if (!staticHost) list.push('');

    return list.filter(function (item, index, all) {
      return all.indexOf(item) === index;
    });
  }

  async function probe(base) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, PROBE_TIMEOUT) : null;

    try {
      var response = await fetch(base + '/health', {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller ? controller.signal : undefined,
      });
      if (!timer) clearTimeout(timer);
      if (!response.ok) return false;
      var body = await response.json();
      return !!(body && body.status === 'ok');
    } catch (error) {
      if (timer) clearTimeout(timer);
      return false;
    }
  }

  /** يبحث عن خادم متاح مرة واحدة فقط */
  function init() {
    if (state.checking) return state.checking;

    state.checking = (async function () {
      var bases = candidateBases();
      for (var i = 0; i < bases.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        if (await probe(bases[i])) {
          state.base = bases[i];
          state.online = true;
          state.checked = true;
          return true;
        }
      }
      state.base = null;
      state.online = false;
      state.checked = true;
      return false;
    })();

    return state.checking;
  }

  function apiError(code, extra) {
    var error = new Error(code);
    error.code = code;
    if (extra) Object.assign(error, extra);
    return error;
  }

  async function request(path, options) {
    var opts = options || {};
    var base = state.base || '';

    var headers = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.token) headers.authorization = 'Bearer ' + opts.token;

    var response;
    try {
      response = await fetch(base + path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (networkError) {
      state.online = false;
      state.base = null;
      state.checked = false;
      state.checking = null;
      throw apiError('errServer');
    }

    var text = await response.text();
    var payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (error) {
      payload = null;
    }

    if (!response.ok) {
      var err = (payload && payload.error) || {};
      throw apiError(err.code || 'errGeneric', {
        status: response.status,
        fields: err.fields || null,
      });
    }

    return payload;
  }

  global.EnayaApi = {
    init: init,
    get online() {
      return state.online;
    },
    get base() {
      return state.base;
    },
    get checked() {
      return state.checked;
    },

    register: function (payload) {
      return request('/patients', { method: 'POST', body: payload });
    },

    resume: function (docType, docNo, pin) {
      return request('/patients/' + encodeURIComponent(docType) + '/' + encodeURIComponent(docNo) + '/session', {
        method: 'POST',
        body: { pin: pin },
      });
    },

    getPatient: function (docType, docNo, token) {
      return request('/patients/' + encodeURIComponent(docType) + '/' + encodeURIComponent(docNo), {
        token: token,
      });
    },

    createVisit: function (body, token) {
      return request('/visits', { method: 'POST', body: body, token: token });
    },
  };
})(window);
