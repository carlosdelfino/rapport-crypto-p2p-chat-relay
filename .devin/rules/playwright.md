---
trigger: always_on
---
# Playwright E2E Rule

Every frontend application in this monorepo  must be validated with
end-to-end tests via [Playwright](https://playwright.dev) before being
considered done.

This rule complements `unit-tests.md`, `pdcl.md` and `builds-deploy.md`:
E2E tests are part of the "frontend: tests (if any) + static build" step.

## 1. Mandatory setup

- Per-module dependency (monorepo with no root `package.json` — see
  `builds-deploy.md`): `@playwright/test` in `devDependencies`.
- Configuration in `playwright.config.ts`; tests under
  `e2e/` (`*.spec.ts` files).
- Minimum npm scripts in the module's `package.json`:

  ```json
  {
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:headed": "playwright test --headed"
  }
  ```

- `webServer` in `playwright.config.ts` must boot the app the way it is
  served in production: `vite preview` over `dist/` or the backend serving
  `backend/public` (the SPA is distributed as an onion service — see
  `docs/tor-deployment.md`). Never test against `vite dev` in CI, since
  HMR masks build errors.
- Node.js >= 20 for the runner (the repo already uses `engines.node >= 22`
  in the frontend; Playwright requires >= 20).
- Browsers: `chromium` is the mandatory project; add `webkit` and a
  mobile (`Pixel`-like) project when mobile usage becomes relevant.
- Artifacts (`playwright-report/`, `test-results/`) belong in the
  module's `.gitignore`.

## 2. Most important tests (per-flow checklist)

Priority order — cover first the flows that move funds or on-chain
state, then UX and visual regression.

### 2.1 Entry gate and session (critical)

- With no wallet connected, the app renders **only** the `TermsPage`
  (`App.tsx` early-returns before mounting the shell).
- Accepting the terms + connecting a (mocked) wallet unlocks the
  header/nav and shows the truncated address (`0x1234…abcd`).
- Reloading the page must not leave the app in a broken state when the
  mocked wallet is already "connected" (storage state).

### 2.2 API error contract (critical — see `api.md`)

- Intercept calls with `page.route()` and assert that every error
  response renders `code`, `message`, `details` and `next_step` — never
  a stack trace, raw payload or blank screen.
- 401/403 → the app guides the correct action (re-authenticate /
  connect wallet).
- 5xx and timeout → safe message + retry option; the app must not hang
  on an eternal spinner.


### 2.9 Theme, accessibility and responsive

- Dark theme is the default and uses the palette tokens (`paleta.md`):
  `--color-bg-main: #222222`, `--color-primary: #F05F40`. Assert with
  `getComputedStyle`.
- Accessibility scan with `@axe-core/playwright` on the main pages:
  zero `critical`/`serious` violations; input labels, visible focus,
  contrast >= 4.5:1 for text.
- Viewports: desktop 1280x720 and mobile ~390x844 — nav must not break,
  tables scroll or stack.
- Visual regression: `toHaveScreenshot()` on stable pages (baselines
  versioned per browser/OS).

### 2.10 Runtime hygiene

- Zero `console.error` and zero failed unmocked requests during
  happy-path flows (assert via `page.on('console')` /
  `page.on('pageerror')`).
- No calls to unmocked external domains (defense against data leakage
  and flakiness — and coherent with the onion/Tor threat model).

## 3. Mandatory best practices

- **Resilient locators**: prefer `getByRole`/`getByLabel` and
  `data-testid` (the default `testIdAttribute` is `data-testid`).
  Depending on generated CSS classes, fragile partial text or long XPath
  is forbidden.
- **No `waitForTimeout`**: use Playwright auto-waiting
  (`expect(locator).toBeVisible()`, `waitForResponse`, `waitForURL`).
  A fixed timeout is a sign of a flaky test.
- **Isolation**: each `test` is independent; shared state goes through
  `storageState` or declared fixtures, never through execution order.
- **Network mocking**: `page.route()`/`route.fulfill()` for every API
  and RPC call; keep JSON fixtures in `frontend/e2e/fixtures/`.
- **Configuration**: `fullyParallel: true`, `retries: 2` only in CI,
  `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`,
  `video: 'retain-on-failure'`.
- **Secrets**: no private key, mnemonic or token in specs, fixtures or
  artifacts (trace/video may record the screen — review before attaching
  to a PR).
- **Data**: use deterministic testnet accounts and contracts; never
  mainnet.

## 4. Pipeline integration and PDCL

- runs `npm run test:e2e` in the frontend step
  when `e2e/` exists; E2E failure blocks the static build (same
  criterion as contract audits).
- During development, follow `pdcl.md`: write the failing test →
  implement → re-run `npm run test:e2e` → inspect `playwright-report/`
  and traces → update `docs/REQUIREMENTS.md` if behavior changed.
- For manual debugging and UI exploration during development, use the
  `playwright` MCP server (Windsurf) or `playwright-cli` /
  `npx playwright test --debug`.

## 5. Minimum acceptance criteria

A frontend PR is only complete when:

- [ ] Critical flows 2.1–2.6 are covered by specs passing on Chromium.
- [ ] API errors render the contract (`code`, `message`, `details`,
      `next_step`) — see `api.md`.
- [ ] Zero `critical`/`serious` axe violations on the touched pages.
- [ ] No `waitForTimeout`, no real network, no secrets in artifacts.
- [ ] `npm run test:e2e` green locally and in the pipeline.
