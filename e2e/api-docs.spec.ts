import { test, expect } from '@playwright/test';

for (const viewer of ['swagger', 'redoc']) {
  test(`RF-RELAY-09 ${viewer} exposes a readable contract even when CDN is unavailable`, async ({ page }) => {
    await page.route(/^https?:\/\//, (route) => {
      const host = new URL(route.request().url()).hostname;
      return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort();
    });
    await page.goto(`/${viewer}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Relay API — ${viewer === 'swagger' ? 'Swagger' : 'ReDoc'}`);
    await expect(page.getByRole('main')).toContainText('Consulte o link OpenAPI JSON');
    await page.getByRole('link', { name: 'OpenAPI JSON' }).click();
    await page.waitForURL('**/openapi.json');
    await expect(page.locator('body')).toContainText('retry_after_ms');
    await expect(page.locator('body')).toContainText('onramp-session');
  });
}

test('RF-RELAY-09 OpenAPI is served as JSON without making API requests', async ({ request }) => {
  const response = await request.get('/openapi.json');
  expect(response.ok()).toBe(true);
  const specification = await response.json();
  expect(specification.openapi).toBe('3.0.3');
  expect(specification.paths['/api/signal'].post.responses['429']).toBeTruthy();
  expect(specification.components.schemas.OnrampInput.properties.assets.properties.tokens.maxItems).toBe(16);
});
