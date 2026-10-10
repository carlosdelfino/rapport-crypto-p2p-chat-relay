import { test, expect, expectCleanRuntime } from './helpers';

/**
 * i18n — detecção automática, seletor de idiomas e persistência.
 *
 * O config fixa `locale: 'pt-BR'` para os demais specs; aqui cada bloco
 * sobrescreve o locale quando precisa simular outro navegador.
 */
test.describe('i18n — detecção e seletor de idioma', () => {
  test('navegador pt-BR renderiza português e exibe a barra de bandeiras', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    const flags = page.locator('.lang-bar .lang-btn');
    await expect(flags).toHaveCount(5);
    await expect(page.locator('.lang-btn[data-lang="pt-BR"]')).toHaveClass(
      /active/,
    );
    await expect(
      page.getByText('Sem cadastro. Sem rastreamento.', { exact: false }),
    ).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test.describe('locale sem suporte', () => {
    test.use({ locale: 'de-DE' });

    test('cai no fallback inglês', async ({ page, hygiene }) => {
      await page.goto('/');

      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(
        page.getByText('Protected, direct person-to-person chat', {
          exact: false,
        }),
      ).toBeVisible();
      await expect(page.locator('.lang-btn[data-lang="en"]')).toHaveClass(
        /active/,
      );

      expectCleanRuntime(hygiene);
    });
  });

  test.describe('locale espanhol', () => {
    test.use({ locale: 'es-ES' });

    test('detecta espanhol automaticamente', async ({ page, hygiene }) => {
      await page.goto('/');

      await expect(page.locator('html')).toHaveAttribute('lang', 'es');
      await expect(
        page.getByText('Chat protegido y directo entre personas', {
          exact: false,
        }),
      ).toBeVisible();

      expectCleanRuntime(hygiene);
    });
  });

  test('parâmetro ?lang= sobrescreve a detecção e persiste na navegação', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/?lang=fr');

    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(
      page.getByText('Chat protégé et direct entre personnes', {
        exact: false,
      }),
    ).toBeVisible();

    // Persistência: navegar sem ?lang deve manter francês.
    await page.goto('/wallet');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Le chat qui est votre Wallet',
      }),
    ).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('troca manual pela bandeira aplica sem reload e persiste', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/');

    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(
      page.getByText('Protected, direct person-to-person chat', {
        exact: false,
      }),
    ).toBeVisible();

    // Recarregar deve manter inglês (localStorage).
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(
      page.getByText('Protected, direct person-to-person chat', {
        exact: false,
      }),
    ).toBeVisible();

    // Voltar ao português restaura o conteúdo original do snapshot.
    await page.locator('.lang-btn[data-lang="pt-BR"]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    await expect(
      page.getByText('Sem cadastro. Sem rastreamento.', { exact: false }),
    ).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('árabe aplica dir=rtl e conteúdo traduzido', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/?lang=ar');

    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByText('دردشة محمية ومباشرة بين الأشخاص', { exact: false }),
    ).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('página /install gerada também é traduzida', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/install?lang=en');

    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Install Rapport Crypto P2P Chat',
      }),
    ).toBeVisible();
    await expect(page.getByText('Available versions')).toBeVisible();
    await expect(page.locator('.apk-download').first()).toHaveText('Download');
    await expect(
      page.locator('[data-i18n-html="common.footer"]'),
    ).toContainText('Rapport');

    expectCleanRuntime(hygiene);
  });
});

test.describe('i18n — conteúdo dinâmico', () => {
  test('/stats traduz cards e datas em inglês', async ({ page, hygiene }) => {
    await page.route('**/api/stats', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            totalWallets: 42,
            onlineWallets: 3,
            totalMessages: 1200,
            totalChats: 7,
            updatedAt: '2026-09-28T12:00:00.000Z',
            financial: {
              volumeBySymbol: [
                { symbol: 'POL', count: 5, amount: 123.4 },
              ],
              volumeByNetwork: [
                {
                  network: 'Polygon PoS',
                  chainId: 137,
                  count: 5,
                  symbols: [{ symbol: 'POL', amount: 123.4 }],
                },
              ],
              countByKind: [{ kind: 'payment', count: 5 }],
              totalTransactions: 5,
            },
            escrowDemand: {
              byNetwork: [{ network: 'Solana', chainId: 0, count: 2 }],
              totalRequests: 2,
            },
          },
        }),
      }),
    );

    await page.goto('/stats?lang=en');

    await expect(page.getByText('Registered wallets')).toBeVisible();
    await expect(page.getByText('Online now')).toBeVisible();
    await expect(page.getByText('Updated at:', { exact: false })).toBeVisible();
    await expect(page.getByText('By asset')).toBeVisible();
    await expect(page.getByText('By network')).toBeVisible();
    await expect(
      page.getByText('Total requests:', { exact: false }),
    ).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('/escrow traduz a lista de redes do manifest', async ({
    page,
    hygiene,
  }) => {
    await page.route('**/escrow/contracts.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          networks: [
            {
              name: 'Polygon PoS',
              chainId: 137,
              isTestnet: false,
              escrow: '0x1234567890abcdef1234567890abcdef12345678',
              explorer: 'https://polygonscan.com',
            },
          ],
        }),
      }),
    );

    await page.goto('/escrow?lang=en');

    await expect(
      page.getByText('Deployed EscrowVault contracts', { exact: false }),
    ).toBeVisible();
    await expect(page.getByText('view on explorer', { exact: false })).toBeVisible();
    await expect(
      page.locator('.net-kind', { hasText: 'mainnet' }),
    ).toBeVisible();

    expectCleanRuntime(hygiene);
  });
});
