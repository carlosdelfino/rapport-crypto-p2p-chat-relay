import { test, expect, expectCleanRuntime, mockStatsApi } from './helpers';

test.describe('navegação e metadados do site', () => {
  test('home linka para /tokens a partir de "Moedas e tokens"', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/');

    // Cards de feature apontando para /tokens (Redes suportadas + Moedas e tokens).
    const links = page.locator('a[href="/tokens"]');
    expect(await links.count()).toBeGreaterThanOrEqual(2);

    await page
      .getByRole('link', { name: /Ver catálogo completo/i })
      .click();
    await page.waitForURL('**/tokens');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Moedas e tokens' }),
    ).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('cards de Recursos levam às páginas de detalhe', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/');

    // Os três cards de arquitetura apontam para /chat.
    const chatLinks = page.locator('a.card-link[href="/chat"]');
    expect(await chatLinks.count()).toBe(3);

    // Redes suportadas e Moedas e tokens apontam para /tokens.
    expect(
      await page.locator('a.card-link[href="/tokens"]').count(),
    ).toBeGreaterThanOrEqual(2);

    // Pagamento garantido -> /escrow; Wallet -> /wallet; Android nativo -> /install.
    await expect(
      page.locator('a.card-link[href="/escrow"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('a.card-link[href="/wallet"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('a.card-link[href="/install"]'),
    ).toHaveCount(1);

    expectCleanRuntime(hygiene);
  });

  test('seção Páginas não repete destinos da seção Recursos', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/');

    // Cards redundantes foram removidos: a grade de recursos só mantém
    // destinos sem card correspondente em Recursos.
    const resources = page.locator('.resources');
    for (const href of ['/install', '/escrow', '/tokens', '/chat', '/wallet', '/stats', '/comandos']) {
      await expect(
        resources.locator(`a[href="${href}"]`),
        `resources não deve linkar ${href}`,
      ).toHaveCount(0);
    }

    // Permanecem apenas os destinos não cobertos pelos cards de Recursos.
    await expect(resources.locator('a[href="/ajudar"]')).toHaveCount(1);
    await expect(
      resources.locator(
        'a[href="https://github.com/carlosdelfino/rapport-crypto-p2p-chat"]',
      ),
    ).toHaveCount(1);
    expect(await resources.locator('a').count()).toBe(2);

    expectCleanRuntime(hygiene);
  });

  test('REQ-RELAY-CONTACT-01 exibe contatos seguros em todas as páginas públicas', async ({
    page,
    hygiene,
  }) => {
    test.setTimeout(60_000);
    await page.route('**/api/stats', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            totalWallets: 0,
            onlineWallets: 0,
            totalMessages: 0,
            totalChats: 0,
            updatedAt: '2026-10-08T00:00:00.000Z',
            financial: { volumeBySymbol: [], volumeByNetwork: [], countByKind: [], totalTransactions: 0 },
            escrowDemand: { byNetwork: [], totalRequests: 0 },
          },
        }),
      }),
    );

    for (const route of ['/', '/install', '/stats', '/ajudar', '/escrow', '/tokens', '/chat', '/wallet', '/invest']) {
      await page.goto(route);
      const footer = page.locator('.site-footer');
      await expect(footer, `rodapé de ${route}`).toBeVisible();
      await expect(footer.locator('a[href="/suporte"]')).toHaveCount(1);
      await expect(
        footer.locator('[data-i18n-html="common.footer"]'),
      ).toBeVisible();
      await expect(
        footer.locator('[data-i18n-html="common.footer"] a[href="https://rapport.tec.br"]'),
      ).toHaveText('Rapport Tecnologia e Inovação');

      // Links externos do rodapé abrem em nova aba com rel seguro.
      const socials = footer.locator('.socials a');
      expect(await socials.count()).toBeGreaterThanOrEqual(2);
      for (const social of await socials.all()) {
        await expect(social).toHaveAttribute('target', '_blank');
        await expect(social).toHaveAttribute('rel', 'noopener noreferrer');
      }
    }

    // Contatos diretos ficam nas páginas de suporte e ajuda.
    await page.goto('/suporte');
    const whatsapp = page.locator('a[href="https://wa.me/5585985205490"]');
    await expect(whatsapp).toBeVisible();
    await expect(whatsapp).toHaveAttribute('target', '_blank');
    await expect(whatsapp).toHaveAttribute('rel', 'noopener noreferrer');

    await page.goto('/ajudar');
    await expect(page.locator('#crypto-chat-support')).toContainText(
      '0x7010A4C4c189AB421028a622e2A2e623f432d18e',
    );

    expectCleanRuntime(hygiene);
  });

  test('REQ-RELAY-CONTACT-01 mantém rodapés responsivos em viewport móvel', async ({
    page,
    hygiene,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.route('**/api/stats', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            totalWallets: 0,
            onlineWallets: 0,
            totalMessages: 0,
            totalChats: 0,
            updatedAt: '2026-10-08T00:00:00.000Z',
            financial: { volumeBySymbol: [], volumeByNetwork: [], countByKind: [], totalTransactions: 0 },
            escrowDemand: { byNetwork: [], totalRequests: 0 },
          },
        }),
      }),
    );

    for (const route of ['/', '/install', '/stats', '/ajudar', '/escrow', '/tokens', '/chat', '/wallet', '/invest']) {
      await page.goto(route);
      const footer = page.locator('.site-footer');
      const overflow = await footer.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      );
      expect(overflow, `rodapé de ${route} não deve transbordar`).toBeLessThanOrEqual(1);
    }

    expectCleanRuntime(hygiene);
  });

  test('sitemap declara /tokens, /chat, /wallet e /ajudar', async ({
    page,
    hygiene,
  }) => {
    const response = await page.goto('/sitemap.xml');
    expect(response?.status()).toBe(200);
    const body = await response!.text();
    expect(body).toContain('<loc>https://crypto-chat.rapport.tec.br/tokens</loc>');
    expect(body).toContain('<loc>https://crypto-chat.rapport.tec.br/chat</loc>');
    expect(body).toContain('<loc>https://crypto-chat.rapport.tec.br/wallet</loc>');
    expect(body).toContain('<loc>https://crypto-chat.rapport.tec.br/ajudar</loc>');

    expectCleanRuntime(hygiene);
  });

  test('rota inexistente retorna 404', async ({ page, hygiene }) => {
    // request API evita o console.error "status of 404" que page.goto geraria.
    const response = await page.request.get('/rota-que-nao-existe');
    expect(response.status()).toBe(404);

    expectCleanRuntime(hygiene);
  });
});
