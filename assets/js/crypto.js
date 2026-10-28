/* ==========================================================================
   الرعاية العاجلة — الطبقة التشفيرية
   PBKDF2-SHA256 (180,000 دورة) + AES-256-GCM
   لا يوجد أي مفتاح مكتوب في الكود — كل مفتاح يُشتق من رمز دخول المريض وقت التشغيل.
   ========================================================================== */
(function (global) {
  'use strict';

  var subtle = global.crypto && global.crypto.subtle;
  var encoder = new TextEncoder();
  var decoder = new TextDecoder();

  var ITERATIONS = 180000;
  var KEY_BITS = 256;
  var SALT_BYTES = 16;
  var IV_BYTES = 12;

  function supported() {
    return !!subtle;
  }

  function toBase64(bytes) {
    var text = '';
    for (var i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
    return global.btoa(text);
  }

  function fromBase64(value) {
    var text = global.atob(String(value));
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
    return bytes;
  }

  function randomBytes(length) {
    var bytes = new Uint8Array(length);
    global.crypto.getRandomValues(bytes);
    return bytes;
  }

  function toHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  async function deriveRaw(pin, salt) {
    var baseKey = await subtle.importKey('raw', encoder.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
    var bits = await subtle.deriveBits(
      { name: 'PBKDF2', salt: salt, iterations: ITERATIONS, hash: 'SHA-256' },
      baseKey,
      KEY_BITS
    );
    return new Uint8Array(bits);
  }

  /** يشتق مفتاح AES-GCM من رمز الدخول والملح */
  async function deriveKey(pin, saltB64) {
    var raw = await deriveRaw(pin, fromBase64(saltB64));
    return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  /** بصمة حتمية للتحقق من رمز الدخول دون حفظه أو تشفير قيمة عشوائية */
  async function verifier(pin, saltB64) {
    var raw = await deriveRaw(pin, fromBase64(saltB64));
    var digest = await subtle.digest('SHA-256', raw);
    return toBase64(new Uint8Array(digest));
  }

  async function encryptString(text, key) {
    var iv = randomBytes(IV_BYTES);
    var cipher = await subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, encoder.encode(text));
    return { v: 1, iv: toBase64(iv), d: toBase64(new Uint8Array(cipher)) };
  }

  async function decryptString(payload, key) {
    if (!payload || payload.v !== 1) throw new Error('BAD_PAYLOAD');
    var iv = fromBase64(payload.iv);
    var data = fromBase64(payload.d);
    var plain = await subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
    return decoder.decode(plain);
  }

  function newSalt() {
    return toBase64(randomBytes(SALT_BYTES));
  }

  function newId() {
    return 'u_' + Date.now().toString(36) + '_' + toHex(randomBytes(5));
  }

  /** بصمة الوثيقة — تسمح بالبحث عن الحساب دون تخزين رقم الوثيقة صراحةً */
  async function fingerprint(docType, docNo) {
    var digest = await subtle.digest('SHA-256', encoder.encode(docType + ':' + docNo));
    return toHex(new Uint8Array(digest));
  }

  /** إخفاء رقم الوثيقة للعرض */
  function mask(value) {
    var text = String(value || '');
    if (text.length <= 4) return text;
    return text.slice(0, 1) + '•'.repeat(text.length - 3) + text.slice(-2);
  }

  global.EnayaCrypto = {
    supported: supported,
    deriveKey: deriveKey,
    verifier: verifier,
    encryptString: encryptString,
    decryptString: decryptString,
    newSalt: newSalt,
    newId: newId,
    fingerprint: fingerprint,
    mask: mask,
  };
})(window);
