import { test, expect, expectCleanRuntime } from './helpers';

test.describe('página /invest', () => {
  test('carrega com SEO completo', async ({ page, hygiene }) => {
    const response = await page.goto('/invest');
    expect(response?.status()).toBe(200);

    await expect(page).toHaveTitle(/Investimentos|Investments|Inversiones|Investissements|الاستثمارات/);
    await expect(
      page.getByRole('heading', { level: 1, name: /Investimentos|Investments|Inversiones|Investissements|الاستثمارات/ }),
    ).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://crypto-chat.rapport.tec.br/invest',
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      'content',
      /Investimentos|Investments|Inversiones|Investissements|الاستثمارات/,
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /invest|DeFi|RWA/i,
    );

    expectCleanRuntime(hygiene);
  });

  test('apresenta operadoras e links oficiais', async ({ page, hygiene }) => {
    await page.goto('/invest');

    for (const operator of ['Aave', 'Morpho', 'Ondo', 'xStocks']) {
      await expect(
        page.getByRole('heading', { name: new RegExp(operator), level: 3 }),
        `operadora ${operator}`,
      ).toBeVisible();
    }

    for (const domain of ['aave.com', 'morpho.org', 'ondo.finance', 'xstocks.fi']) {
      await expect(
        page.locator(`a[href*="${domain}"][rel="noopener"]`).first(),
        `link para ${domain}`,
      ).toBeVisible();
    }

    expectCleanRuntime(hygiene);
  });

  test('explica os cinco níveis do comando /invest', async ({ page, hygiene }) => {
    await page.goto('/invest');

    await expect(page.locator('code.cmd', { hasText: '/invest' }).first()).toBeVisible();
    await expect(page.locator('code.cmd', { hasText: '/invest aave' }).first()).toBeVisible();
    await expect(page.locator('code.cmd', { hasText: '/invest aave aUSDC 100, base' }).first()).toBeVisible();
    await expect(page.locator('code.cmd', { hasText: '/invest redeem aave USDC 50, base' }).first()).toBeVisible();
    await expect(page.locator('code.cmd', { hasText: '/invest balance aave USDC' }).first()).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('documenta o chat do contrato e comandos resumidos', async ({ page, hygiene }) => {
    await page.goto('/invest');

    await expect(page.getByRole('heading', { name: /contrato|contract|contrat|العقد/ })).toBeVisible();
    await expect(page.locator('code.cmd', { hasText: '/invest 100' }).first()).toBeVisible();
    await expect(page.locator('code.cmd', { hasText: '/invest resgatar 50' }).first()).toBeVisible();
    await expect(page.locator('code.cmd', { hasText: '/invest saldo' }).first()).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('interconecta com home e install', async ({ page, hygiene }) => {
    await page.goto('/invest');

    await expect(page.locator('a[href="/install"]').first()).toBeVisible();
    await expect(page.locator('a[href="/"]').first()).toBeVisible();

    await page.locator('a[href="/install"]').first().click();
    await page.waitForURL('**/install');
    await expect(page).toHaveTitle(/Instalar|Install|Instalar|Télécharger|تثبيت/);

    expectCleanRuntime(hygiene);
  });

  test('sem overflow horizontal em viewport estreita', async ({ page, hygiene }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/invest');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'layout não deve transbordar horizontalmente').toBeLessThanOrEqual(1);

    expectCleanRuntime(hygiene);
  });

  test('estrutura acessível básica', async ({ page, hygiene }) => {
    await page.goto('/invest');

    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    expect(await page.locator('h1').count()).toBe(1);
    for (const link of await page.locator('a').all()) {
      const name =
        (await link.innerText()).trim() ||
        (await link.getAttribute('aria-label')) ||
        '';
      expect(
        name.length,
        `link ${await link.getAttribute('href')} sem nome`,
      ).toBeGreaterThan(0);
    }

    expectCleanRuntime(hygiene);
  });
});
