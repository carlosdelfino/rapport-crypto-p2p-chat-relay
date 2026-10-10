import { test as base, expect, type Page } from '@playwright/test';

/**
 * Domínios externos que as páginas acessam por design (analytics).
 * São interceptados com fulfill() — nenhuma chamada externa real sai do teste.
 */
const ALLOWED_EXTERNAL = new Set(['www.googletagmanager.com']);

export interface Hygiene {
  /** Requisições externas fora da allowlist — deve ser vazio ao final do teste. */
  unexpectedExternal: string[];
  /** console.error capturados na página. */
  consoleErrors: string[];
  /** pageerror (exceções não tratadas) capturados na página. */
  pageErrors: string[];
}

/**
 * Fixture de higiene de runtime: bloqueia todo tráfego http(s) que não seja
 * para o servidor local, registra violações e captura erros de console/página.
 */
export const test = base.extend<{ hygiene: Hygiene }>({
  hygiene: async ({ page }, use) => {
    const hygiene: Hygiene = {
      unexpectedExternal: [],
      consoleErrors: [],
      pageErrors: [],
    };

    await page.route(/^(https?|wss?):\/\//, (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
        return route.continue();
      }
      if (!ALLOWED_EXTERNAL.has(url.hostname)) {
        hygiene.unexpectedExternal.push(url.toString());
      }
      // fulfill (não abort) evita console.error de ERR_FAILED para recursos
      // externos esperados como o script do Google Analytics.
      return route.fulfill({ status: 200, body: '' });
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') hygiene.consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => hygiene.pageErrors.push(err.message));

    await use(hygiene);
  },
});

/**
 * Resposta estável de `/api/stats` para specs que abrem páginas com
 * home-stats.js (a home faz fetch; sem o stub o 404 vira console.error
 * e suja a higiene de runtime).
 */
export async function mockStatsApi(page: Page): Promise<void> {
  await page.route('**/api/stats', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          totalWallets: 0,
          onlineWallets: 0,
          totalMessages: 0,
          totalChats: 0,
          updatedAt: '2026-10-08T00:00:00.000Z',
          financial: {
            volumeBySymbol: [],
            volumeByNetwork: [],
            countByKind: [],
            totalTransactions: 0,
          },
          escrowDemand: { byNetwork: [], totalRequests: 0 },
        },
      }),
    }),
  );
}

export function expectCleanRuntime(hygiene: Hygiene): void {
  expect(
    hygiene.unexpectedExternal,
    `requisições externas não mockadas: ${hygiene.unexpectedExternal.join(', ')}`,
  ).toEqual([]);
  expect(
    hygiene.consoleErrors,
    `console.error: ${hygiene.consoleErrors.join(' | ')}`,
  ).toEqual([]);
  expect(
    hygiene.pageErrors,
    `pageerror: ${hygiene.pageErrors.join(' | ')}`,
  ).toEqual([]);
}

export { expect };
export type { Page };
