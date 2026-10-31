/* ==========================================================================
   الرعاية العاجلة — وحدة التحكم
   العروض، التوجيه، الأحداث، وربط الواجهة بالسحابة (Supabase) أو بالخادم.
   ========================================================================== */
(function () {
  'use strict';

  var T = window.EnayaI18n;
  var C = window.EnayaCrypto;
  var Cloud = window.UrgentCloud;
  var Api = window.EnayaApi;

  var t = T.t;
  var errText = T.err;

  // ─── أدوات مساعدة ───────────────────────────────────────────────────────────

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function icon(name, cls) {
    return '<svg class="' + (cls || 'ic') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }

  function toLatinDigits(value) {
    return String(value || '')
      .replace(/[٠-٩]/g, function (d) { return String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)); })
      .replace(/[۰-۹]/g, function (d) { return String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)); });
  }

  function normalizeDoc(type, raw) {
    var value = toLatinDigits(raw).trim();
    if (type === 'passport') return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return value.replace(/\D/g, '');
  }

  function normalizePhone(raw) {
    var value = toLatinDigits(raw).replace(/\D/g, '');
    if (value.indexOf('00966') === 0) value = '0' + value.slice(5);
    else if (value.indexOf('966') === 0) value = '0' + value.slice(3);
    return value;
  }

  function toast(message, kind) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast show' + (kind ? ' toast--' + kind : '');
    clearTimeout(el._timer);
    el._timer = setTimeout(function () {
      el.className = 'toast' + (kind ? ' toast--' + kind : '');
    }, 3200);
  }

  // ─── النافذة المنبثقة ───────────────────────────────────────────────────────

  function openModal(options) {
    var modal = $('#modal');
    $('#modalTitle').textContent = options.title || '';
    $('#modalBody').innerHTML = options.body || '';

    var foot = $('#modalFoot');
    foot.innerHTML = (options.actions || [])
      .map(function (action, index) {
        return (
          '<button class="btn ' + (action.variant || 'btn--soft') + '" type="button" data-modal-action="' +
          index + '">' + esc(action.label) + '</button>'
        );
      })
      .join('');

    (options.actions || []).forEach(function (action, index) {
      var btn = foot.querySelector('[data-modal-action="' + index + '"]');
      if (!btn) return;
      btn.addEventListener('click', function () {
        if (action.onClick) action.onClick();
        if (action.close !== false) closeModal();
      });
    });

    modal.hidden = false;
    var first = modal.querySelector('input, textarea, .modal__foot .btn');
    if (first) first.focus();
  }

  function closeModal() {
    $('#modal').hidden = true;
    $('#modalBody').innerHTML = '';
    $('#modalFoot').innerHTML = '';
  }

  // ─── التنسيق ────────────────────────────────────────────────────────────────

  function formatDate(iso) {
    if (!iso) return '—';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '—';
    var locale = T.lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB';
    try {
      return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
    } catch (error) {
      return date.toISOString().slice(0, 10);
    }
  }

  function formatTime(iso) {
    if (!iso) return '—';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '—';
    try {
      return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(date);
    } catch (error) {
      return '—';
    }
  }

  /** تاريخ ميلاد محفوظ بصيغة YYYY-MM-DD — يُعرض بالتقويم الميلادي */
  function formatBirthDate(value) {
    if (!value) return '—';
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
    if (!match) return String(value);
    var date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    var locale = T.lang === 'ar' ? 'ar-u-ca-gregory-nu-latn' : 'en-GB';
    try {
      return new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      }).format(date);
    } catch (error) {
      return value;
    }
  }

  /** يوحّد عرض الجوال على الصيغة المحلية 05XXXXXXXX */
  function formatPhone(value) {
    var digits = String(value || '').replace(/\D/g, '');
    if (digits.indexOf('00966') === 0) digits = '0' + digits.slice(5);
    else if (digits.indexOf('966') === 0) digits = '0' + digits.slice(3);
    return digits || '—';
  }

  var DOC_LABEL = { nid: 'docTypeNid', iqama: 'docTypeIqama', passport: 'docTypePassport' };
  var CATEGORY_LABEL = { citizen: 'catCitizen', domestic: 'catDomestic', insured: 'catInsured' };

  function docLabel(type) {
    return t(DOC_LABEL[type] || 'docTypeNid');
  }

  function categoryLabel(category) {
    return t(CATEGORY_LABEL[category] || 'catCitizen');
  }

  function statusChip(status) {
    var map = {
      ok: { cls: 'chip--ok', label: t('syncOk') },
      fail: { cls: 'chip--fail', label: t('syncFail') },
      wait: { cls: 'chip--warn', label: t('syncWait') },
      offline: { cls: 'chip--warn', label: t('syncOffline') },
    };
    var item = map[status] || map.wait;
    return '<span class="chip ' + item.cls + '"><i class="dot"></i>' + esc(item.label) + '</span>';
  }

  var VISIT_STATUS = { waiting: 'stWaiting', called: 'stCalled', done: 'stDone', cancelled: 'stCancelled' };

  // ─── الحالة ─────────────────────────────────────────────────────────────────

  function freshKiosk() {
    return {
      step: 1,
      category: null,
      docType: 'nid',
      docNo: '',
      cal: 'greg',
      dob: { d: '', m: '', y: '' },
      phone: '',
      insurer: '',
      policy: '',
      pin: '',
      pin2: '',
      consent: false,
      errors: {},
      result: null,
      session: null,
      busy: false,
    };
  }

  var state = {
    screen: 'home',
    kiosk: freshKiosk(),
    login: { docType: 'nid', docNo: '', pin: '', error: '', busy: false },
    portal: null,
    staff: null,
    staffLogin: { docType: 'nid', docNo: '', pin: '', error: '', busy: false },
  };

  // ─── الأجزاء المشتركة ───────────────────────────────────────────────────────

  function brandMarkup() {
    return (
      '<a class="brand" href="#/" data-act="home" aria-label="' + esc(t('brand')) + '">' +
      '<span class="brand__mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span>' +
      '<span><span class="brand__name">' + esc(t('brand')) + '</span>' +
      '<span class="brand__tag">' + esc(t('brandTag')) + '</span></span>' +
      '</a>'
    );
  }

  function langButton() {
    return (
      '<button class="iconbtn" type="button" data-act="lang" aria-label="' + esc(t('langTitle')) + '" title="' + esc(t('langTitle')) + '">' +
      icon('globe') + '</button>'
    );
  }

  function connectionChip() {
    if (!Cloud) {
      return '<span class="chip chip--fail" id="connChip"><i class="dot"></i>' + esc(t('cloudOff')) + '</span>';
    }
    if (Cloud.isDemo) {
      return '<span class="chip chip--warn" id="connChip" title="' + esc(t('cloudDemoHint')) + '"><i class="dot"></i>' + esc(t('cloudDemo')) + '</span>';
    }
    return '<span class="chip chip--ok" id="connChip"><i class="dot"></i>' + esc(t('cloudOnline')) + '</span>';
  }

  function toggleMenu() {
    var nav = $('#topNav');
    var button = $('[data-act="menu"]');
    if (!nav || !button) return;
    var open = nav.classList.toggle('is-open');
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function closeMenu() {
    var nav = $('#topNav');
    var button = $('[data-act="menu"]');
    if (!nav || !button) return;
    nav.classList.remove('is-open');
    button.setAttribute('aria-expanded', 'false');
  }

  function topbar(options) {
    var opts = options || {};
    var links = [
      { key: 'home', label: t('navHome'), screen: 'home' },
      { key: 'kiosk', label: t('navRegister'), screen: 'kiosk' },
      { key: 'login', label: t('navPortal'), screen: 'login' },
    ];

    var items = links
      .map(function (link) {
        var current = state.screen === link.screen ? ' aria-current="page"' : '';
        return '<a class="top__link" href="#/' + link.key + '" data-act="go" data-screen="' + link.screen + '"' + current + '>' + esc(link.label) + '</a>';
      })
      .join('');

    return (
      '<header class="top"><div class="wrap top__in">' +
      brandMarkup() +
      '<nav class="top__nav" id="topNav" aria-label="' + esc(t('navHome')) + '">' + items + '</nav>' +
      '<div class="top__spacer"></div>' +
      '<div class="top__actions">' +
      connectionChip() +
      langButton() +
      (opts.hideCta
        ? ''
        : '<a class="btn btn--sm top__cta" href="#/register" data-act="go" data-screen="kiosk">' + esc(t('heroCta1')) + '</a>') +
      '<button class="iconbtn top__menu" type="button" data-act="menu" aria-label="' + esc(t('menu')) + '" aria-controls="topNav" aria-expanded="false">' + icon('menu') + '</button>' +
      '</div>' +
      '</div></header>'
    );
  }

  function footer() {
    return (
      '<footer class="foot"><div class="wrap">' +
      '<div class="foot__in">' +
      '<div class="foot__brand">' + brandMarkup() + '<p>' + esc(t('footAbout')) + '</p></div>' +
      '<div class="foot__cols">' +
      '<div class="foot__col"><p class="foot__col-h">' + esc(t('footPlatform')) + '</p>' +
      '<a href="#/register" data-act="go" data-screen="kiosk">' + esc(t('navRegister')) + '</a>' +
      '<a href="#/portal" data-act="go" data-screen="login">' + esc(t('navPortal')) + '</a>' +
      '</div>' +
      '<div class="foot__col"><p class="foot__col-h">' + esc(t('footSupport')) + '</p>' +
      '<a href="#/" data-act="home">' + esc(t('footPrivacy')) + '</a>' +
      '<a href="#/" data-act="home">' + esc(t('footTerms')) + '</a>' +
      '<a href="#/" data-act="home">' + esc(t('footContact')) + '</a>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="foot__base"><span>© ' + new Date().getFullYear() + ' ' + esc(t('brand')) + ' — ' + esc(t('footRights')) + '</span>' +
      '<span>' + esc(t('footBuilt')) + '</span></div>' +
      '</div></footer>'
    );
  }

  // ─── الصفحة الرئيسية ────────────────────────────────────────────────────────

  function viewHome() {
    var features = [
      { ic: 'clock', t: 'feat1t', d: 'feat1d' },
      { ic: 'shield', t: 'feat2t', d: 'feat2d' },
      { ic: 'hospital', t: 'feat3t', d: 'feat3d' },
      { ic: 'user', t: 'feat4t', d: 'feat4d' },
    ];

    var steps = [
      { t: 'how1t', d: 'how1d' },
      { t: 'how2t', d: 'how2d' },
      { t: 'how3t', d: 'how3d' },
    ];

    return (
      topbar() +
      '<main id="main">' +
      '<section class="hero"><div class="wrap hero__in">' +
      '<div class="reveal">' +
      '<span class="eyebrow"><i class="dot"></i>' + esc(t('heroBadge')) + '</span>' +
      '<h1>' + esc(t('heroTitleA')) + ' <em>' + esc(t('heroTitleEm')) + '</em></h1>' +
      '<p class="hero__lead">' + esc(t('heroLead')) + '</p>' +
      '<div class="hero__cta">' +
      '<a class="btn btn--lg" href="#/register" data-act="go" data-screen="kiosk">' + icon('plus', 'ic') + esc(t('heroCta1')) + '</a>' +
      '<a class="btn btn--lg btn--outline" href="#/portal" data-act="go" data-screen="login">' + icon('lock', 'ic') + esc(t('heroCta2')) + '</a>' +
      '</div>' +
      '<div class="hero__trust">' +
      '<div class="trust">' + icon('clock', 'ic') + '<div><b>' + esc(t('trust1t')) + '</b><span>' + esc(t('trust1s')) + '</span></div></div>' +
      '<div class="trust">' + icon('hospital', 'ic') + '<div><b>' + esc(t('trust2t')) + '</b><span>' + esc(t('trust2s')) + '</span></div></div>' +
      '<div class="trust">' + icon('shield', 'ic') + '<div><b>' + esc(t('trust3t')) + '</b><span>' + esc(t('trust3s')) + '</span></div></div>' +
      '</div>' +
      '</div>' +
      '<div class="showcase reveal">' +
      '<div class="showcase__glow"></div>' +
      '<div class="kiosk-card">' +
      '<div class="kiosk-card__bar"><b>' + esc(t('brand')) + '</b><div class="dots"><i></i><i></i><i></i></div></div>' +
      '<div class="kiosk-card__body">' +
      '<div class="queue"><div class="queue__label">' + esc(t('showLabel')) + '</div><div class="queue__num">104</div></div>' +
      '<div class="sync-list">' +
      '<div class="sync-row"><span class="sync-row__name">' + icon('hospital', 'ic ic--sm') + esc(t('raqeem')) + '</span>' + statusChip('ok') + '</div>' +
      '<div class="sync-row"><span class="sync-row__name">' + icon('steth', 'ic ic--sm') + esc(t('sehhaty')) + '</span>' + statusChip('ok') + '</div>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="float-card">' +
      '<span class="float-card__ic">' + icon('shield', 'ic') + '</span>' +
      '<div><b>' + esc(t('showNote')) + '</b><span>' + esc(t('showNoteSub')) + '</span></div>' +
      '</div>' +
      '</div>' +
      '</div></section>' +

      '<section class="section section--tint"><div class="wrap">' +
      '<div class="section__head"><h2>' + esc(t('featTitle')) + '</h2><p>' + esc(t('featLead')) + '</p></div>' +
      '<div class="grid grid--4">' +
      features
        .map(function (f) {
          return (
            '<article class="feature"><span class="feature__ic">' + icon(f.ic, 'ic') + '</span>' +
            '<h3>' + esc(t(f.t)) + '</h3><p>' + esc(t(f.d)) + '</p></article>'
          );
        })
        .join('') +
      '</div></div></section>' +

      '<section class="section"><div class="wrap">' +
      '<div class="section__head"><h2>' + esc(t('howTitle')) + '</h2></div>' +
      '<div class="steps-list">' +
      steps
        .map(function (s, index) {
          return (
            '<div class="step-card"><div class="step-card__n">' + (index + 1) + '</div>' +
            '<h3>' + esc(t(s.t)) + '</h3><p>' + esc(t(s.d)) + '</p></div>'
          );
        })
        .join('') +
      '</div></div></section>' +

      '<section class="section" style="padding-top:0"><div class="wrap">' +
      '<div class="cta-band"><div><h2>' + esc(t('ctaTitle')) + '</h2><p>' + esc(t('ctaLead')) + '</p></div>' +
      '<a class="btn btn--lg btn--white" href="#/register" data-act="go" data-screen="kiosk">' + esc(t('ctaBtn')) + '</a></div>' +
      '</div></section>' +
      '</main>' +
      footer()
    );
  }

  // ─── الكشك: الغلاف ──────────────────────────────────────────────────────────

  function kioskShell(inner) {
    return (
      '<div class="kiosk">' +
      '<div class="wrap kiosk__top">' + brandMarkup() +
      '<div class="top__spacer"></div>' +
      connectionChip() +
      langButton() +
      '<button class="iconbtn" type="button" data-act="home" aria-label="' + esc(t('close')) + '">' + icon('close') + '</button>' +
      '</div>' +
      '<main class="kiosk__body" id="main"><div class="wrap kiosk__panel">' + inner + '</div></main>' +
      '</div>'
    );
  }

  function progressBar(step) {
    var labels = [t('step1'), t('step2'), t('step3')];
    var cells = '';
    for (var i = 1; i <= 3; i += 1) {
      var cls = i < step ? ' is-done' : i === step ? ' is-on' : '';
      cells += '<div class="progress__step' + cls + '"></div>';
    }
    var labelMarkup = labels
      .map(function (label, index) {
        var current = index + 1 === step ? ' style="color:var(--brand-700)"' : '';
        return '<span' + current + '>' + esc(label) + '</span>';
      })
      .join('');
    return '<div class="progress">' + cells + '</div><div class="progress__label">' + labelMarkup + '</div>';
  }

  function fieldError(key) {
    var code = state.kiosk.errors[key];
    return '<span class="field__error" id="err-' + key + '">' + (code ? esc(errText(code)) : '') + '</span>';
  }

  // ─── الكشك: الخطوة 1 ────────────────────────────────────────────────────────

  function kioskStep1() {
    var choices = [
      { cat: 'citizen', ic: 'id', t: 'catCitizen', d: 'catCitizenSub' },
      { cat: 'domestic', ic: 'user', t: 'catDomestic', d: 'catDomesticSub' },
      { cat: 'insured', ic: 'shield', t: 'catInsured', d: 'catInsuredSub' },
    ];

    return (
      '<div class="kiosk__head"><h1>' + esc(t('whoTitle')) + '</h1><p>' + esc(t('whoSub')) + '</p></div>' +
      '<div class="card"><div class="card__body">' +
      choices
        .map(function (c) {
          return (
            '<button class="choice" type="button" data-act="pick-category" data-cat="' + c.cat + '">' +
            '<span class="choice__ic">' + icon(c.ic, 'ic') + '</span>' +
            '<span><b>' + esc(t(c.t)) + '</b><span>' + esc(t(c.d)) + '</span></span>' +
            '<span class="choice__go">' + icon('arrow', 'ic') + '</span>' +
            '</button>'
          );
        })
        .join('') +
      '</div></div>'
    );
  }

  // ─── الكشك: الخطوة 2 ────────────────────────────────────────────────────────

  function kioskStep2() {
    var k = state.kiosk;
    var locked = k.category === 'citizen' ? 'nid' : k.category === 'domestic' ? 'iqama' : null;

    var typeField = locked
      ? '<div class="field"><span class="field__label">' + esc(t('docType')) + '</span>' +
        '<div class="chip chip--brand" style="padding:11px 16px;font-size:14px">' + esc(docLabel(locked)) + '</div></div>'
      : '<div class="field"><label for="fkDocType">' + esc(t('docType')) + '</label>' +
        '<select class="select" id="fkDocType">' +
        ['nid', 'iqama', 'passport']
          .map(function (type) {
            return '<option value="' + type + '"' + (k.docType === type ? ' selected' : '') + '>' + esc(docLabel(type)) + '</option>';
          })
          .join('') +
        '</select></div>';

    var isPassport = k.docType === 'passport';

    return (
      '<div class="kiosk__head"><h1>' + esc(t('docTitle')) + '</h1><p>' + esc(t('docSub')) + '</p></div>' +
      '<div class="card"><div class="card__body">' +
      typeField +
      '<div class="field"><label for="fkDocNo">' + esc(t('docNo')) + '</label>' +
      '<input class="input input--ltr" id="fkDocNo" autocomplete="off" ' +
      (isPassport ? 'inputmode="text" maxlength="12"' : 'inputmode="numeric" maxlength="10"') +
      ' placeholder="' + esc(t('docNoPh')) + '" value="' + esc(k.docNo) + '"' +
      (k.errors.docNo ? ' aria-invalid="true"' : '') + '>' +
      fieldError('docNo') + '</div>' +
      '<div class="bar bar--split">' +
      '<button class="btn btn--ghost" type="button" data-act="kiosk-back">' + esc(t('back')) + '</button>' +
      '<button class="btn" type="button" data-act="kiosk-step2-next">' + esc(t('next')) + icon('arrow', 'ic') + '</button>' +
      '</div>' +
      '</div></div>'
    );
  }

  // ─── الكشك: الخطوة 3 ────────────────────────────────────────────────────────

  var HIJRI_MONTHS = {
    ar: ['محرم', 'صفر', 'ربيع الأول', 'ربيع الآخر', 'جمادى الأولى', 'جمادى الآخرة', 'رجب', 'شعبان', 'رمضان', 'شوال', 'ذو القعدة', 'ذو الحجة'],
    en: ['Muharram', 'Safar', 'Rabi I', 'Rabi II', 'Jumada I', 'Jumada II', 'Rajab', "Sha'ban", 'Ramadan', 'Shawwal', "Dhu al-Qa'dah", 'Dhu al-Hijjah'],
  };

  function gregorianMonths() {
    var locale = T.lang === 'ar' ? 'ar' : 'en';
    var out = [];
    for (var m = 0; m < 12; m += 1) {
      out.push(new Intl.DateTimeFormat(locale + '-u-ca-gregory', { month: 'long' }).format(new Date(2021, m, 1)));
    }
    return out;
  }

  function selectOptions(values, selected, placeholder) {
    var html = '<option value="">' + esc(placeholder) + '</option>';
    values.forEach(function (item) {
      var value = item.value;
      html += '<option value="' + value + '"' + (String(selected) === String(value) ? ' selected' : '') + '>' + esc(item.label) + '</option>';
    });
    return html;
  }

  function kioskStep3() {
    var k = state.kiosk;
    var isHijri = k.cal === 'hijri';
    var now = new Date();
    var currentYear = isHijri ? hijriYear(now) : now.getFullYear();
    var years = [];
    for (var i = 0; i < 110; i += 1) years.push({ value: currentYear - i, label: String(currentYear - i) });

    var days = [];
    for (var d = 1; d <= (isHijri ? 30 : 31); d += 1) days.push({ value: d, label: String(d) });

    var monthNames = isHijri ? HIJRI_MONTHS[T.lang] || HIJRI_MONTHS.ar : gregorianMonths();
    var months = monthNames.map(function (name, index) {
      return { value: index + 1, label: name };
    });

    var insured = k.category === 'insured';

    return (
      '<div class="kiosk__head"><h1>' + esc(t('detailsTitle')) + '</h1><p>' + esc(t('detailsSub')) + '</p></div>' +
      '<div class="card"><div class="card__body">' +

      '<div class="field"><span class="field__label">' + esc(t('dob')) + '</span>' +
      '<div class="seg" role="tablist" style="margin-bottom:10px">' +
      '<button type="button" role="tab" data-act="cal" data-cal="hijri" aria-selected="' + (isHijri ? 'true' : 'false') + '">' + esc(t('calHijri')) + '</button>' +
      '<button type="button" role="tab" data-act="cal" data-cal="greg" aria-selected="' + (!isHijri ? 'true' : 'false') + '">' + esc(t('calGreg')) + '</button>' +
      '</div>' +
      '<div class="field__row">' +
      '<select class="select" id="fkDay" aria-label="' + esc(t('day')) + '">' + selectOptions(days, k.dob.d, t('day')) + '</select>' +
      '<select class="select" id="fkMonth" aria-label="' + esc(t('month')) + '">' + selectOptions(months, k.dob.m, t('month')) + '</select>' +
      '<select class="select" id="fkYear" aria-label="' + esc(t('year')) + '">' + selectOptions(years, k.dob.y, t('year')) + '</select>' +
      '</div>' + fieldError('birthDate') + '</div>' +

      '<div class="field"><label for="fkPhone">' + esc(t('phone')) + '</label>' +
      '<input class="input input--ltr" id="fkPhone" inputmode="tel" maxlength="10" placeholder="' + esc(t('phonePh')) + '" value="' + esc(k.phone) + '"' +
      (k.errors.phone ? ' aria-invalid="true"' : '') + '>' +
      fieldError('phone') + '</div>' +

      (insured
        ? '<div class="field"><label for="fkInsurer">' + esc(t('insurer')) + '</label>' +
          '<input class="input" id="fkInsurer" value="' + esc(k.insurer) + '"' + (k.errors.insurer ? ' aria-invalid="true"' : '') + '>' +
          fieldError('insurer') + '</div>' +
          '<div class="field"><label for="fkPolicy">' + esc(t('policy')) + '</label>' +
          '<input class="input input--ltr" id="fkPolicy" value="' + esc(k.policy) + '"' + (k.errors.policyNumber ? ' aria-invalid="true"' : '') + '>' +
          fieldError('policyNumber') + '</div>'
        : '') +

      '<div class="field"><label for="fkPin">' + esc(t('pin')) + '</label>' +
      '<input class="input input--ltr" id="fkPin" type="password" autocomplete="new-password" maxlength="64" value="' + esc(k.pin) + '"' +
      (k.errors.pin ? ' aria-invalid="true"' : '') + '>' +
      '<div class="field__hint">' + esc(t('pinHint')) + '</div>' +
      fieldError('pin') + '</div>' +

      '<div class="field"><label for="fkPin2">' + esc(t('pin2')) + '</label>' +
      '<input class="input input--ltr" id="fkPin2" type="password" autocomplete="new-password" maxlength="64" value="' + esc(k.pin2) + '"' +
      (k.errors.pin2 ? ' aria-invalid="true"' : '') + '>' +
      fieldError('pin2') + '</div>' +

      '<label class="chk" style="display:flex;gap:10px;align-items:flex-start;margin-bottom:6px;font-size:13.5px;color:var(--muted)">' +
      '<input type="checkbox" id="fkConsent" style="width:20px;height:20px;flex:none;margin-top:2px;accent-color:var(--brand-600)"' + (k.consent ? ' checked' : '') + '>' +
      '<span>' + esc(t('consentText')) + '</span></label>' +
      fieldError('consent') +

      '<div class="bar bar--split" style="margin-top:20px">' +
      '<button class="btn btn--ghost" type="button" data-act="kiosk-back">' + esc(t('back')) + '</button>' +
      '<button class="btn" type="button" data-act="submit" id="fkSubmit"' + (k.busy ? ' disabled' : '') + '>' +
      esc(k.busy ? t('saving') : t('submit')) + '</button>' +
      '</div>' +
      '</div></div>'
    );
  }

  function hijriYear(date) {
    try {
      var parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { year: 'numeric', timeZone: 'UTC' }).formatToParts(date);
      var found = parts.filter(function (p) { return p.type === 'year'; })[0];
      return found ? parseInt(found.value, 10) : 1440;
    } catch (error) {
      return 1446;
    }
  }

  // ─── الكشك: الخطوة 4 ────────────────────────────────────────────────────────

  function kioskStep4() {
    var result = state.kiosk.result;
    if (!result) return '';

    var sync = result.sync || {};
    var systems = ['raqeem', 'sehhaty'];

    var rows = systems
      .map(function (key) {
        var entry = sync[key];
        var status = entry && entry.status ? entry.status : result.offline ? 'offline' : 'wait';
        return (
          '<div class="sync-row"><span class="sync-row__name">' +
          icon(key === 'raqeem' ? 'hospital' : 'steth', 'ic ic--sm') + esc(t(key)) + '</span>' +
          statusChip(status) + '</div>'
        );
      })
      .join('');

    return (
      '<div class="card"><div class="card__body">' +
      '<div class="success">' +
      '<div class="success__ic">' + icon('check', 'ic') + '</div>' +
      '<h1 style="font-size:1.5rem;font-weight:700;color:var(--ink)">' + esc(t('doneTitle')) + '</h1>' +
      '<p style="margin-top:6px;color:var(--muted);font-size:14.5px">' + esc(t('doneSub')) + '</p>' +
      '<div class="queue-hero"><div class="queue__label">' + esc(t('doneQueue')) + '</div>' +
      '<div class="queue__num">' + esc(result.queueNumber || '—') + '</div></div>' +
      '</div>' +
      (result.offline
        ? '<div class="notice notice--warn" style="margin-bottom:16px">' + icon('alert', 'ic') +
          '<div><b>' + esc(t('offlineTitle')) + '</b><br>' + esc(t('offlineBody')) + '</div></div>'
        : '') +
      '<div style="margin-top:8px"><div style="font-size:13px;font-weight:600;color:var(--muted);margin-bottom:8px">' + esc(t('syncTitle')) + '</div>' +
      '<div class="sync-list">' + rows + '</div></div>' +
      '<div class="bar bar--split" style="margin-top:24px">' +
      '<button class="btn btn--ghost" type="button" data-act="again">' + esc(t('again')) + '</button>' +
      '<button class="btn" type="button" data-act="open-portal">' + esc(t('toPortal')) + '</button>' +
      '</div>' +
      '</div></div>'
    );
  }

  function viewKiosk() {
    var k = state.kiosk;
    var inner = '';

    if (k.step === 4) {
      inner = kioskStep4();
    } else {
      var body = k.step === 1 ? kioskStep1() : k.step === 2 ? kioskStep2() : kioskStep3();
      inner = progressBar(k.step) + body;
    }

    return kioskShell(inner);
  }

  // ─── تسجيل الدخول ───────────────────────────────────────────────────────────

  function viewLogin() {
    var l = state.login;

    return (
      topbar({ hideCta: true }) +
      '<main id="main" style="min-height:calc(100vh - var(--top-h) - 200px);display:flex;align-items:center;justify-content:center;padding:48px 0 72px">' +
      '<div class="wrap" style="max-width:520px">' +
      '<div class="card"><div class="card__body">' +
      '<div style="text-align:center;margin-bottom:26px">' +
      '<div class="success__ic" style="margin-bottom:14px">' + icon('lock', 'ic') + '</div>' +
      '<h1 style="font-size:1.4rem;font-weight:700;color:var(--ink)">' + esc(t('loginTitle')) + '</h1>' +
      '<p style="margin-top:6px;color:var(--muted);font-size:14.5px">' + esc(t('loginSub')) + '</p>' +
      '</div>' +
      (l.error ? '<div class="notice notice--danger" style="margin-bottom:18px">' + icon('alert', 'ic') + '<div>' + esc(errText(l.error)) + '</div></div>' : '') +
      (Cloud.isDemo ? '<div class="notice notice--warn" style="margin-bottom:18px">' + icon('info', 'ic') + '<div>' + esc(t('cloudDemoHint')) + '</div></div>' : '') +
      '<div class="field"><label for="lgType">' + esc(t('docType')) + '</label>' +
      '<select class="select" id="lgType">' +
      ['nid', 'iqama', 'passport']
        .map(function (type) {
          return '<option value="' + type + '"' + (l.docType === type ? ' selected' : '') + '>' + esc(docLabel(type)) + '</option>';
        })
        .join('') +
      '</select></div>' +
      '<div class="field"><label for="lgDoc">' + esc(t('docNo')) + '</label>' +
      '<input class="input input--ltr" id="lgDoc" autocomplete="username" value="' + esc(l.docNo) + '" placeholder="' + esc(t('docNoPh')) + '"></div>' +
      '<div class="field"><label for="lgPin">' + esc(t('pin')) + '</label>' +
      '<input class="input input--ltr" id="lgPin" type="password" autocomplete="current-password" maxlength="64" value="' + esc(l.pin) + '"></div>' +
      '<button class="btn btn--block btn--lg" type="button" data-act="login"' + (l.busy ? ' disabled' : '') + '>' +
      esc(l.busy ? t('loading') : t('loginBtn')) + '</button>' +
      '<p style="margin:14px 0 0;text-align:center">' +
      '<a href="#/forgot" data-act="go" data-screen="forgot" style="color:var(--brand);font-size:13.5px;font-weight:600;text-decoration:underline">' + esc(t('forgotLink')) + '</a>' +
      '</p>' +
      '<p style="margin-top:16px;text-align:center;font-size:12.5px;color:var(--faint)">' + esc(t('loginHint')) + '</p>' +
      '<div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--line);text-align:center">' +
      '<a href="#/staff" data-act="go" data-screen="staff" style="color:var(--ink-2);font-size:13px;font-weight:600;text-decoration:underline">' + esc(t('staffLink')) + '</a>' +
      '</div>' +
      '</div></div></div></main>' +
      footer()
    );
  }

  // ─── نسيت رمز الدخول ────────────────────────────────────────────────────────

  function viewForgot() {
    var bullet = function (text) {
      return '<li style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px">' +
        '<span style="color:var(--brand);font-weight:700;flex:none">•</span>' +
        '<span style="font-size:14px;color:var(--ink-2)">' + esc(text) + '</span></li>';
    };

    return (
      topbar({ hideCta: true }) +
      '<main id="main" style="min-height:calc(100vh - var(--top-h) - 200px);display:flex;align-items:center;justify-content:center;padding:48px 0 72px">' +
      '<div class="wrap" style="max-width:560px">' +
      '<div class="card"><div class="card__body">' +
      '<div style="text-align:center;margin-bottom:22px">' +
      '<div class="success__ic" style="margin-bottom:14px">' + icon('alert', 'ic') + '</div>' +
      '<h1 style="font-size:1.35rem;font-weight:700;color:var(--ink)">' + esc(t('forgotTitle')) + '</h1>' +
      '<p style="margin-top:6px;color:var(--muted);font-size:14px">' + esc(t('forgotLead')) + '</p>' +
      '</div>' +

      '<div class="notice notice--warn" style="margin-bottom:20px">' + icon('info', 'ic') +
      '<div>' + esc(t('forgotNoRecovery')) + '</div></div>' +

      '<h2 style="font-size:15px;font-weight:700;color:var(--ink);margin-bottom:10px">' + esc(t('forgotTryTitle')) + '</h2>' +
      '<ul style="list-style:none;padding:0;margin:0 0 22px">' +
      bullet(t('forgotTry1')) +
      bullet(t('forgotTry2')) +
      bullet(t('forgotTry3')) +
      bullet(t('forgotTry4')) +
      '</ul>' +

      '<h2 style="font-size:15px;font-weight:700;color:var(--ink);margin-bottom:10px">' + esc(t('forgotStepsTitle')) + '</h2>' +
      '<ol style="padding-inline-start:20px;margin:0 0 18px;font-size:14px;color:var(--ink-2);line-height:1.9">' +
      '<li>' + esc(t('forgotStep1')) + '</li>' +
      '<li>' + esc(t('forgotStep2')) + '</li>' +
      '<li>' + esc(t('forgotStep3')) + '</li>' +
      '</ol>' +

      '<div class="notice notice--danger" style="margin-bottom:22px">' + icon('lock', 'ic') +
      '<div>' + esc(t('forgotLost')) + '</div></div>' +

      '<p style="font-size:13px;color:var(--faint);margin-bottom:20px">' + esc(t('forgotTip')) + '</p>' +

      '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
      '<button class="btn" type="button" style="flex:1 1 180px" data-act="go" data-screen="kiosk">' + esc(t('forgotNew')) + '</button>' +
      '<button class="btn btn--ghost" type="button" style="flex:1 1 180px" data-act="go" data-screen="login">' + esc(t('forgotBack')) + '</button>' +
      '</div>' +
      '</div></div></div></main>' +
      footer()
    );
  }

  // ─── لوحة الموظفين ──────────────────────────────────────────────────────────

  function staffShell(inner) {
    return (
      '<div class="portal">' +
      '<header class="top"><div class="wrap top__in">' + brandMarkup() +
      '<div class="top__spacer"></div>' +
      '<div class="top__actions">' + connectionChip() + langButton() +
      '<button class="btn btn--sm btn--ghost" type="button" data-act="staff-logout">' + icon('logout', 'ic') + esc(t('logout')) + '</button>' +
      '</div></div></header>' +
      inner +
      footer() +
      '</div>'
    );
  }

  function viewStaffLogin() {
    var s = state.staffLogin;

    return (
      topbar({ hideCta: true }) +
      '<main id="main" style="min-height:calc(100vh - var(--top-h) - 200px);display:flex;align-items:center;justify-content:center;padding:48px 0 72px">' +
      '<div class="wrap" style="max-width:520px">' +
      '<div class="card"><div class="card__body">' +
      '<div style="text-align:center;margin-bottom:26px">' +
      '<div class="success__ic" style="margin-bottom:14px">' + icon('hospital', 'ic') + '</div>' +
      '<h1 style="font-size:1.4rem;font-weight:700;color:var(--ink)">' + esc(t('staffTitle')) + '</h1>' +
      '<p style="margin-top:6px;color:var(--muted);font-size:14.5px">' + esc(t('staffSub')) + '</p>' +
      '</div>' +
      (s.error ? '<div class="notice notice--danger" style="margin-bottom:18px">' + icon('alert', 'ic') + '<div>' + esc(errText(s.error)) + '</div></div>' : '') +
      (Cloud.isDemo ? '<div class="notice notice--warn" style="margin-bottom:18px">' + icon('info', 'ic') + '<div>' + esc(t('staffDemoWarning')) + '</div></div>' : '') +
      '<div class="field"><label for="sfType">' + esc(t('docType')) + '</label>' +
      '<select class="select" id="sfType">' +
      ['nid', 'iqama', 'passport']
        .map(function (type) {
          return '<option value="' + type + '"' + (s.docType === type ? ' selected' : '') + '>' + esc(docLabel(type)) + '</option>';
        })
        .join('') +
      '</select></div>' +
      '<div class="field"><label for="sfDoc">' + esc(t('docNo')) + '</label>' +
      '<input class="input input--ltr" id="sfDoc" autocomplete="username" value="' + esc(s.docNo) + '" placeholder="' + esc(t('docNoPh')) + '"></div>' +
      '<div class="field"><label for="sfPin">' + esc(t('pin')) + '</label>' +
      '<input class="input input--ltr" id="sfPin" type="password" autocomplete="current-password" maxlength="64" value="' + esc(s.pin) + '"></div>' +
      '<button class="btn btn--block btn--lg" type="button" data-act="staff-login"' + (s.busy ? ' disabled' : '') + '>' +
      esc(s.busy ? t('loading') : t('staffLoginBtn')) + '</button>' +
      '<p style="margin-top:16px;text-align:center;font-size:12.5px;color:var(--faint)">' + esc(t('staffHint')) + '</p>' +
      '<div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--line);text-align:center">' +
      '<a href="#/portal" data-act="go" data-screen="login" style="color:var(--ink-2);font-size:13px;font-weight:600;text-decoration:underline">' + esc(t('navPortal')) + '</a>' +
      '</div>' +
      '</div></div></div></main>' +
      footer()
    );
  }

  function staffVisitCard(visit) {
    var patient = visit.patient || {};
    var meta = [
      patient.phone ? '<span dir="ltr">' + esc(formatPhone(patient.phone)) + '</span>' : '',
      esc(t('visitQueue')) + ' ' + esc(visit.queueNumber),
      esc(formatDate(visit.createdAt)) + ' · ' + esc(formatTime(visit.createdAt)),
    ].filter(Boolean).join(' · ');

    var statusText = t(VISIT_STATUS[visit.status] || 'stWaiting');
    var actions = [
      { key: 'called', label: 'staffSetCalled' },
      { key: 'done', label: 'staffSetDone' },
      { key: 'waiting', label: 'staffSetWaiting' },
      { key: 'cancelled', label: 'staffSetCancelled' },
    ].filter(function (item) { return item.key !== visit.status; })
      .map(function (item) {
        return '<button class="btn btn--soft btn--sm" type="button" data-act="staff-status" data-id="' + esc(visit.id) +
          '" data-status="' + item.key + '">' + esc(t(item.label)) + '</button>';
      })
      .join('');

    var haystack = [
      String(visit.queueNumber || ''),
      String(patient.masked || '').replace(/•/g, ''),
      String(patient.phone || ''),
      String(visit.status || ''),
    ].join(' ');

    return (
      '<article class="card" data-staff-row data-haystack="' + esc(haystack) + '"><div class="card__body" style="padding:16px 18px">' +
      '<div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">' +
      '<div class="visit__q" aria-hidden="true">' + esc(visit.queueNumber === null || visit.queueNumber === undefined ? '—' : visit.queueNumber) + '</div>' +
      '<div style="flex:1;min-width:180px">' +
      '<b style="display:block;font-size:14.5px;color:var(--ink)">' + esc(patient.masked ? docLabel(patient.docType) + ' · ' + patient.masked : t('staffUnknownPatient')) + '</b>' +
      '<span style="display:block;margin-top:4px;font-size:12.5px;color:var(--muted)">' + meta + '</span>' +
      '</div>' +
      '<span class="chip">' + esc(statusText) + '</span>' +
      '</div>' +
      '<div class="bar" style="justify-content:flex-start;gap:8px;flex-wrap:wrap;margin-top:12px">' + actions + '</div>' +
      '</div></article>'
    );
  }

  function viewStaffDashboard() {
    var s = state.staff;
    var visits = s.visits || [];
    var counts = { total: visits.length, waiting: 0, called: 0, done: 0 };
    visits.forEach(function (visit) {
      if (Object.prototype.hasOwnProperty.call(counts, visit.status)) counts[visit.status] += 1;
    });

    var stats =
      '<div class="portal__stats">' +
      '<div class="stat"><span class="stat__ic">' + icon('calendar', 'ic') + '</span><div><b>' + counts.total + '</b><span>' + esc(t('staffStatTotal')) + '</span></div></div>' +
      '<div class="stat"><span class="stat__ic">' + icon('clock', 'ic') + '</span><div><b>' + counts.waiting + '</b><span>' + esc(t('staffStatWaiting')) + '</span></div></div>' +
      '<div class="stat"><span class="stat__ic">' + icon('user', 'ic') + '</span><div><b>' + counts.called + '</b><span>' + esc(t('staffStatCalled')) + '</span></div></div>' +
      '<div class="stat"><span class="stat__ic">' + icon('shield', 'ic') + '</span><div><b>' + counts.done + '</b><span>' + esc(t('staffStatDone')) + '</span></div></div>' +
      '</div>';

    var list = visits.length
      ? '<div class="grid" style="gap:12px">' + visits.map(staffVisitCard).join('') + '</div>'
      : '<div class="empty"><div class="empty__ic">' + icon('calendar', 'ic') + '</div>' +
        '<h2>' + esc(t('staffNoVisits')) + '</h2><p>' + esc(t('staffNoVisitsSub')) + '</p></div>';

    var search =
      '<div class="bar" style="margin:18px 0 14px;gap:10px;align-items:flex-end;flex-wrap:wrap">' +
      '<div class="field" style="flex:1 1 240px;margin:0">' +
      '<label for="stSearch">' + esc(t('staffSearch')) + '</label>' +
      '<input class="input" id="stSearch" type="search" value="' + esc(s.query || '') + '" placeholder="' + esc(t('staffSearchPh')) + '">' +
      '</div>' +
      '<button class="btn btn--outline btn--sm" type="button" data-act="staff-refresh">' + icon('refresh', 'ic') + esc(t('staffRefresh')) + '</button>' +
      '</div>';

    return staffShell(
      '<main id="main">' +
      '<div class="portal__hero"><div class="wrap portal__hero-in">' +
      '<span class="avatar" aria-hidden="true">' + icon('hospital', 'ic ic--lg') + '</span>' +
      '<div><h1>' + esc(t('staffTitle')) + '</h1>' +
      '<p>' + esc(s.staff.name || t('staffRoleStaff')) + ' · ' +
      esc(t(s.staff.role === 'admin' ? 'staffRoleAdmin' : 'staffRoleStaff')) + '</p></div>' +
      '<div class="top__spacer"></div>' +
      '<span class="chip chip--ok"><i class="dot"></i>' + esc(t('staffBadge')) + '</span>' +
      '</div></div>' +

      '<div class="wrap">' + stats +
      (Cloud.isDemo ? '<div class="notice notice--warn" style="margin-bottom:16px">' + icon('info', 'ic') + '<div>' + esc(t('staffDemoWarning')) + '</div></div>' : '') +
      '<div class="notice notice--ok" style="margin-bottom:16px">' + icon('shield', 'ic') +
      '<div><b>' + esc(t('staffNoNotesTitle')) + '</b><br>' + esc(t('staffNoNotesBody')) + '</div></div>' +
      search +
      '<h2 style="font-size:15px;font-weight:600;color:var(--ink);margin-bottom:12px">' + esc(t('staffVisitList')) + '</h2>' +
      list +
      '</div>' +
      '</main>'
    );
  }

  function viewStaff() {
    return state.staff ? viewStaffDashboard() : viewStaffLogin();
  }

  function applyStaffFilter() {
    var query = String((state.staff && state.staff.query) || '').trim().toLowerCase();
    var rows = document.querySelectorAll('[data-staff-row]');
    Array.prototype.forEach.call(rows, function (row) {
      var haystack = String(row.getAttribute('data-haystack') || '').toLowerCase();
      row.hidden = !!query && haystack.indexOf(query) < 0;
    });
  }

  function bindStaff() {
    if (state.staff) {
      var search = $('#stSearch');
      if (search) {
        search.addEventListener('input', function () {
          state.staff.query = search.value;
          applyStaffFilter();
        });
        applyStaffFilter();
      }
      return;
    }

    var s = state.staffLogin;

    var type = $('#sfType');
    if (type) {
      type.addEventListener('change', function () {
        s.docType = type.value;
        s.docNo = '';
        $('#sfDoc').value = '';
        s.error = '';
      });
    }

    var doc = $('#sfDoc');
    if (doc) {
      doc.addEventListener('input', function () {
        s.docNo = normalizeDoc(s.docType, doc.value);
        doc.value = s.docNo;
      });
      doc.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') doStaffLogin();
      });
    }

    var pin = $('#sfPin');
    if (pin) {
      pin.addEventListener('input', function () { s.pin = pin.value; });
      pin.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') doStaffLogin();
      });
    }
  }

  async function doStaffLogin() {
    var s = state.staffLogin;
    if (s.busy) return;

    s.error = '';

    if (!s.docNo || !s.pin) {
      s.error = 'errRequired';
      render();
      return;
    }

    s.busy = true;
    render();

    try {
      var result = await Cloud.staffLogin(s.docType, s.docNo, s.pin);
      s.busy = false;
      s.pin = '';
      state.portal = null;
      state.staff = { staff: result.staff, visits: result.visits || [], query: '' };
      state.screen = 'staff';
      render();
      window.scrollTo({ top: 0, behavior: 'auto' });
    } catch (error) {
      s.busy = false;
      s.error = error && error.code ? error.code : 'errGeneric';
      render();
    }
  }

  function refreshStaffVisits() {
    if (!state.staff) return;
    Cloud.staffVisits()
      .then(function (visits) {
        if (!state.staff) return;
        state.staff.visits = visits || [];
        render();
        toast(t('staffRefreshed'), 'ok');
      })
      .catch(function (error) {
        toast(errText(error && error.code ? error.code : 'errCloud'), 'err');
      });
  }

  function updateStaffVisit(id, status) {
    if (!state.staff) return;
    Cloud.staffSetVisitStatus(id, status)
      .then(function (saved) {
        if (!state.staff) return;
        state.staff.visits = (state.staff.visits || []).map(function (visit) {
          return visit.id === saved.id ? Object.assign({}, visit, { status: saved.status }) : visit;
        });
        render();
        toast(t('staffUpdated'), 'ok');
      })
      .catch(function (error) {
        toast(errText(error && error.code ? error.code : 'errGeneric'), 'err');
      });
  }

  // ─── بوابة المريض ───────────────────────────────────────────────────────────

  function viewPortal() {
    var p = state.portal;
    if (!p) return viewLogin();

    var data = p.data;
    var profile = data.profile || {};
    var visits = data.visits || [];
    var notes = data.notes || [];
    var latest = visits[0];

    var stats =
      '<div class="portal__stats">' +
      '<div class="stat"><span class="stat__ic">' + icon('calendar', 'ic') + '</span><div><b>' + visits.length + '</b><span>' + esc(t('statVisits')) + '</span></div></div>' +
      '<div class="stat"><span class="stat__ic">' + icon('clock', 'ic') + '</span><div><b>' + (latest ? esc(latest.queueNumber) : '—') + '</b><span>' + esc(t('statLast')) + '</span></div></div>' +
      '<div class="stat"><span class="stat__ic">' + icon('hospital', 'ic') + '</span><div><b style="font-size:15px">' +
      (latest && latest.sync && latest.sync.raqeem ? statusChip(latest.sync.raqeem.status) : statusChip('offline')) +
      '</b><span>' + esc(t('statSync')) + '</span></div></div>' +
      '</div>';

    var tabs = [
      { key: 'overview', label: t('tabOverview') },
      { key: 'visits', label: t('tabVisits') },
      { key: 'notes', label: t('tabNotes') },
    ]
      .map(function (tab) {
        return (
          '<button class="tab" type="button" role="tab" data-act="tab" data-tab="' + tab.key + '" aria-selected="' +
          (p.tab === tab.key ? 'true' : 'false') + '">' + esc(tab.label) + '</button>'
        );
      })
      .join('');

    var panel = p.tab === 'visits' ? portalVisits(visits) : p.tab === 'notes' ? portalNotes(notes) : portalOverview(profile, latest);

    return (
      '<div class="portal">' +
      '<header class="top"><div class="wrap top__in">' + brandMarkup() +
      '<div class="top__spacer"></div>' +
      '<div class="top__actions">' + connectionChip() + langButton() +
      '<button class="btn btn--sm btn--ghost" type="button" data-act="logout">' + icon('logout', 'ic') + esc(t('logout')) + '</button>' +
      '</div></div></header>' +

      '<main id="main">' +
      '<div class="portal__hero"><div class="wrap portal__hero-in">' +
      '<span class="avatar" aria-hidden="true">' + icon('user', 'ic ic--lg') + '</span>' +
      '<div><h1>' + esc(t('greeting')) + '</h1>' +
      '<p>' + esc(docLabel(profile.docType)) + ' · <span dir="ltr">' + esc(profile.masked || '—') + '</span>' +
      (profile.createdAt ? ' · ' + esc(t('memberSince')) + ' ' + esc(formatDate(profile.createdAt)) : '') +
      '</p></div>' +
      '<div class="top__spacer"></div>' +
      '</div></div>' +

      '<div class="wrap">' + stats +
      '<div class="tabs" role="tablist">' + tabs + '</div>' +
      '<div class="panel">' + panel + '</div>' +
      '</div>' +
      '</main>' +
      footer() +
      '</div>'
    );
  }

  function portalOverview(profile, latest) {
    var rows = [
      { label: t('labelDocType'), value: docLabel(profile.docType) },
      { label: t('labelDocNo'), value: '<span dir="ltr">' + esc(profile.masked || '—') + '</span>' },
      { label: t('labelDob'), value: esc(formatBirthDate(profile.birthDate)) },
      { label: t('labelPhone'), value: '<span dir="ltr">' + esc(formatPhone(profile.phone)) + '</span>' },
      { label: t('labelCategory'), value: esc(categoryLabel(profile.category)) },
      { label: t('labelCreated'), value: esc(formatDate(profile.createdAt)) },
    ];

    if (profile.insurer) {
      rows.push({ label: t('labelInsurer'), value: esc(profile.insurer) });
      rows.push({ label: t('labelPolicy'), value: '<span dir="ltr">' + esc(profile.policyNumber || '—') + '</span>' });
    }

    var latestBlock = latest
      ? '<div class="card" style="margin-top:18px"><div class="card__body">' +
        '<h2 style="font-size:15px;font-weight:600;color:var(--ink);margin-bottom:12px">' + esc(t('statLast')) + '</h2>' +
        visitRow(latest) + '</div></div>'
      : '';

    return (
      '<div class="card"><div class="card__body">' +
      '<h2 style="font-size:15px;font-weight:600;color:var(--ink);margin-bottom:14px">' + esc(t('profileTitle')) + '</h2>' +
      '<dl class="kv">' +
      rows
        .map(function (row) {
          return '<div><dt>' + esc(row.label) + '</dt><dd>' + row.value + '</dd></div>';
        })
        .join('') +
      '</dl>' +
      '</div></div>' +
      latestBlock +
      '<div class="bar" style="margin-top:20px;justify-content:flex-end;gap:10px;flex-wrap:wrap">' +
      '<button class="btn btn--soft btn--sm" type="button" data-act="change-pin">' + icon('lock', 'ic') + esc(t('changePinBtn')) + '</button>' +
      '<button class="btn btn--outline btn--sm" type="button" data-act="export">' + icon('download', 'ic') + esc(t('exportVault')) + '</button>' +
      '</div>'
    );
  }

  function visitRow(visit) {
    var sync = visit.sync || {};
    var hasSync = !!sync.raqeem || !!sync.sehhaty;
    var chips = hasSync
      ? ['raqeem', 'sehhaty']
          .map(function (key) {
            var entry = sync[key];
            return entry ? statusChip(entry.status) : statusChip('offline');
          })
          .join('')
      : statusChip('offline');

    var title = visit.reason ? esc(visit.reason) : esc(t('generalVisit'));
    var meta = esc(t('visitQueue')) + ' ' + esc(visit.queueNumber) + ' · ' +
      esc(formatDate(visit.createdAt)) + ' · ' + esc(formatTime(visit.createdAt));

    return (
      '<div class="visit">' +
      '<div class="visit__q" aria-hidden="true">' + esc(visit.queueNumber) + '</div>' +
      '<div class="visit__main"><b>' + title + '</b>' +
      '<span>' + meta + '</span></div>' +
      '<span class="chip">' + esc(t(VISIT_STATUS[visit.status] || 'stWaiting')) + '</span>' +
      '<div class="visit__sync">' + chips + '</div>' +
      '</div>'
    );
  }

  function portalVisits(visits) {
    if (!visits.length) {
      return (
        '<div class="empty"><div class="empty__ic">' + icon('calendar', 'ic') + '</div>' +
        '<h2>' + esc(t('noVisits')) + '</h2><p>' + esc(t('noVisitsSub')) + '</p>' +
        '<div class="bar" style="justify-content:center;margin-top:18px">' +
        '<button class="btn btn--sm" type="button" data-act="go" data-screen="kiosk">' + esc(t('heroCta1')) + '</button></div></div>'
      );
    }
    return '<div class="visit-list">' + visits.map(visitRow).join('') + '</div>';
  }

  function wasEdited(note) {
    var created = new Date(note.createdAt).getTime();
    var updated = new Date(note.updatedAt).getTime();
    return isFinite(created) && isFinite(updated) && (updated - created) > 1500;
  }

  function portalNotes(notes) {
    var list = notes.length
      ? '<div class="grid" style="gap:12px">' +
        notes
          .map(function (note) {
            return (
              '<article class="card"><div class="card__body" style="padding:18px 20px">' +
              '<div style="display:flex;align-items:flex-start;gap:12px">' +
              '<div style="flex:1;min-width:0">' +
              '<b style="display:block;font-size:14.5px;color:var(--ink)">' + esc(note.title) + '</b>' +
              '<p style="margin-top:4px;font-size:13.5px;color:var(--muted);white-space:pre-wrap">' + esc(note.body) + '</p>' +
              '<span style="display:block;margin-top:8px;font-size:11.5px;color:var(--faint)">' + esc(formatDate(wasEdited(note) ? note.updatedAt : note.createdAt)) +
              (wasEdited(note) ? ' · ' + esc(t('noteEdited')) : '') + '</span>' +
              '</div>' +
              '<div style="display:flex;gap:4px;flex:none">' +
              '<button class="iconbtn" type="button" data-act="edit-note" data-id="' + esc(note.id) + '" aria-label="' + esc(t('edit')) + '">' + icon('edit') + '</button>' +
              '<button class="iconbtn" type="button" data-act="delete-note" data-id="' + esc(note.id) + '" aria-label="' + esc(t('delete')) + '">' + icon('trash') + '</button>' +
              '</div>' +
              '</div></div></article>'
            );
          })
          .join('') +
        '</div>'
      : '<div class="empty"><div class="empty__ic">' + icon('file', 'ic') + '</div>' +
        '<h2>' + esc(t('noNotes')) + '</h2><p>' + esc(t('noNotesSub')) + '</p></div>';

    return (
      '<div class="notice notice--ok" style="margin-bottom:16px">' + icon('shield', 'ic') +
      '<div><b>' + esc(t('notesTitle')) + '</b><br>' + esc(t('notesSub')) + '</div></div>' +
      list +
      '<div class="bar" style="margin-top:18px;justify-content:flex-end">' +
      '<button class="btn btn--sm" type="button" data-act="add-note">' + icon('plus', 'ic') + esc(t('addNote')) + '</button>' +
      '</div>'
    );
  }

  // ─── الرسم ──────────────────────────────────────────────────────────────────

  function render() {
    document.documentElement.lang = T.lang;
    document.documentElement.dir = T.dir;

    var app = $('#app');
    if (state.screen === 'kiosk') app.innerHTML = viewKiosk();
    else if (state.screen === 'login') app.innerHTML = viewLogin();
    else if (state.screen === 'forgot') app.innerHTML = viewForgot();
    else if (state.screen === 'staff') app.innerHTML = viewStaff();
    else if (state.screen === 'portal' && state.portal) app.innerHTML = viewPortal();
    else app.innerHTML = viewHome();

    bindScreen();
  }

  function bindScreen() {
    if (state.screen === 'kiosk') bindKiosk();
    else if (state.screen === 'login') bindLogin();
    else if (state.screen === 'staff') bindStaff();
  }

  // ─── ربط أحداث الكشك ────────────────────────────────────────────────────────

  function bindKiosk() {
    var k = state.kiosk;

    if (k.step === 2) {
      var typeSelect = $('#fkDocType');
      if (typeSelect) {
        typeSelect.addEventListener('change', function () {
          k.docType = typeSelect.value;
          k.docNo = '';
          k.errors = {};
          render();
          var input = $('#fkDocNo');
          if (input) input.focus();
        });
      }

      var docInput = $('#fkDocNo');
      if (docInput) {
        docInput.addEventListener('input', function () {
          k.docNo = normalizeDoc(k.docType, docInput.value);
          docInput.value = k.docNo;
        });
        docInput.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') {
            event.preventDefault();
            var next = $('[data-act="kiosk-step2-next"]');
            if (next) next.click();
          }
        });
      }
      return;
    }

    if (k.step === 3) {
      var day = $('#fkDay');
      var month = $('#fkMonth');
      var year = $('#fkYear');
      if (day) day.addEventListener('change', function () { k.dob.d = day.value; });
      if (month) month.addEventListener('change', function () { k.dob.m = month.value; });
      if (year) year.addEventListener('change', function () { k.dob.y = year.value; });

      var phone = $('#fkPhone');
      if (phone) {
        phone.addEventListener('input', function () {
          k.phone = normalizePhone(phone.value);
          phone.value = k.phone;
        });
      }

      var insurer = $('#fkInsurer');
      if (insurer) insurer.addEventListener('input', function () { k.insurer = insurer.value.trim(); });

      var policy = $('#fkPolicy');
      if (policy) policy.addEventListener('input', function () { k.policy = policy.value.trim(); });

      var pin = $('#fkPin');
      if (pin) pin.addEventListener('input', function () { k.pin = pin.value; });

      var pin2 = $('#fkPin2');
      if (pin2) pin2.addEventListener('input', function () { k.pin2 = pin2.value; });

      var consent = $('#fkConsent');
      if (consent) consent.addEventListener('change', function () { k.consent = consent.checked; });
    }
  }

  // ─── ربط أحداث الدخول ───────────────────────────────────────────────────────

  function bindLogin() {
    var l = state.login;

    var type = $('#lgType');
    if (type) {
      type.addEventListener('change', function () {
        l.docType = type.value;
        l.docNo = '';
        $('#lgDoc').value = '';
        l.error = '';
      });
    }

    var doc = $('#lgDoc');
    if (doc) {
      doc.addEventListener('input', function () {
        l.docNo = normalizeDoc(l.docType, doc.value);
        doc.value = l.docNo;
      });
      doc.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') doLogin();
      });
    }

    var pin = $('#lgPin');
    if (pin) {
      pin.addEventListener('input', function () { l.pin = pin.value; });
      pin.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') doLogin();
      });
    }
  }

  // ─── التنقل ─────────────────────────────────────────────────────────────────

  function go(screen) {
    if (screen === 'portal' && !state.portal) screen = 'login';
    state.screen = screen;
    if (screen === 'kiosk' && state.kiosk.step === 4 && !state.kiosk.result) {
      state.kiosk = freshKiosk();
    }
    render();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  // ─── التسجيل ────────────────────────────────────────────────────────────────

  function buildPayload() {
    var k = state.kiosk;
    var payload = {
      documentType: k.docType,
      documentNumber: k.docNo,
      category: k.category,
      phone: k.phone,
      pin: k.pin,
      consent: k.consent === true,
    };

    if (k.insurer) payload.insurer = k.insurer;
    if (k.policy) payload.policyNumber = k.policy;

    if (k.cal === 'hijri') {
      if (k.dob.y && k.dob.m && k.dob.d) {
        payload.birthDateHijri = { year: Number(k.dob.y), month: Number(k.dob.m), day: Number(k.dob.d) };
      }
    } else if (k.dob.y && k.dob.m && k.dob.d) {
      payload.birthDate = k.dob.y + '-' + String(k.dob.m).padStart(2, '0') + '-' + String(k.dob.d).padStart(2, '0');
    }

    return payload;
  }

  /** فحص محلي محدود — يُستخدم فقط عند انعدام الخادم. التحقق المرجعي على الخادم. */
  function localCheck(payload) {
    var errors = {};
    var type = payload.documentType;
    var number = payload.documentNumber;

    if (!number) errors.docNo = 'eRequired';
    else if (type === 'nid' && !/^1\d{9}$/.test(number)) errors.docNo = 'eNid';
    else if (type === 'iqama' && !/^2\d{9}$/.test(number)) errors.docNo = 'eIqama';
    else if (type === 'passport' && !/^[A-Za-z0-9]{6,12}$/.test(number)) errors.docNo = 'ePass';

    if (payload.category === 'citizen' && type !== 'nid') errors.docType = 'eCitizenDoc';

    if (!payload.birthDate && !payload.birthDateHijri) errors.birthDate = 'eRequired';
    if (!/^05\d{8}$/.test(payload.phone)) errors.phone = payload.phone ? 'ePhone' : 'eRequired';
    if (payload.category === 'insured') {
      if (!payload.insurer) errors.insurer = 'eRequired';
      if (!payload.policyNumber) errors.policyNumber = 'eRequired';
    }
    if (!payload.pin || payload.pin.length < 6) errors.pin = 'ePinShort';
    if (state.kiosk.pin2 !== payload.pin) errors.pin2 = 'ePinMatch';
    if (payload.consent !== true) errors.consent = 'eConsent';

    return errors;
  }

  function mapServerFields(fields) {
    var mapped = {};
    Object.keys(fields || {}).forEach(function (key) {
      var target =
        key === 'documentNumber' ? 'docNo'
          : key === 'documentType' ? 'docType'
            : key === 'birthDate' ? 'birthDate'
              : key;
      mapped[target] = fields[key];
    });
    return mapped;
  }

  function profileFromPayload(payload, masked, createdAt) {
    return {
      docType: payload.documentType,
      docNumber: payload.documentNumber,
      masked: masked,
      birthDate: payload.birthDate || '',
      phone: payload.phone,
      category: payload.category,
      insurer: payload.insurer || '',
      policyNumber: payload.policyNumber || '',
      createdAt: createdAt || new Date().toISOString(),
    };
  }

  /**
   * يحفظ التسجيل في السحابة: ينشئ حساب الدخول إن لم يكن موجوداً،
   * ثم يرفع بيانات المريض والزيارة. يعيد الملف الكامل بعد الحفظ.
   */
  async function persistCloud(payload, patient, visit, token, mode) {
    var profile = profileFromPayload(
      payload,
      patient ? patient.maskedDocumentNumber : C.mask(payload.documentNumber),
      patient ? patient.createdAt : null
    );

    return Cloud.register({
      docType: payload.documentType,
      docNumber: payload.documentNumber,
      pin: payload.pin,
      profile: profile,
      visit: visit,
      mode: mode,
    });
  }

  async function submitRegistration() {
    var k = state.kiosk;
    if (k.busy) return;

    k.errors = {};
    var payload = buildPayload();

    if (k.pin2 !== k.pin) k.errors.pin2 = 'ePinMatch';
    if (Object.keys(k.errors).length) {
      render();
      return;
    }

    k.busy = true;
    render();

    try {
      if (!Api.checked) await Api.init();

      if (Api.online) {
        var registration;
        try {
          registration = await Api.register(payload);
        } catch (error) {
          if (error.fields) {
            k.errors = mapServerFields(error.fields);
            k.busy = false;
            render();
            return;
          }
          throw error;
        }

        var visitResponse = null;
        try {
          visitResponse = await Api.createVisit(
            { patientId: registration.patient.id, reason: null },
            registration.token
          );
        } catch (error) {
          visitResponse = null;
        }

        var visit = visitResponse
          ? Object.assign({}, visitResponse.visit, { sync: visitResponse.sync })
          : null;

        var session = await persistCloud(
          payload,
          registration.patient,
          visit,
          registration.token,
          'online'
        );

        k.result = {
          queueNumber: visit ? visit.queueNumber : (session.visit ? session.visit.queueNumber : '—'),
          sync: visitResponse ? visitResponse.sync : {},
          offline: false,
        };
        k.session = session;
        k.busy = false;
        k.step = 4;
        render();
        toast(t('registered'), 'ok');
        return;
      }

      // ─── وضع بلا خادم: رقم انتظار محلي + حفظ سحابي ───
      var errors = localCheck(payload);
      if (Object.keys(errors).length) {
        k.errors = errors;
        k.busy = false;
        render();
        return;
      }

      var localVisit = {
        queueNumber: null,
        status: 'waiting',
        reason: null,
        createdAt: new Date().toISOString(),
        sync: {},
      };

      var localSession = await persistCloud(
        payload,
        null,
        localVisit,
        null,
        'local'
      );

      var savedVisit = localSession.visit || localVisit;
      k.result = { queueNumber: savedVisit.queueNumber, sync: {}, offline: true };
      k.session = localSession;
      k.busy = false;
      k.step = 4;
      render();
    } catch (error) {
      k.busy = false;
      k.errors = {};
      render();
      toast(errText(error && error.code ? error.code : 'errGeneric'), 'err');
    }
  }

  // ─── الدخول ─────────────────────────────────────────────────────────────────

  async function doLogin() {
    var l = state.login;
    if (l.busy) return;

    l.error = '';

    if (!l.docNo || !l.pin) {
      l.error = 'errRequired';
      render();
      return;
    }

    l.busy = true;
    render();

    try {
      var session = await Cloud.login(l.docType, l.docNo, l.pin);

      l.busy = false;
      l.pin = '';
      state.staff = null;
      openPortal(session.account, session.data);
    } catch (error) {
      l.busy = false;
      l.error = error && error.code ? error.code : 'errGeneric';
      render();
    }
  }

  function openPortal(account, data) {
    state.portal = { account: account, data: data, tab: 'overview' };
    state.screen = 'portal';
    render();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  // ─── الملاحظات ──────────────────────────────────────────────────────────────

  function noteDialog(note) {
    var editing = !!note;

    openModal({
      title: t(editing ? 'editNote' : 'addNote'),
      body:
        '<div class="field"><label for="ntTitle">' + esc(t('noteTitle')) + '</label>' +
        '<input class="input" id="ntTitle" maxlength="80" value="' + esc(editing ? note.title : '') + '" placeholder="' + esc(t('noteTitlePh')) + '"></div>' +
        '<div class="field"><label for="ntBody">' + esc(t('noteBody')) + '</label>' +
        '<textarea class="input" id="ntBody" rows="5" maxlength="2000" style="resize:vertical" placeholder="' + esc(t('noteBodyPh')) + '">' + esc(editing ? note.body : '') + '</textarea></div>',
      actions: [
        { label: t('cancel'), variant: 'btn--ghost' },
        {
          label: t('save'),
          variant: 'btn',
          onClick: function () {
            var title = ($('#ntTitle').value || '').trim();
            var body = ($('#ntBody').value || '').trim();
            if (!title && !body) return;

            var promise = editing
              ? Cloud.updateNote(note.id, title, body)
              : Cloud.addNote(title, body);

            promise
              .then(function (saved) {
                var p = state.portal;
                if (!p) return;
                var notes = (p.data.notes || []).slice();
                if (editing) {
                  notes = notes.map(function (item) { return item.id === saved.id ? saved : item; });
                } else {
                  notes.unshift(saved);
                }
                p.data.notes = notes;
                render();
                toast(t(editing ? 'noteUpdated' : 'noteAdded'), 'ok');
              })
              .catch(function (error) {
                toast(errText(error && error.code ? error.code : 'errGeneric'), 'err');
              });
          },
        },
      ],
    });
  }

  function addNoteDialog() {
    noteDialog(null);
  }

  function editNoteDialog(id) {
    var p = state.portal;
    if (!p) return;
    var note = (p.data.notes || []).filter(function (item) { return item.id === id; })[0];
    if (note) noteDialog(note);
  }

  function deleteNoteDialog(id) {
    openModal({
      title: t('confirmDeleteTitle'),
      body: '<p>' + esc(t('confirmDeleteBody')) + '</p>',
      actions: [
        { label: t('cancel'), variant: 'btn--ghost' },
        {
          label: t('confirmYes'),
          variant: 'btn--danger',
          onClick: function () {
            Cloud.deleteNote(id)
              .then(function () {
                var p = state.portal;
                if (!p) return;
                p.data.notes = (p.data.notes || []).filter(function (note) { return note.id !== id; });
                render();
                toast(t('noteDeleted'), 'ok');
              })
              .catch(function (error) {
                toast(errText(error && error.code ? error.code : 'errGeneric'), 'err');
              });
          },
        },
      ],
    });
  }

  // ─── تغيير رمز الدخول ───────────────────────────────────────────────────────

  function changePinDialog() {
    var p = state.portal;
    if (!p) return;

    openModal({
      title: t('changePinTitle'),
      body:
        '<p style="margin-bottom:14px;font-size:13.5px;color:var(--ink-2)">' + esc(t('changePinLead')) + '</p>' +
        '<div class="notice notice--warn" style="margin-bottom:16px">' + icon('alert', 'ic') + '<div>' + esc(t('changePinWarn')) + '</div></div>' +
        '<div class="field"><label for="cpCurrent">' + esc(t('currentPin')) + '</label>' +
        '<input class="input input--ltr" id="cpCurrent" type="password" autocomplete="current-password" maxlength="72"></div>' +
        '<div class="field"><label for="cpNew">' + esc(t('newPin')) + '</label>' +
        '<input class="input input--ltr" id="cpNew" type="password" autocomplete="new-password" maxlength="72"></div>' +
        '<div class="field"><label for="cpNew2">' + esc(t('confirmNewPin')) + '</label>' +
        '<input class="input input--ltr" id="cpNew2" type="password" autocomplete="new-password" maxlength="72"></div>' +
        '<div id="cpErr" hidden class="notice notice--danger" style="margin-top:12px"></div>',
      actions: [
        { label: t('cancel'), variant: 'btn--ghost' },
        { label: t('save'), variant: 'btn', close: false, onClick: submitPinChange },
      ],
    });
  }

  function submitPinChange() {
    var current = $('#cpCurrent') ? $('#cpCurrent').value : '';
    var next = $('#cpNew') ? $('#cpNew').value : '';
    var next2 = $('#cpNew2') ? $('#cpNew2').value : '';
    var box = $('#cpErr');
    var button = $('#modalFoot [data-modal-action="1"]');

    function fail(code) {
      if (box) {
        box.hidden = false;
        box.innerHTML = icon('alert', 'ic') + '<div>' + esc(errText(code)) + '</div>';
      }
    }

    if (!current || !next) return fail('errRequired');
    if (next.length < 6) return fail('errPinShort');
    if (next !== next2) return fail('errPinMatch');
    if (next === current) return fail('errPinSame');

    if (box) {
      box.hidden = true;
      box.innerHTML = '';
    }
    if (button) {
      button.disabled = true;
      button.textContent = t('loading');
    }

    Cloud.changePin(current, next)
      .then(function () {
        closeModal();
        toast(t('changePinSuccess'), 'ok');
      })
      .catch(function (error) {
        if (button) {
          button.disabled = false;
          button.textContent = t('save');
        }
        fail(error && error.code ? error.code : 'errGeneric');
      });
  }

  function exportVault() {
    var p = state.portal;
    if (!p) return;
    var record = Object.assign({}, p.data);
    // لا نُصدّر رمز الجلسة: نسخة المستخدم تحتاج بياناته فقط، لا مفتاح دخول حيّاً.
    delete record.token;
    var payload = {
      exportedAt: new Date().toISOString(),
      application: 'Urgent Care',
      record: record,
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'urgent-care-record-' + (p.account.masked || 'patient').replace(/•/g, '') + '.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    toast(t('exported'), 'ok');
  }

  // ─── الأحداث العامة ─────────────────────────────────────────────────────────

  document.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-act]');
    if (!trigger) {
      if (event.target.closest('[data-close-modal]')) closeModal();
      return;
    }

    var act = trigger.getAttribute('data-act');

    if (act === 'home') {
      event.preventDefault();
      go('home');
      return;
    }
    if (act === 'go') {
      event.preventDefault();
      go(trigger.getAttribute('data-screen'));
      return;
    }
    if (act === 'lang') {
      event.preventDefault();
      T.toggle();
      render();
      return;
    }

    if (act === 'menu') {
      event.preventDefault();
      toggleMenu();
      return;
    }

    if (act === 'pick-category') {
      var cat = trigger.getAttribute('data-cat');
      state.kiosk.category = cat;
      state.kiosk.docType = cat === 'domestic' ? 'iqama' : 'nid';
      state.kiosk.docNo = '';
      state.kiosk.cal = 'greg';
      state.kiosk.errors = {};
      state.kiosk.step = 2;
      render();
      return;
    }

    if (act === 'kiosk-back') {
      state.kiosk.step = Math.max(1, state.kiosk.step - 1);
      state.kiosk.errors = {};
      render();
      return;
    }

    if (act === 'kiosk-step2-next') {
      var k = state.kiosk;
      var payload = { documentType: k.docType, documentNumber: k.docNo };
      var errors = localCheck(Object.assign({}, payload, {
        category: k.category,
        phone: '0500000000',
        pin: '000000',
        consent: true,
      }));
      var docError = errors.docNo;
      if (docError) {
        k.errors = { docNo: docError };
        render();
        return;
      }
      k.errors = {};
      k.step = 3;
      render();
      return;
    }

    if (act === 'cal') {
      state.kiosk.cal = trigger.getAttribute('data-cal');
      state.kiosk.dob = { d: '', m: '', y: '' };
      render();
      return;
    }

    if (act === 'submit') {
      submitRegistration();
      return;
    }

    if (act === 'again') {
      state.kiosk = freshKiosk();
      render();
      return;
    }

    if (act === 'open-portal') {
      var session = state.kiosk.session;
      if (session) {
        state.kiosk = freshKiosk();
        openPortal(session.account, session.data);
      } else {
        go('login');
      }
      return;
    }

    if (act === 'login') {
      doLogin();
      return;
    }

    if (act === 'logout') {
      Cloud.logout();
      state.portal = null;
      state.login = { docType: 'nid', docNo: '', pin: '', error: '', busy: false };
      go('home');
      return;
    }

    if (act === 'staff-login') {
      doStaffLogin();
      return;
    }

    if (act === 'staff-logout') {
      Cloud.logout();
      state.staff = null;
      state.staffLogin = { docType: 'nid', docNo: '', pin: '', error: '', busy: false };
      go('home');
      return;
    }

    if (act === 'staff-refresh') {
      refreshStaffVisits();
      return;
    }

    if (act === 'staff-status') {
      updateStaffVisit(trigger.getAttribute('data-id'), trigger.getAttribute('data-status'));
      return;
    }

    if (act === 'change-pin') {
      changePinDialog();
      return;
    }

    if (act === 'tab') {
      state.portal.tab = trigger.getAttribute('data-tab');
      render();

      // جلب أحدث الملاحظات من السحابة عند فتح تبويب الملاحظات.
      if (state.portal.tab === 'notes') {
        Cloud.refresh()
          .then(function (data) {
            if (!state.portal || state.portal.tab !== 'notes') return;
            state.portal.data = data;
            render();
          })
          .catch(function (error) {
            toast(errText(error && error.code ? error.code : 'errCloud'), 'err');
          });
      }
      return;
    }

    if (act === 'add-note') {
      addNoteDialog();
      return;
    }

    if (act === 'edit-note') {
      editNoteDialog(trigger.getAttribute('data-id'));
      return;
    }

    if (act === 'delete-note') {
      deleteNoteDialog(trigger.getAttribute('data-id'));
      return;
    }

    if (act === 'export') {
      exportVault();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (!$('#modal').hidden) closeModal();
    else closeMenu();
  });

  document.addEventListener('click', function (event) {
    var nav = $('#topNav');
    if (!nav || !nav.classList.contains('is-open')) return;
    if (event.target.closest('#topNav') || event.target.closest('[data-act="menu"]')) return;
    closeMenu();
  });

  // ─── الإقلاع ────────────────────────────────────────────────────────────────

  function boot() {
    if (!C || !C.supported()) {
      $('#app').innerHTML =
        '<div class="wrap" style="max-width:560px;padding-block:120px">' +
        '<div class="notice notice--danger">' + icon('alert', 'ic') + '<div>' + esc(t('errNoCrypto')) + '</div></div></div>';
      return;
    }

    if (!Cloud) {
      $('#app').innerHTML =
        '<div class="wrap" style="max-width:560px;padding-block:120px">' +
        '<div class="notice notice--danger">' + icon('alert', 'ic') + '<div>' + esc(t('errCloudOff')) + '</div></div></div>';
      return;
    }

    render();

    var cloudInfo = Cloud.init();
    if (cloudInfo.mode === 'demo' && window.console && window.console.info) {
      window.console.info('[urgent-care] Supabase غير مهيّأ: يعمل التطبيق في وضع تجريبي داخل الذاكرة فقط. أضف url و anonKey في assets/js/supabase-config.js.');
    }

    Api.init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
