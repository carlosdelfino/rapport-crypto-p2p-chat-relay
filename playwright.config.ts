import { defineConfig, devices } from '@playwright/test';

/**
 * O relay é um site estático (public/) + functions serverless. Os E2E
 * validam a saída de produção dos assets estáticos servida por
 * scripts/static-server.mjs, que reproduz a semântica de cleanUrls
 * da Vercel. As rotas de API não são exercitadas aqui.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    // Os specs existentes validam conteúdo pt-BR; sem isso o locale padrão
    // (en-US) faria a detecção automática de idioma renderizar em inglês.
    locale: 'pt-BR',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'], channel: 'chrome' },
    },
  ],
  webServer: {
    command: 'node scripts/static-server.mjs',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
