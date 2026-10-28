/* ==========================================================================
   الرعاية العاجلة — مخزن الملفات المشفّر (localStorage)
   كل ملف مخزّن تحت مفتاح خاص بمستخدمه، ومحتواه مشفّر بمفتاح مشتق من رمز دخوله.
   لا يمكن قراءة ملف أي مستخدم دون رمز دخوله، حتى بفتح localStorage يدوياً.
   ========================================================================== */
(function (global) {
  'use strict';

  var C = global.EnayaCrypto;

  var KEY_ACCOUNTS = 'enaya:accounts';
  var KEY_VAULT = 'enaya:vault:';
  var KEY_LAST = 'enaya:last';

  function available() {
    try {
      var probe = '__enaya_probe__';
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
      return true;
    } catch (error) {
      return false;
    }
  }

  function readJSON(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    global.localStorage.setItem(key, JSON.stringify(value));
  }

  function listAccounts() {
    var list = readJSON(KEY_ACCOUNTS, []);
    return Array.isArray(list) ? list : [];
  }

  function saveAccounts(list) {
    writeJSON(KEY_ACCOUNTS, list);
  }

  async function findAccount(docType, docNumber) {
    var fp = await C.fingerprint(docType, docNumber);
    var found = listAccounts().filter(function (account) {
      return account.fingerprint === fp;
    })[0];
    return found || null;
  }

  function accountById(id) {
    return listAccounts().filter(function (account) {
      return account.id === id;
    })[0] || null;
  }

  /** ينشئ حساباً محلياً + مفتاحاً مشتقاً. لا يُخزَّن رمز الدخول أبداً. */
  async function createAccount(input) {
    var salt = C.newSalt();
    var verifier = await C.verifier(input.pin, salt);

    var account = {
      id: C.newId(),
      docType: input.docType,
      fingerprint: await C.fingerprint(input.docType, input.docNumber),
      masked: C.mask(input.docNumber),
      salt: salt,
      verifier: verifier,
      createdAt: new Date().toISOString(),
    };

    var list = listAccounts();
    list.push(account);
    saveAccounts(list);

    var key = await C.deriveKey(input.pin, salt);
    var data = input.data || {};

    await save(account, key, data);

    try {
      global.localStorage.setItem(KEY_LAST, input.docType);
    } catch (error) {
      /* تجاهل */
    }

    return { account: account, key: key, data: data };
  }

  /** يفتح الملف برمز الدخول. يرمي INVALID_PIN عند الخطأ. */
  async function unlock(account, pin) {
    var check = await C.verifier(pin, account.salt);
    if (check !== account.verifier) {
      var error = new Error('INVALID_PIN');
      error.code = 'INVALID_PIN';
      throw error;
    }
    var key = await C.deriveKey(pin, account.salt);
    var data = await load(account, key);
    return { key: key, data: data };
  }

  async function load(account, key) {
    var payload = readJSON(KEY_VAULT + account.id, null);
    if (!payload) return { profile: null, visits: [], notes: [], token: null };
    var text = await C.decryptString(payload, key);
    return JSON.parse(text);
  }

  async function save(account, key, data) {
    var payload = await C.encryptString(JSON.stringify(data), key);
    writeJSON(KEY_VAULT + account.id, payload);
  }

  /** يحدّث الملف بدمج جزئي ثم يعيده */
  async function patch(account, key, current, changes) {
    var next = Object.assign({}, current, changes);
    await save(account, key, next);
    return next;
  }

  function hasVault(account) {
    return !!readJSON(KEY_VAULT + account.id, null);
  }

  function remove(accountId) {
    global.localStorage.removeItem(KEY_VAULT + accountId);
    saveAccounts(
      listAccounts().filter(function (account) {
        return account.id !== accountId;
      })
    );
  }

  /** قياس تقريبي للمساحة المستخدمة */
  function usage() {
    var total = 0;
    try {
      for (var i = 0; i < global.localStorage.length; i += 1) {
        var key = global.localStorage.key(i);
        if (key && key.indexOf('enaya:') === 0) {
          total += (key.length + (global.localStorage.getItem(key) || '').length) * 2;
        }
      }
    } catch (error) {
      return 0;
    }
    return total;
  }

  function lastDocType() {
    try {
      return global.localStorage.getItem(KEY_LAST) || 'nid';
    } catch (error) {
      return 'nid';
    }
  }

  global.EnayaStore = {
    available: available,
    listAccounts: listAccounts,
    findAccount: findAccount,
    accountById: accountById,
    createAccount: createAccount,
    unlock: unlock,
    load: load,
    save: save,
    patch: patch,
    hasVault: hasVault,
    remove: remove,
    usage: usage,
    lastDocType: lastDocType,
  };
})(window);
