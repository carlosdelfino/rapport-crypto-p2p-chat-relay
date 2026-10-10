    function esc(s) {
      return String(s).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function tt(k) { return (window.I18N && I18N.t(k)) || k; }
    function curLocale() { return (window.I18N && I18N.locale) || 'pt-BR'; }

    function formatNumber(n) {
      return Number(n).toLocaleString(curLocale());
    }

    function formatCompact(n) {
      return Number(n).toLocaleString(curLocale(), { notation: 'compact', maximumFractionDigits: 1 });
    }

    let lastStats = null;
    let statsFailed = false;

    function renderAll() {
      if (statsFailed) {
        document.getElementById('stats-content').innerHTML = '<p class="error">' + esc(tt('stats.error')) + '</p>';
        document.getElementById('stats-summary').innerHTML = '';
        return;
      }
      if (!lastStats) return;
      renderStats(lastStats);
      renderSummary(lastStats);
    }

    function renderStats(s) {
      document.getElementById('stats-content').innerHTML =
        '<div class="stats-grid">' +
          '<div class="stat-card"><div class="stat-value">' + formatNumber(s.totalWallets) + '</div><div class="stat-label">' + esc(tt('stats.card.wallets')) + '</div></div>' +
          '<div class="stat-card"><div class="stat-value">' + formatNumber(s.onlineWallets) + '</div><div class="stat-label">' + esc(tt('stats.card.online')) + '</div></div>' +
          '<div class="stat-card"><div class="stat-value">' + formatNumber(s.totalMessages) + '</div><div class="stat-label">' + esc(tt('stats.card.messages')) + '</div></div>' +
          '<div class="stat-card"><div class="stat-value">' + formatNumber(s.totalChats) + '</div><div class="stat-label">' + esc(tt('stats.card.chats')) + '</div></div>' +
        '</div>' +
        '<p class="updated">' + esc(tt('stats.updatedAt')) + ' ' + new Date(s.updatedAt).toLocaleString(curLocale()) + '</p>';
    }

    // Consolidação para a home: uma linha com os totais, sem as tabelas
    // detalhadas que ficam na página /stats.
    function renderSummary(s) {
      const el = document.getElementById('stats-summary');
      if (!el) return;
      const financial = s.financial || {};
      const demand = s.escrowDemand || {};
      const txs = financial.totalTransactions || 0;
      const nets = (financial.volumeByNetwork || []).length;
      const reqs = demand.totalRequests || 0;
      const parts = [];
      if (txs) parts.push(esc(tt('stats.fin.total')) + ' <strong>' + formatNumber(txs) + '</strong>');
      if (nets) parts.push('<strong>' + formatNumber(nets) + '</strong> ' + esc(tt('stats.summary.networks')));
      if (reqs) parts.push(esc(tt('stats.escrow.total')) + ' <strong>' + formatNumber(reqs) + '</strong>');
      el.innerHTML = '<p class="updated stats-summary-line">' +
        (parts.length ? parts.join(' · ') : esc(tt('stats.summary.empty'))) + '</p>';
    }

    async function loadStats() {
      try {
        const resp = await fetch('/api/stats');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const json = await resp.json();
        const s = json.data;
        if (!s) throw new Error('Dados indisponíveis');
        lastStats = s;
        statsFailed = false;
      } catch (err) {
        statsFailed = true;
      }
      renderAll();
    }

    window.addEventListener('i18n:change', renderAll);
    loadStats();
    setInterval(loadStats, 60000);
