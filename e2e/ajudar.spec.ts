import { test, expect, expectCleanRuntime } from './helpers';

test.describe('página /ajudar', () => {
  test('carrega com SEO completo', async ({ page, hygiene }) => {
    const response = await page.goto('/ajudar');
    expect(response?.status()).toBe(200);

    await expect(page).toHaveTitle(/Como Ajudar/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Como Ajudar' }),
    ).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://crypto-chat.rapport.tec.br/ajudar',
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      'content',
      /Como Ajudar/,
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /ajudar/i,
    );

    expectCleanRuntime(hygiene);
  });

  test('destaca que a melhor forma de ajudar é usar o app', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/ajudar');

    await expect(
      page.locator('main', { hasText: /melhor forma de ajudar/i }),
    ).toBeVisible();
    await expect(page.locator('a[href="/install"]').first()).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('REQ-RELAY-CONTACT-01 lista carteiras da gestão e suporte oficial', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/ajudar#crypto-chat-support');

    await expect(
      page.getByRole('heading', { name: /Doações/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', {
        name: /Carteiras da gestão dos projetos Rapport/,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Suporte oficial no Crypto Chat/ }),
    ).toBeVisible();
    await expect(page.locator('#crypto-chat-support')).toContainText(
      '0x7010A4C4c189AB421028a622e2A2e623f432d18e',
    );

    const addrs = page.locator('.donation-addr');
    expect(await addrs.count()).toBe(4);

    for (const addr of [
      '0x66682BBeD9e540017967692cCdd069fE5F833888',
      'bc1qs89ud4zdafk3u2f7qzcghhlzhrh27d849kcz9h',
      'ovBzDFqPqJUuQrRUvy7FXsJX5FaJH4ta4DaGkyaCXZY',
      '0x7010A4C4c189AB421028a622e2A2e623f432d18e',
    ]) {
      await expect(
        page.locator(`.donation-addr[data-addr="${addr}"]`),
        `carteira ${addr}`,
      ).toBeVisible();
    }

    // Cada carteira tem botão de copiar.
    expect(await page.locator('.copy-btn').count()).toBe(4);

    expectCleanRuntime(hygiene);
  });

  test('home linka para /ajudar pelo card Como Ajudar', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/');

    const card = page.locator('.resources a[href="/ajudar"]');
    await expect(card).toBeVisible();
    await card.click();
    await page.waitForURL('**/ajudar');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Como Ajudar' }),
    ).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('/stats não exibe mais a seção Doações e linka para /ajudar', async ({
    page,
    hygiene,
  }) => {
    await page.route('**/api/stats', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 200,
          message: 'ok',
          next_step: 'render',
          data: {
            totalWallets: 0,
            onlineWallets: 0,
            totalMessages: 0,
            totalChats: 0,
            updatedAt: new Date().toISOString(),
          },
        }),
      }),
    );

    await page.goto('/stats');

    expect(await page.locator('.donation-addr').count()).toBe(0);
    await expect(
      page.getByRole('heading', { name: /Doações/ }),
    ).toHaveCount(0);
    await expect(page.locator('a[href="/ajudar"]')).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('sem overflow horizontal em viewport estreita', async ({
    page,
    hygiene,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/ajudar');

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
    await page.goto('/ajudar');

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
