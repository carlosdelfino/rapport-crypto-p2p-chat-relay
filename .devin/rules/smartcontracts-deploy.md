---
description: Applied when planning, running, or fixing build, install, CI/CD, deploy, upgrade, or on-chain operations for Solidity smart contracts. Defines roles, environments, key management, scripts, verification, and the final checklist.
trigger: model_decision
---

# Smart Contracts Build & Deploy Rule

> Development rules and patterns: see `smartcontracts.md`
> Security and audit rules: see `smartcontracts-solidity-security.md`
> DAO governance rules: see `smartcontrcts-dao.md`

## Context

The project is a monorepo with independent modules. Before any deploy, ensure the
smart contract has been compiled and tested with Hardhat/Foundry
(`npm run compile`, `npm run test`).

Respect each module's autonomy and never assume a single npm workspace exists.

## Build

1. **Always start by installing dependencies of the changed module:**
   - `npm install` inside the module directory
   - use `npm ci` in pipelines/CI for reproducibility

2. **Standard scripts expected in each module:**
   - `build:install` — installs dependencies and runs the build (e.g. `npm install && npm run build`)
   - `build` — compiles the module
   - `test` — runs unit/integration tests

3. **Smart Contracts (`smartcontracts/`):**
   - `npm run compile` — Hardhat
   - `npm run test` — Hardhat
   - `npm run test:foundry` — Foundry
   - `npm run audit:full` — lint + Slither + Mythril + Echidna
   - Never deploy to mainnet without human review and the security checklist.

4. **Pre-build validations:**
   - Presence of `.env` and `.env.local` when required by the module.
   - Critical variables such as `DATABASE_URL`, `NEO4J_URI`, `RPC_*`, `PRIVATE_KEY` (only via `.env`).
   - Node version (`>=22.x`) per `engines` in `package.json` — see `smartcontracts-node.md`.

## Deploy Roles

For security reasons, there are two main roles:

- **Owner:** account that deploys to the production environment (mainnet). Holds administrative privileges (upgrade, pause, roles). Must be a multisig.
- **Relayer:** account running in the backend that uses the contracts for operational transactions. Registered as responsible in the backend. Holds no administrative privileges.

### Principles

- Separate the deploy key, operational key (relayer), and administrative key.
- Use a hardware wallet or secure vault for administrative keys.
- Never keep deploy keys in the repository (see `private_key.md`).
- Use multisig for critical administration.
- Remove privileges from temporary deployers after deployment.
- The deployer must not hold unnecessary privileges after deploy.

## Diamond Pattern

- Contracts should preferably use the Diamond pattern when larger than 4 contracts, avoiding address changes in code when a contract changes.
- Always check whether the project already uses Diamond to avoid unnecessary redeploys.
- Check for function selector collisions when adding new facets.

## Environments

- **Mandatory testnet:** every contract must be tested on testnet before mainnet.
- **Mainnet fork:** use a mainnet fork when integrating with existing protocols.
- **Mainnet:** only after testnet, audit, and approved final checklist.
- **Preferred blockchain:** POL (Chain ID: 80002 testnet, 137 mainnet).
- Keep alternative RPC providers configured.

## Pre-Deploy

### Verification checklist

- [ ] Code frozen for audit.
- [ ] Unit tests passing (`npm test` in the changed module).
- [ ] Integration tests passing.
- [ ] Invariant tests passing.
- [ ] Fuzzing executed.
- [ ] Slither with no unjustified warnings.
- [ ] Manual review completed.
- [ ] Dependencies pinned.
- [ ] Compiler pinned.
- [ ] Known compiler bugs checked.
- [ ] Storage layout validated.
- [ ] Deploy scripts reviewed.
- [ ] Token and dependency addresses verified.
- [ ] Administrative roles verified.
- [ ] Deployer holds no unnecessary privileges.
- [ ] Multisig configured.
- [ ] Timelock configured.
- [ ] Pause tested.
- [ ] Recovery process tested.
- [ ] Testnet used (`deploy:*:amoy` scripts for testnet testing).
- [ ] Mainnet fork used when integrating with existing protocols.
- [ ] Reproducible bytecode.
- [ ] External audit performed for contracts controlling funds or critical identities.
- [ ] Build completes without errors.
- [ ] `.env` updated and not versioned.
- [ ] Smart contracts audited (if changed).
- [ ] Git commit and push done on the correct repository.

> Detailed security checklist (sections 1-24): see `smartcontracts-solidity-security.md`

## During Deploy

- Always check the balance before deploying, transacting, and registering.
- Simulate the transaction before executing it.
- Verify the published bytecode matches the audited source code.
- Confirm token and dependency addresses before interacting.
- Human-readable output in scripts.
- Exceptions handled and logged in a format suitable for both LLMs and humans.
- Use `deploy:*:amoy` scripts for testnet; `deploy:*:polygon` scripts only for mainnet after review.

## Post-Deploy

- Verify the contract on a block explorer (Etherscan/Polygonscan).
- Contract address published on a trusted channel.
- Register the contract in `ContractRegistry` after deploy: `ContractRegistry.register(name, version, address)`.
- Backend and frontend query `ContractRegistry` to discover addresses — never hardcode them.
- Always verify and validate addresses, proxies, and timelocks after deploy.
- Monitoring configured; monitor on-chain administrative changes.
- Incident response plan documented.
- Deploy logs reviewed.

## dApp Security and Deploy Infrastructure

- Protect deploy configuration files.
- Never write private keys, mnemonics, tokens, or passwords to code, config, or log files.
- Keep secrets in `.env` and ensure `.gitignore` includes it.
- Use a hardware wallet or secure vault for administrative keys.
- Protect domain and DNS.
- Implement CSP and web protections.
- Validate data returned by RPCs.
- Do not rely solely on the backend to determine on-chain validity.
- Check NPM dependencies; pin versions.
- Protect CI/CD.
- Require review before deploying to production — when in doubt, ask for human confirmation before mainnet or production deploys.

## Support Scripts and Scalability

- New contracts must be registered in `ContractRegistry` after deploy.
- Backend and frontend query `ContractRegistry` for address discovery.
- Never hardcode contract addresses in off-chain code.
- Contract versioning via `ContractRegistry.register(name, version, address)`.
