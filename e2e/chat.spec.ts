import { test, expect, expectCleanRuntime } from './helpers';

test.describe('página /chat', () => {
  test('carrega com SEO completo', async ({ page, hygiene }) => {
    const response = await page.goto('/chat');
    expect(response?.status()).toBe(200);

    await expect(page).toHaveTitle(/Como o dApp funciona/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Como o dApp funciona' }),
    ).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://crypto-chat.rapport.tec.br/chat',
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      'content',
      /Como o dApp funciona/,
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /criptografia ponta a ponta/i,
    );

    expectCleanRuntime(hygiene);
  });

  test('explica o fluxo de ponta a ponta do dApp', async ({ page, hygiene }) => {
    await page.goto('/chat');

    // Timeline com o fluxo completo: identidade, presença, convite, sessão,
    // cifra e persistência local.
    const steps = page.locator('.steps .step');
    expect(await steps.count()).toBe(6);

    for (const termo of [
      'BIP39',
      'relay',
      'chat_request',
      'X25519',
      'ChaCha20-Poly1305',
      'SQLite',
    ]) {
      await expect(
        page.locator('.steps', { hasText: termo }),
        `fluxo menciona ${termo}`,
      ).toBeVisible();
    }

    expectCleanRuntime(hygiene);
  });

  test('destaca segurança e o papel limitado do relay', async ({
    page,
    hygiene,
  }) => {
    await page.goto('/chat');

    await expect(
      page.getByRole('heading', { name: /O que o relay faz/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Segurança em camadas/ }),
    ).toBeVisible();

    // A tabela deixa explícito que o relay não lê mensagens.
    await expect(
      page.locator('.relay-table', { hasText: /nunca.*conteúdo|mensagens de chat legíveis/i }),
    ).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('interconecta as páginas do site', async ({ page, hygiene }) => {
    await page.goto('/chat');

    for (const href of ['/wallet', '/escrow', '/tokens', '/install']) {
      await expect(
        page.locator(`a[href="${href}"]`).first(),
        `link para ${href}`,
      ).toBeVisible();
    }

    await page.locator('a[href="/wallet"]').first().click();
    await page.waitForURL('**/wallet');
    await expect(
      page.getByRole('heading', { level: 1, name: /Wallet/i }),
    ).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('sem overflow horizontal em viewport estreita', async ({
    page,
    hygiene,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/chat');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'layout não deve transbordar horizontalmente').toBeLessThanOrEqual(1);

    expectCleanRuntime(hygiene);
  });

  test('estrutura acessível básica', async ({ page, hygiene }) => {
    await page.goto('/chat');

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
