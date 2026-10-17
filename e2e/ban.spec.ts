import { test, expect, expectCleanRuntime } from './helpers';

test.describe('página /ban', () => {
  test('carrega com SEO completo', async ({ page, hygiene }) => {
    const response = await page.goto('/ban');
    expect(response?.status()).toBe(200);

    await expect(page).toHaveTitle(/[Bb]an/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Votações de banimento' }),
    ).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://crypto-chat.rapport.tec.br/ban',
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /ban/i,
    );

    expectCleanRuntime(hygiene);
  });

  test('explica o fluxo do pedido à execução', async ({ page, hygiene }) => {
    await page.goto('/ban');

    await expect(
      page.getByRole('heading', { name: 'Como funciona' }),
    ).toBeVisible();
    for (const step of ['Pedido', 'Aceite', 'Votação', 'Resultado']) {
      await expect(
        page.getByRole('heading', { name: step, exact: true }),
      ).toBeVisible();
    }

    expectCleanRuntime(hygiene);
  });

  test('lista de votações mostra estado vazio sem API e menciona CAS', async ({
    page,
    hygiene,
  }) => {
    // O servidor de testes é estático: /api/ban não responde e a página
    // deve degradar para o estado "indisponível" sem erros de runtime.
    await page.goto('/ban');

    await expect(
      page.getByRole('heading', { name: 'Votações em aberto' }),
    ).toBeVisible();
    await expect(page.locator('#ban-grid .vote-empty')).toBeVisible();
    await expect(page.locator('#ban-grid .vote-empty')).toContainText(
      /Carregando|indisponíveis|Nenhuma/i,
    );
    await expect(
      page.locator('.tagline, .subtagline', { hasText: /CAS/ }).first(),
    ).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('renderiza votações com deep link rapportchat:// quando a API responde', async ({
    page,
    hygiene,
  }) => {
    const target = '0x00000000000000000000000000000000000000Aa';
    await page.route('**/api/ban', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 200,
          message: 'ok',
          data: {
            enabled: true,
            daoAddress: '0x5151A34EaC7bA08cd6B540b32cD30316218A2287',
            proposals: [
              {
                proposalId: '0',
                requester: '0x00000000000000000000000000000000000000Bb',
                target,
                reasonHash: '0x' + '0'.repeat(64),
                createdAt: Math.floor(Date.now() / 1000) - 3600,
                votingDeadline: Math.floor(Date.now() / 1000) + 3600,
                forWeight: '1000000',
                againstWeight: '0',
                state: 1,
              },
            ],
          },
        }),
      }),
    );
    await page.goto('/ban');

    const link = page.locator(`.vote-target a[href="rapportchat://chat/${target}"]`);
    await expect(link).toBeVisible();
    await expect(link).toContainText(target);
    await expect(page.locator('.vote-cta')).toHaveAttribute(
      'href',
      `rapportchat://chat/${target}`,
    );

    expectCleanRuntime(hygiene);
  });

  test('página /comandos documenta o /ban', async ({ page, hygiene }) => {
    await page.goto('/comandos');

    await expect(
      page.locator('.cmd-block h3 code', { hasText: '/ban' }),
    ).toBeVisible();
    await expect(page.locator('a[href="/ban"]').first()).toBeVisible();

    expectCleanRuntime(hygiene);
  });

  test('sem overflow horizontal em viewport estreita', async ({
    page,
    hygiene,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/ban');

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
});
