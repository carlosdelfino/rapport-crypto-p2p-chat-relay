import { test, expect, expectCleanRuntime } from './helpers';

test.describe('página /termes — política de uso', () => {
  test('carrega com SEO completo', async ({ page, hygiene }) => {
    const response = await page.goto('/termes');
    expect(response?.status()).toBe(200);

    await expect(page).toHaveTitle(/Política de uso/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Política de uso do Crypto Chat' }),
    ).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://crypto-chat.rapport.tec.br/termes',
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /terrorismo|bullying/i,
    );

    expectCleanRuntime(hygiene);
  });

  test('documenta usos proibidos, banimento e responsabilidades', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/termes');

    for (const heading of [
      'Usos proibidos',
      'Banimento por política de uso',
      'Ordens judiciais',
      'Notificação do banimento',
      'Isenção de responsabilidade',
      'Autocustódia e backup',
      'Jurisdições',
    ]) {
      await expect(
        page.getByRole('heading', { name: heading }),
      ).toBeVisible();
    }

    // Usos proibidos nomeados no corpo do texto.
    await expect(page.locator('.article-body')).toContainText('terrorismo');
    await expect(page.locator('.article-body')).toContainText('bullying');
    await expect(page.locator('.article-body')).toContainText(
      'lavagem de dinheiro',
    );

    // Comandos exclusivos da carteira de suporte.
    await expect(page.locator('.article-body')).toContainText('/ban pol');
    await expect(page.locator('.article-body')).toContainText('/ban pol jur');

    // Carteira de suporte visível e linkada.
    const support = page.locator('a[data-addr]').first();
    await expect(support).toContainText(
      '0x7010A4C4c189AB421028a622e2A2e623f432d18e',
    );
    await expect(support).toHaveAttribute(
      'href',
      'https://polygonscan.com/address/0x7010A4C4c189AB421028a622e2A2e623f432d18e',
    );

    expectCleanRuntime(hygiene);
  });

  test('footer de todas as páginas linka para /termes', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/');

    const link = page.locator('.footer-links a[href="/termes"]');
    await expect(link).toBeVisible();

    await link.click();
    await page.waitForURL('**/termes');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Política de uso do Crypto Chat' }),
    ).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('?lang=en aplica a tradução do dicionário', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/termes?lang=en');

    await expect(page).toHaveTitle(/Usage policy/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Crypto Chat usage policy' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Prohibited uses' }),
    ).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('sem overflow horizontal em viewport estreita', async ({
    page,
    hygiene,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/termes');

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(
      overflow,
      'layout não deve transbordar horizontalmente',
    ).toBeLessThanOrEqual(1);

    expectCleanRuntime(hygiene);
  });

  test('estrutura acessível básica', async ({ page, hygiene }) => {
    await page.goto('/termes');

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
