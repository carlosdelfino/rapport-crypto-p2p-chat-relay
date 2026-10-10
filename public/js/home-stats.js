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
        ['stats-content', 'financial-content', 'escrow-demand-content'].forEach(function(id) { document.getElementById(id).innerHTML = '<p class="error">' + esc(tt('stats.error')) + '</p>'; });
        return;
      }
      if (!lastStats) return;
      renderStats(lastStats);
      if (lastStats.financial) renderFinancial(lastStats.financial);
      if (lastStats.escrowDemand) renderEscrowDemand(lastStats.escrowDemand);
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

    function renderFinancial(financial) {
      const container = document.getElementById('financial-content');
      const bySymbol = (financial && financial.volumeBySymbol) || [];
      const byNetwork = (financial && financial.volumeByNetwork) || [];
      if (!bySymbol.length && !byNetwork.length) {
        container.innerHTML = '<p class="loading">' + esc(tt('stats.fin.none')) + '</p>';
        return;
      }
      let html = '';
      if (bySymbol.length) {
        let rows = '';
        for (const item of bySymbol) {
          rows += '<tr><td class="mono">' + esc(item.symbol) + '</td><td>' + formatNumber(item.count) + '</td><td class="mono">' + formatNumber(item.amount) + '</td></tr>';
        }
        html += '<div class="table-title">' + esc(tt('stats.fin.bySymbol')) + '</div>' +
          '<table class="financial-table"><thead><tr><th>' + esc(tt('stats.fin.col.asset')) + '</th><th>' + esc(tt('stats.fin.col.txs')) + '</th><th>' + esc(tt('stats.fin.col.amount')) + '</th></tr></thead><tbody>' + rows + '</tbody></table>';
      }
      if (byNetwork.length) {
        let rows = '';
        for (const net of byNetwork) {
          const assets = (net.symbols || [])
            .map(function(s) { return formatNumber(s.amount) + ' ' + esc(s.symbol); })
            .join(' · ');
          rows += '<tr><td>' + esc(net.network) + '</td><td class="mono">' + net.chainId + '</td><td>' + formatNumber(net.count) + '</td><td class="mono">' + assets + '</td></tr>';
        }
        html += '<div class="table-title">' + esc(tt('stats.fin.byNetwork')) + '</div>' +
          '<table class="financial-table"><thead><tr><th>' + esc(tt('stats.fin.col.network')) + '</th><th>Chain ID</th><th>' + esc(tt('stats.fin.col.txs')) + '</th><th>' + esc(tt('stats.fin.col.assets')) + '</th></tr></thead><tbody>' + rows + '</tbody></table>';
      }
      const kinds = ((financial && financial.countByKind) || [])
        .map(function(k) { return esc(k.kind) + ': ' + formatNumber(k.count); })
        .join(' · ');
      html += '<p class="updated" style="margin-top:.75rem;">' + esc(tt('stats.fin.total')) + ' <strong>' + formatNumber(financial.totalTransactions) + '</strong>' + (kinds ? ' · ' + kinds : '') + '</p>';
      container.innerHTML = html;
    }

    function renderEscrowDemand(demand) {
      const container = document.getElementById('escrow-demand-content');
      const byNetwork = (demand && demand.byNetwork) || [];
      if (!byNetwork.length) {
        container.innerHTML = '<p class="loading">' + esc(tt('stats.escrow.none')) + '</p>';
        return;
      }
      let rows = '';
      for (const net of byNetwork) {
        rows += '<tr><td>' + esc(net.network) + '</td><td class="mono">' + net.chainId + '</td><td>' + formatNumber(net.count) + '</td></tr>';
      }
      container.innerHTML =
        '<table class="financial-table"><thead><tr><th>' + esc(tt('stats.fin.col.network')) + '</th><th>Chain ID</th><th>' + esc(tt('stats.escrow.col.requests')) + '</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<p class="updated" style="margin-top:.75rem;">' + esc(tt('stats.escrow.total')) + ' <strong>' + formatNumber(demand.totalRequests) + '</strong></p>';
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
