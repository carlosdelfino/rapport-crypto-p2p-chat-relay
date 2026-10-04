---
trigger: always_on
---

# Tests and Analysis Rule

Every code change must be validated by systematic tests before it is
considered complete. A change without executed, recorded tests is
unfinished work.

## Test layers

- **Unit tests** — each new or modified function/module is exercised in
  isolation, covering normal inputs, boundary values, and error
  conditions.
- **Integration tests** — the component is exercised with its real
  collaborators (Postgres, chain RPC, Vercel runtime) or the project's
  standard test doubles when the real dependency is unavailable.
- **Acceptance tests** — business requirements are exercised end to end
  through the same paths a user or agent would use (see the Playwright
  E2E section below for the hosted dApp).

## Practices required on every change

- Run `npm run typecheck` plus the tests affected by the change and the
  adjacent suites before marking the task done.
- Every bugfix ships with a regression test that fails without the fix.
- New API endpoints, relay flows, or public functions ship with at
  least a happy-path case and an error-path case.
- Tests must be deterministic and isolated: no order dependence, no
  shared mutable state, no real external network or chain calls.
- Never weaken, delete, or skip an existing test to make the suite pass.
- Review generated logs after each run to confirm records are correct.
- Test real scenarios, error conditions, and edge cases — not only the
  happy path.

## White-box testing (progressive)

White-box tests read the implementation, not only its contract. They are
applied progressively: each change extends coverage of the touched
module instead of trying to cover the whole project at once.

- Exercise internal branches, loops, early returns, and exception paths —
  not only inputs and outputs.
- Map every test to a `REQUIREMENTS.md` item or acceptance criterion. A
  requirement is implemented only when a test proves its behavior
  through the real code path; record the requirement ID in the test name
  or docstring.
- Progression order for the modified code: statement coverage → branch
  coverage → condition/path coverage. Track uncovered branches and
  prioritize them by risk (signature verification, nonce handling,
  payment relay first — see `security-backend.md`).
- Assert internal invariants and state transitions (payment status,
  nonce uniqueness, session state), not only HTTP responses.
- Record which requirement IDs the change validated, per the logging
  and PDCL rules.

## Evidence

For each change, document: commands run, tests added or updated,
results, coverage delta for the touched module, and the requirement IDs
verified. On failure, analyze the root cause, fix it, and re-run the
full chain — never patch the symptom.

## End-to-end tests (Playwright)

The dApp served by this module must be validated with end-to-end tests
via [Playwright](https://playwright.dev) before being considered done.

### E2E setup

- Dependency: `@playwright/test` in `devDependencies` (installed).
- Configuration in `playwright.config.ts`; specs under `e2e/`
  (`*.spec.ts` — currently `site`, `chat`, `wallet`, `tokens`, `i18n`,
  `ajudar`, with shared `helpers.ts`).
- npm scripts: `test:e2e`, `test:e2e:ui`, `test:e2e:headed`.
- `webServer` must boot the app the way it is served in production
  (`vercel dev` or the deployed build). Never test against a dev server
  with HMR in CI, since HMR masks build errors.
- Node.js >= 20 for the runner.
- Browsers: `chromium` is the mandatory project; add `webkit` and a
  mobile (`Pixel`-like) project when mobile usage becomes relevant.
- Artifacts (`playwright-report/`, `test-results/`) belong in
  `.gitignore`.

### Most important E2E tests (per-flow checklist)

Priority order — cover first the flows that move funds or on-chain
state, then UX and visual regression.

#### Entry gate and session (critical)

- With no wallet connected, the app renders only the entry-gate screen.
- Accepting terms / connecting a (mocked) wallet unlocks the shell and
  shows the truncated address.
- Reloading the page must not leave the app in a broken state when a
  session exists (storage state).

#### API error contract (critical — see `api.md`)

- Intercept calls with `page.route()` and assert that every error
  response renders `code`, `message`, `details` and `next_step` — never
  a stack trace, raw payload or blank screen.
- 401/403 → the app guides the correct action (re-authenticate /
  reconnect wallet).
- 5xx and timeout → safe message + retry option; the app must not hang
  on an eternal spinner.

#### Chat, wallet and token flows — highest risk

- Chat screens render with mocked data; **empty**, **loading** and
  **error** states have explicit UI.
- Payment/relay actions require explicit user confirmation and are
  rejected client-side on invalid input **before** any request or
  transaction.
- Wallet/RPC always mocked via `page.addInitScript` or `page.route` —
  **never** hit a real RPC, real chain or real keys in tests.
- User signature rejection ("user rejected") is handled with proper UI.
- Test wallets come from environment variables (`TEST_WALLET_*`),
  never hardcoded (see `private_key.md`).
- Amounts displayed formatted (decimals), never raw wei.

#### Theme, accessibility and responsive

- Theme uses the palette tokens (`design_ui.md` / `paleta.md`). Assert
  with `getComputedStyle`.
- Accessibility scan with `@axe-core/playwright` on the main pages:
  zero `critical`/`serious` violations; input labels, visible focus,
  contrast >= 4.5:1 for text.
- Viewports: desktop 1280x720 and mobile ~390x844 — nav must not break,
  tables scroll or stack.
- Visual regression: `toHaveScreenshot()` on stable pages (baselines
  versioned per browser/OS).

#### Runtime hygiene

- Zero `console.error` and zero failed unmocked requests during
  happy-path flows (assert via `page.on('console')` /
  `page.on('pageerror')`).
- No calls to unmocked external domains (defense against data leakage
  and flakiness).

### E2E best practices (mandatory)

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
  and RPC call; keep JSON fixtures under `e2e/fixtures/`.
- **Configuration**: `fullyParallel: true`, `retries: 2` only in CI,
  `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`,
  `video: 'retain-on-failure'`.
- **Secrets**: no private key, mnemonic or token in specs, fixtures or
  artifacts (trace/video may record the screen — review before attaching
  to a PR).
- **Data**: use deterministic testnet accounts and contracts; never
  mainnet.

### E2E pipeline integration and PDCL

- The pipeline runs `npm run test:e2e` when `e2e/` exists; E2E failure
  blocks the build/deploy (same criterion as contract audits).
- During development, follow `pdcl.md`: write the failing test →
  implement → re-run `npm run test:e2e` → inspect `playwright-report/`
  and traces → update `docs/REQUIREMENTS.md` if behavior changed.
- For manual debugging and UI exploration during development, use the
  `playwright` MCP server or `playwright-cli` /
  `npx playwright test --debug`.

### Minimum E2E acceptance criteria

A change touching the dApp is only complete when:

- [ ] The critical flows above are covered by specs passing on Chromium.
- [ ] API errors render the contract (`code`, `message`, `details`,
      `next_step`) — see `api.md`.
- [ ] Zero `critical`/`serious` axe violations on the touched pages.
- [ ] No `waitForTimeout`, no real network, no secrets in artifacts.
- [ ] `npm run test:e2e` green locally and in the pipeline.

## Project specifics

- `npm run typecheck` (`tsc --noEmit`) is mandatory on every change.
- There is no unit test runner configured — only Playwright E2E.
  Backend logic in `api/` and `lib/` should get a runner (`node --test`
  or Vitest); flag in `REQUIREMENTS.md` any logic that currently cannot
  be tested below the E2E layer.
- Vercel serverless deploy (`vercel.json`); never run E2E against
  production.
