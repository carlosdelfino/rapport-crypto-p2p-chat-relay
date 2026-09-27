import { test, expect, expectCleanRuntime } from './helpers';

test.describe('navegação e metadados do site', () => {
  test('home linka para /tokens a partir de "Moedas e tokens"', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/');

    // Card de feature + card de página apontando para /tokens.
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

  test('sitemap declara /tokens', async ({ page, hygiene }) => {
    const response = await page.goto('/sitemap.xml');
    expect(response?.status()).toBe(200);
    const body = await response!.text();
    expect(body).toContain('<loc>https://crypto-chat.rapport.tec.br/tokens</loc>');

    expectCleanRuntime(hygiene);
  });

  test('rota inexistente retorna 404', async ({ page, hygiene }) => {
    // request API evita o console.error "status of 404" que page.goto geraria.
    const response = await page.request.get('/rota-que-nao-existe');
    expect(response.status()).toBe(404);

    expectCleanRuntime(hygiene);
  });
});
