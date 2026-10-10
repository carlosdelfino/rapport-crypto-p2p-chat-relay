import { test, expect, expectCleanRuntime } from './helpers';

test.describe('página /comandos', () => {
  test('carrega com SEO completo', async ({ page, hygiene }) => {
    const response = await page.goto('/comandos');
    expect(response?.status()).toBe(200);

    await expect(page).toHaveTitle(/Comandos do chat/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Comandos do chat' }),
    ).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://crypto-chat.rapport.tec.br/comandos',
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      'content',
      /Comandos do chat/,
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /comandos/i,
    );

    expectCleanRuntime(hygiene);
  });

  test('documenta todos os comandos com sintaxe e exemplos', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/comandos');

    const blocks = page.locator('.cmd-block');
    expect(await blocks.count()).toBe(11);

    for (const cmd of [
      '/help',
      '/pay',
      '/collect',
      '/balance',
      '/escrow',
      '/invest',
      '/tokens',
      '/coin',
      '/chain',
      '/faucet',
      '/contact',
    ]) {
      await expect(
        page.locator('.cmd-block h3 code', { hasText: cmd }),
        `bloco do comando ${cmd}`,
      ).toBeVisible();
    }

    // Cada bloco tem sintaxe e exemplo(s).
    expect(await page.locator('.cmd-block .syntax').count()).toBe(11);
    expect(await page.locator('.cmd-block .examples').count()).toBe(11);

    expectCleanRuntime(hygiene);
  });

  test('explica os três comportamentos dos comandos', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/comandos');

    await expect(
      page.getByRole('heading', { name: 'Como os comandos funcionam' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Local', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Envio', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Confirmação', exact: true }),
    ).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('convida a enviar sugestões para a carteira de suporte oficial', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/comandos');

    await expect(
      page.getByRole('heading', { name: /Sugestões e dúvidas/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Suporte oficial no Crypto Chat/ }),
    ).toBeVisible();
    await expect(page.locator('#crypto-chat-support')).toContainText(
      '0x7010A4C4c189AB421028a622e2A2e623f432d18e',
    );
    await expect(page.locator('.copy-btn')).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('home tem o CTA do tutorial ao lado de Baixar APK no hero', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/');

    const ctas = page.locator('.hero .actions a');
    expect(await ctas.count()).toBe(2);
    await expect(ctas.nth(0)).toHaveAttribute('href', '/install');
    await expect(ctas.nth(1)).toHaveAttribute('href', '/comandos');

    // A seção de estatísticas também é alcançável pela home.
    await expect(page.locator('a[href="/stats"]').first()).toBeVisible();

    await ctas.nth(1).click();
    await page.waitForURL('**/comandos');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Comandos do chat' }),
    ).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('sem overflow horizontal em viewport estreita', async ({
    page,
    hygiene,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/comandos');

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
    await page.goto('/comandos');

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
