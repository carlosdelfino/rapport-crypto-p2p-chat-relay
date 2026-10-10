/**
 * contact.js — ações de contato das páginas públicas do relay.
 *
 * 1. Todo link para wa.me / api.whatsapp.com ganha `?text=` com a mensagem de
 *    suporte localizada, incluindo a URL da página em que o usuário estava.
 * 2. Elementos com `[data-addr]` copiam o endereço para a área de
 *    transferência ao clique (âncoras têm a navegação suprimida); botões
 *    `.copy-btn[data-copy="<id>"]` copiam o elemento referenciado.
 *    O feedback é um toast "Copiado!" (reutiliza #toast ou cria um).
 *
 * O enriquecimento roda no carregamento, a cada `i18n:change` e por
 * delegação no clique — cobrindo links injetados tardiamente pelos
 * dicionários de idioma.
 */
(function () {
  'use strict';

  var WA_SELECTOR = 'a[href*="wa.me/"], a[href*="api.whatsapp.com/"]';
  var INTERACTIVE = /^(A|BUTTON)$/;

  function tt(key, fallback) {
    var v = window.I18N ? I18N.t(key) : null;
    return (v && v !== key) ? v : fallback;
  }

  function waMessage() {
    var tpl = tt(
      'wa.support.msg',
      'Olá! Preciso de suporte no Rapport Crypto Chat. Estou na página: {page}'
    );
    return tpl.replace('{page}', location.href);
  }

  function enhanceWaLink(a, force) {
    try {
      var url = new URL(a.getAttribute('href') || '', location.href);
      if (!/(^|\.)wa\.me$/.test(url.hostname) && url.hostname !== 'api.whatsapp.com') return;
      var had = url.searchParams.get('text');
      if (had && !(force && a.hasAttribute('data-wa-auto'))) return;
      url.searchParams.set('text', waMessage());
      a.setAttribute('href', url.toString());
      a.setAttribute('data-wa-auto', '1');
    } catch (e) { /* href inválido — ignora */ }
  }

  function enhanceAll(force) {
    var links = document.querySelectorAll(WA_SELECTOR);
    for (var i = 0; i < links.length; i++) enhanceWaLink(links[i], force);

    var hint = tt('contact.copy.hint', 'Clique para copiar');
    var addrs = document.querySelectorAll('[data-addr]');
    for (var j = 0; j < addrs.length; j++) {
      var el = addrs[j];
      if (!INTERACTIVE.test(el.tagName)) {
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
        if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
      }
      if (!el.hasAttribute('title') || el.hasAttribute('data-title-auto')) {
        el.setAttribute('title', hint);
        el.setAttribute('data-title-auto', '1');
      }
    }
  }

  function showCopied() {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = tt('ajudar.copied', 'Copiado!');
    el.classList.add('show');
    clearTimeout(el.__hide);
    el.__hide = setTimeout(function () { el.classList.remove('show'); }, 2000);
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showCopied(); } catch (e) { /* sem clipboard */ }
    document.body.removeChild(ta);
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(showCopied, function () { legacyCopy(text); });
    } else {
      legacyCopy(text);
    }
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;

    var wa = t.closest(WA_SELECTOR);
    if (wa) { enhanceWaLink(wa); return; }

    var btn = t.closest('.copy-btn[data-copy]');
    if (btn) {
      var ref = document.getElementById(btn.getAttribute('data-copy'));
      if (ref) copyText(ref.getAttribute('data-addr') || ref.textContent.trim());
      return;
    }

    var addr = t.closest('[data-addr]');
    if (addr) {
      if (addr.tagName === 'A') ev.preventDefault();
      copyText(addr.getAttribute('data-addr'));
    }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var addr = ev.target && ev.target.closest ? ev.target.closest('[data-addr]') : null;
    if (addr && !INTERACTIVE.test(addr.tagName)) {
      ev.preventDefault();
      copyText(addr.getAttribute('data-addr'));
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { enhanceAll(false); });
  } else {
    enhanceAll(false);
  }
  window.addEventListener('i18n:change', function () { enhanceAll(true); });
})();
