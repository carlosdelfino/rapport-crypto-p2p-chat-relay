/**
 * i18n — motor de tradução client-side das páginas estáticas do relay.
 *
 * Idioma ativo é decidido por (nesta ordem):
 *   1. `?lang=` na URL (persiste em localStorage);
 *   2. `localStorage['rcc-lang']`;
 *   3. `navigator.languages` / `navigator.language` (prefixo);
 *   4. fallback 'en'.
 *
 * O HTML de cada página é a fonte pt-BR: na primeira aplicação o conteúdo
 * original de cada elemento marcado é capturado (snapshot), então voltar a
 * pt-BR restaura o texto original sem dicionário. Os dicionários dos demais
 * idiomas vivem em `/js/i18n/<lang>.js` e são carregados sob demanda.
 *
 * Marcação suportada nos elementos:
 *   data-i18n="key"            -> textContent traduzido
 *   data-i18n-html="key"       -> innerHTML traduzido (strings com marcação)
 *   data-i18n-attr="attr:key;attr:key" -> atributos traduzidos
 *   data-i18n-date="<iso>"     -> data/hora formatada no locale ativo
 *   data-i18n-param-<nome>="<v>" -> substitui `{<nome>}` na string traduzida
 *
 * API pública (window.I18N):
 *   I18N.lang     -> código do idioma ativo (ex.: 'en')
 *   I18N.locale   -> locale BCP-47 para Intl/toLocaleString (ex.: 'en-GB')
 *   I18N.t(key)   -> string no idioma ativo (fallback pt-BR, depois a chave)
 *   I18N.setLang(code) -> troca o idioma sem reload
 *   evento window 'i18n:change' (detail.lang) após cada troca aplicada
 */
(function () {
  'use strict';

  var SOURCE_LANG = 'pt-BR';
  var DEFAULT_LANG = 'en';
  var STORAGE_KEY = 'rcc-lang';
  var LOADING_CLASS = 'i18n-loading';

  var LANGS = [
    { code: 'pt-BR', flag: '🇧🇷', label: 'Português', locale: 'pt-BR', ogLocale: 'pt_BR', dir: 'ltr' },
    { code: 'en', flag: '🇬🇧', label: 'English', locale: 'en-GB', ogLocale: 'en_GB', dir: 'ltr' },
    { code: 'es', flag: '🇪🇸', label: 'Español', locale: 'es-ES', ogLocale: 'es_ES', dir: 'ltr' },
    { code: 'fr', flag: '🇫🇷', label: 'Français', locale: 'fr-FR', ogLocale: 'fr_FR', dir: 'ltr' },
    { code: 'ar', flag: '🇦🇪', label: 'العربية', locale: 'ar-AE', ogLocale: 'ar_AE', dir: 'rtl' },
  ];

  /**
   * Dicionário pt-BR mínimo: apenas chaves consumidas via I18N.t() por
   * conteúdo gerado em JS (stats, escrow). Textos pt-BR do HTML não precisam
   * de entrada aqui — são restaurados pelo snapshot do DOM.
   */
  var dicts = {};
  dicts[SOURCE_LANG] = {
    'stats.loading': 'Carregando estatísticas…',
    'stats.loadingFinancial': 'Carregando dados financeiros…',
    'stats.loadingEscrow': 'Carregando pedidos de escrow…',
    'stats.error': 'Não foi possível carregar as estatísticas no momento.',
    'stats.card.wallets': 'Carteiras registradas',
    'stats.card.online': 'Online agora',
    'stats.card.messages': 'Mensagens transmitidas',
    'stats.card.chats': 'Chats ativos',
    'stats.updatedAt': 'Atualizado em:',
    'stats.fin.none': 'Nenhuma transação reportada ainda.',
    'stats.fin.bySymbol': 'Por ativo',
    'stats.fin.byNetwork': 'Por rede',
    'stats.fin.col.asset': 'Ativo',
    'stats.fin.col.txs': 'Transações',
    'stats.fin.col.amount': 'Montante total',
    'stats.fin.col.network': 'Rede',
    'stats.fin.col.assets': 'Ativos',
    'stats.fin.total': 'Total de transações reportadas:',
    'stats.escrow.none': 'Nenhum pedido de escrow registrado.',
    'stats.escrow.col.requests': 'Pedidos',
    'stats.escrow.total': 'Total de pedidos:',
    'escrow.net.loading': 'Carregando redes…',
    'escrow.net.none': 'Nenhuma rede com escrow publicada ainda — o deploy inicial está em andamento. Volte em breve.',
    'escrow.net.note': 'Contratos EscrowVault deployados (proxy transparente, administrado por multisig 2-de-3):',
    'escrow.net.error': 'Não foi possível carregar a lista de redes agora.',
    'escrow.net.explorer': 'ver no explorer ↗',
    'escrow.net.mainnet': 'mainnet',
    'escrow.net.testnet': 'testnet',
  };

  var loadingDicts = {};
  var current = SOURCE_LANG;
  var snapshots = new Map();
  var bar = null;

  function langInfo(code) {
    for (var i = 0; i < LANGS.length; i++) {
      if (LANGS[i].code === code) return LANGS[i];
    }
    return null;
  }

  function resolve(tag) {
    if (!tag) return null;
    var t = String(tag).toLowerCase();
    for (var i = 0; i < LANGS.length; i++) {
      var c = LANGS[i].code.toLowerCase();
      if (t === c) return LANGS[i].code;
    }
    var prefix = t.split('-')[0].split('_')[0];
    var map = { pt: 'pt-BR', en: 'en', es: 'es', fr: 'fr', ar: 'ar' };
    return map[prefix] || null;
  }

  function detect() {
    var q = null;
    try {
      q = new URLSearchParams(window.location.search).get('lang');
    } catch (e) { /* URLSearchParams indisponível */ }
    // ?lang= válido persiste em localStorage (o snippet do head pode já ter
    // consumido o parâmetro via __i18nLang — por isso a escrita vem antes).
    var qCode = resolve(q);
    if (qCode) {
      try { window.localStorage.setItem(STORAGE_KEY, qCode); } catch (e) { /* sem storage */ }
    }
    if (window.__i18nLang && langInfo(window.__i18nLang)) return window.__i18nLang;
    var stored = null;
    try { stored = window.localStorage.getItem(STORAGE_KEY); } catch (e) { /* sem storage */ }
    var navs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]);
    var code = qCode || resolve(stored);
    if (!code) {
      for (var i = 0; i < navs.length; i++) {
        code = resolve(navs[i]);
        if (code) break;
      }
    }
    return code || DEFAULT_LANG;
  }

  function loadDict(lang) {
    if (lang === SOURCE_LANG || dicts[lang]) return Promise.resolve();
    if (loadingDicts[lang]) return loadingDicts[lang];
    loadingDicts[lang] = new Promise(function (resolveP, rejectP) {
      var s = document.createElement('script');
      s.src = '/js/i18n/' + lang + '.js';
      s.async = true;
      s.onload = function () {
        if (dicts[lang]) resolveP();
        else rejectP(new Error('i18n: dicionário não registrou ' + lang));
      };
      s.onerror = function () { rejectP(new Error('i18n: falha ao carregar /js/i18n/' + lang + '.js')); };
      document.head.appendChild(s);
    });
    return loadingDicts[lang];
  }

  function lookup(key) {
    var d = dicts[current];
    if (d && d[key] != null) return d[key];
    var p = dicts[SOURCE_LANG];
    if (p && p[key] != null) return p[key];
    return null;
  }

  function parseAttrSpec(spec) {
    var out = [];
    spec.split(';').forEach(function (pair) {
      var idx = pair.indexOf(':');
      if (idx > 0) out.push([pair.slice(0, idx).trim(), pair.slice(idx + 1).trim()]);
    });
    return out;
  }

  function snapshot(el) {
    if (snapshots.has(el)) return snapshots.get(el);
    var snap = { text: null, html: null, attrs: {}, date: null };
    if (el.hasAttribute('data-i18n')) snap.text = el.textContent;
    if (el.hasAttribute('data-i18n-html')) snap.html = el.innerHTML;
    if (el.hasAttribute('data-i18n-attr')) {
      parseAttrSpec(el.getAttribute('data-i18n-attr')).forEach(function (p) {
        snap.attrs[p[0]] = el.getAttribute(p[0]);
      });
    }
    if (el.hasAttribute('data-i18n-date')) snap.date = el.textContent;
    snapshots.set(el, snap);
    return snap;
  }

  function interpolate(str, el) {
    return str.replace(/\{(\w+)\}/g, function (m, name) {
      var v = el.getAttribute('data-i18n-param-' + name);
      return v != null ? v : m;
    });
  }

  function applyElement(el) {
    var snap = snapshot(el);
    var restore = current === SOURCE_LANG;

    if (el.hasAttribute('data-i18n')) {
      var k = el.getAttribute('data-i18n');
      var v = restore ? snap.text : lookup(k);
      if (v != null) el.textContent = interpolate(v, el);
    }
    if (el.hasAttribute('data-i18n-html')) {
      var kh = el.getAttribute('data-i18n-html');
      var vh = restore ? snap.html : lookup(kh);
      if (vh != null) el.innerHTML = interpolate(vh, el);
    }
    if (el.hasAttribute('data-i18n-attr')) {
      parseAttrSpec(el.getAttribute('data-i18n-attr')).forEach(function (p) {
        var va = restore ? snap.attrs[p[0]] : lookup(p[1]);
        if (va != null) el.setAttribute(p[0], interpolate(va, el));
      });
    }
    if (el.hasAttribute('data-i18n-date')) {
      var iso = el.getAttribute('data-i18n-date');
      if (restore) {
        if (snap.date != null) el.textContent = snap.date;
      } else {
        var dt = new Date(iso);
        if (!isNaN(dt.getTime())) {
          el.textContent = dt.toLocaleString(langInfo(current).locale, {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
          });
        }
      }
    }
  }

  function apply() {
    var info = langInfo(current) || langInfo(DEFAULT_LANG);
    document.documentElement.lang = current;
    document.documentElement.dir = info.dir;

    var ogLocale = document.querySelector('meta[property="og:locale"]');
    if (ogLocale) ogLocale.setAttribute('content', info.ogLocale);

    var els = document.querySelectorAll('[data-i18n],[data-i18n-html],[data-i18n-attr],[data-i18n-date]');
    for (var i = 0; i < els.length; i++) applyElement(els[i]);
  }

  function updateBar() {
    if (!bar) return;
    var btns = bar.querySelectorAll('.lang-btn');
    for (var i = 0; i < btns.length; i++) {
      var active = btns[i].getAttribute('data-lang') === current;
      btns[i].classList.toggle('active', active);
      btns[i].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function injectBar() {
    if (bar || !document.body) return;
    bar = document.createElement('nav');
    bar.className = 'lang-bar';
    bar.setAttribute('aria-label', 'Language / Idioma');
    LANGS.forEach(function (l) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'lang-btn';
      b.textContent = l.flag;
      b.title = l.label;
      b.setAttribute('aria-label', l.label);
      b.setAttribute('data-lang', l.code);
      b.setAttribute('lang', l.code);
      b.addEventListener('click', function () { setLang(l.code); });
      bar.appendChild(b);
    });
    var container = document.querySelector('.container') || document.body;
    container.insertBefore(bar, container.firstChild);
  }

  function ready() {
    document.documentElement.classList.remove(LOADING_CLASS);
  }

  function setLang(code) {
    if (!langInfo(code) || code === current) { updateBar(); return; }
    try { window.localStorage.setItem(STORAGE_KEY, code); } catch (e) { /* sem storage */ }
    loadDict(code).then(function () {
      current = code;
      apply();
      updateBar();
      window.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang: code } }));
    }).catch(function (err) {
      if (window.console && console.warn) console.warn(err.message || err);
    });
  }

  function t(key) {
    var v = lookup(key);
    return v != null ? v : key;
  }

  function init() {
    injectBar();
    var target = detect();
    updateBar();
    loadDict(target).then(function () {
      current = target;
      apply();
      updateBar();
      if (target !== SOURCE_LANG) {
        window.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang: target } }));
      }
      ready();
    }).catch(function (err) {
      if (window.console && console.warn) console.warn(err.message || err);
      ready();
    });
  }

  window.I18N = {
    LANGS: LANGS,
    get lang() { return current; },
    get locale() { return (langInfo(current) || langInfo(DEFAULT_LANG)).locale; },
    t: t,
    setLang: setLang,
    register: function (lang, dict) { dicts[lang] = dict; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
