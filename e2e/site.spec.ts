import { test, expect, expectCleanRuntime } from './helpers';

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
    const chatLinks = page.locator('.feature-card a[href="/chat"]');
    expect(await chatLinks.count()).toBe(3);

    // Redes suportadas e Moedas e tokens apontam para /tokens.
    expect(
      await page.locator('.feature-card a[href="/tokens"]').count(),
    ).toBeGreaterThanOrEqual(2);

    // Pagamento garantido -> /escrow; Wallet -> /wallet; Android nativo -> /install.
    await expect(
      page.locator('.feature-card a[href="/escrow"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('.feature-card a[href="/wallet"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('.feature-card a[href="/install"]'),
    ).toHaveCount(1);

    expectCleanRuntime(hygiene);
  });

  test('seção Páginas não repete destinos da seção Recursos', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/');

    // Cards redundantes foram removidos: a grade de páginas só mantém
    // destinos sem card correspondente em Recursos.
    const linksGrid = page.locator('.links-grid');
    for (const href of ['/install', '/escrow', '/tokens', '/chat', '/wallet']) {
      await expect(
        linksGrid.locator(`a[href="${href}"]`),
        `links-grid não deve linkar ${href}`,
      ).toHaveCount(0);
    }

    // Permanecem apenas os destinos não cobertos pelos cards de Recursos.
    await expect(linksGrid.locator('a[href="/stats"]')).toHaveCount(1);
    await expect(linksGrid.locator('a[href="/ajudar"]')).toHaveCount(1);
    expect(
      await linksGrid.locator('a.link-card').count(),
    ).toBe(4);

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
