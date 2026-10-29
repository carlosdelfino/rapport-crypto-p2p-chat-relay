---
trigger: always_on
---
# Playwright E2E Rule

Testes end-to-end com `@playwright/test` no contexto do TanStack Start
(SSR) + Vite deste projeto.

## Setup

- `@playwright/test` é devDependency; browsers via
  `npx playwright install chromium` (gerenciados pelo Playwright em
  `~/.cache/ms-playwright`, fora do git — nunca instalar browsers por apt).
- Nesta máquina o CDN oficial (`cdn.playwright.dev`) pode dar timeout;
  usar o mirror:
  `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install chromium`
- Config: `playwright.config.ts` na raiz.
  - `testDir: "./e2e"` — specs fora de `src/` (o Vitest inclui apenas
    `src/**/*.test.*`, portanto não há colisão; ainda assim use
    `*.spec.ts` para E2E e `*.test.*` para unit).
  - `webServer`: `npm run dev` na porta `8080` (porta definida pelo
    `@lovable.dev/vite-tanstack-config`) com
    `reuseExistingServer: !process.env.CI`. **Não usar `vite preview`** —
    o build de produção sai em `.vercel/output` (preset Nitro), não em
    `dist/`, e o preview falha com `ERR_MODULE_NOT_FOUND`.
  - `use.baseURL` apontando para o servidor local; projetos
    `chromium`/`firefox`/`webkit` conforme necessidade.
- Scripts npm: `test:e2e` (`playwright test`), `test:e2e:ui`
  (`playwright test --ui`), `test:e2e:headed` (`--headed`).

## Escrita de specs

- Seletores por papel/texto (`getByRole`, `getByLabel`, `getByTestId`)
  antes de CSS; adicionar `data-testid` a componentes quando necessário.
- SSR: validar conteúdo presente no HTML inicial (sem hidratação) e o
  comportamento pós-hidratação — os testes Vitest de hydration
  (`*.hydration.test.tsx`) complementam, não substituem, o E2E.
- Autenticação: usar `storageState`/`setup` project para reusar sessão;
  nunca hardcodar credenciais — via `.env.e2e`/`process.env`.
- Rede: interceptar chamadas externas com `page.route` quando o fluxo
  depender de terceiros (OAuth providers, Turnstile — usar chaves de
  teste do Turnstile, não as reais).
- Specs determinísticas: `expect(...).toBeVisible()` com auto-wait do
  Playwright; proibido `waitForTimeout` salvo último recurso justificado.

## Quando rodar

- Fluxos críticos (login/OAuth, feed, comentários, jogos) devem ter spec
  E2E; mudanças nesses fluxos exigem `npm run test:e2e` local antes de
  concluir.
- Em CI, rodar contra build de preview (não dev server).

## MCP Playwright

- O servidor MCP `playwright` pode ser usado para exploração/depuração
  manual (clicar, inspecionar console, screenshots). Achados manuais que
  revelem bug devem virar spec automatizada.
