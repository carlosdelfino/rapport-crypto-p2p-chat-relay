import { test, expect, expectCleanRuntime } from './helpers';

test.describe('página /tokens', () => {
  test('carrega com SEO e estrutura de catálogo', async ({ page, hygiene }) => {
    const response = await page.goto('/tokens');
    expect(response?.status()).toBe(200);

    await expect(page).toHaveTitle(/Moedas e tokens/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Moedas e tokens' }),
    ).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://crypto-chat.rapport.tec.br/tokens',
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      'content',
      /Moedas e tokens/,
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /stablecoin/i,
    );

    expectCleanRuntime(hygiene);
  });

  test('lista as redes mainnet suportadas', async ({ page, hygiene }) => {
    await page.goto('/tokens');

    const mainnets = [
      'Ethereum Mainnet',
      'Polygon PoS',
      'Base Mainnet',
      'OP Mainnet',
      'Arbitrum One',
      'Linea Mainnet',
      'Monad Mainnet',
      'BNB Smart Chain',
      'XDC Network',
      'Arc',
      'HAQQ Mainnet',
      'Bitcoin Mainnet',
      'KleverChain',
    ];
    for (const name of mainnets) {
      await expect(
        page.locator('.net-name', { hasText: name }),
        `rede ${name}`,
      ).toBeVisible();
    }

    // Todas devem estar marcadas como mainnet.
    expect(await page.locator('.net-kind.mainnet').count()).toBe(
      mainnets.length,
    );

    expectCleanRuntime(hygiene);
  });

  test('descreve o contexto de uso de cada ativo', async ({ page, hygiene }) => {
    await page.goto('/tokens');

    // Categorias presentes na legenda.
    for (const label of [
      'Stablecoin',
      'Moeda nativa',
      'Wrapped / bridged',
      'Staking',
      'Utilitário / governança',
      'Projeto / comunidade',
      'RWA (ativo real)',
    ]) {
      await expect(page.locator('.legend .chip', { hasText: label })).toBeVisible();
    }

    // Ativos representativos de cada família/rede.
    for (const sym of [
      'ISLM',
      'WISLM',
      'stISLM',
      'axlUSDC',
      'DEEN',
      'BTC',
      'KLV',
      'KFI',
      'USDT0',
      'BUSD',
      'CAKE',
      'EURC',
      'USYC',
      'CCZ',
      'CAS',
      'BRLA',
      'PYUSD',
    ]) {
      await expect(
        page.locator('.asset-table .sym', { hasText: new RegExp(`^${sym}$`) }).first(),
        `símbolo ${sym}`,
      ).toBeVisible();
    }

    // Toda linha de ativo tem categoria (chip) e descrição de uso preenchida.
    const rows = page.locator('.asset-table tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(40);
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      await expect(row.locator('.cat .chip').first()).toBeVisible();
      expect((await row.locator('.use').innerText()).trim().length).toBeGreaterThan(10);
    }

    expectCleanRuntime(hygiene);
  });

  test('orienta uso correto: stablecoins vs ativos voláteis', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/tokens');

    await expect(
      page.getByText(/para pagamentos, prefira.*stablecoins/i),
    ).toBeVisible();
    // Testnets declaradas como sem valor real.
    await expect(page.getByText(/sem valor real/i)).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('sem overflow horizontal em viewport estreita', async ({
    page,
    hygiene,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/tokens');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'layout não deve transbordar horizontalmente').toBeLessThanOrEqual(1);

    expectCleanRuntime(hygiene);
  });

  test('estrutura acessível básica', async ({ page, hygiene }) => {
    await page.goto('/tokens');

    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    // Exatamente um h1.
    expect(await page.locator('h1').count()).toBe(1);
    // Links com texto discernível.
    for (const link of await page.locator('a').all()) {
      const name = (await link.innerText()).trim() || (await link.getAttribute('aria-label')) || '';
      expect(name.length, `link ${await link.getAttribute('href')} sem nome`).toBeGreaterThan(0);
    }

    expectCleanRuntime(hygiene);
  });
});
