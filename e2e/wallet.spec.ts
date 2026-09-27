import { test, expect, expectCleanRuntime } from './helpers';

test.describe('página /wallet', () => {
  test('carrega com SEO completo', async ({ page, hygiene }) => {
    const response = await page.goto('/wallet');
    expect(response?.status()).toBe(200);

    await expect(page).toHaveTitle(/Wallet/);
    await expect(
      page.getByRole('heading', { level: 1, name: /chat que é sua Wallet/i }),
    ).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://crypto-chat.rapport.tec.br/wallet',
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      'content',
      /Wallet/,
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /self-custody/i,
    );

    expectCleanRuntime(hygiene);
  });

  test('explica receber, pagar e pagamento garantido', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/wallet');

    for (const secao of [
      /^Receber$/,
      /^Pagar$/,
      /Pagamento Garantido/,
      /Custódia e segurança/,
    ]) {
      await expect(
        page.getByRole('heading', { name: secao }),
        `seção ${secao}`,
      ).toBeVisible();
    }

    // Comandos documentados na tabela.
    for (const cmd of ['/pay', '/collect', '/balance', '/escrow', '/tokens', '/chain']) {
      await expect(
        page.locator('.cmd-table .cmd-name', { hasText: new RegExp(`^${cmd.replace('/', '\\/')}`) }).first(),
        `comando ${cmd}`,
      ).toBeVisible();
    }

    expectCleanRuntime(hygiene);
  });

  test('interconecta as páginas do site', async ({ page, hygiene }) => {
    await page.goto('/wallet');

    for (const href of ['/escrow', '/tokens', '/chat', '/install']) {
      await expect(
        page.locator(`a[href="${href}"]`).first(),
        `link para ${href}`,
      ).toBeVisible();
    }

    await page.locator('a[href="/escrow"]').first().click();
    await page.waitForURL('**/escrow');
    await expect(
      page.getByRole('heading', { level: 1, name: /Escrow/i }),
    ).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('sem overflow horizontal em viewport estreita', async ({
    page,
    hygiene,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/wallet');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'layout não deve transbordar horizontalmente').toBeLessThanOrEqual(1);

    expectCleanRuntime(hygiene);
  });

  test('estrutura acessível básica', async ({ page, hygiene }) => {
    await page.goto('/wallet');

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
