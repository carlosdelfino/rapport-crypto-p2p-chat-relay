---
trigger: model_decision
description: Orienta o agente sobre build e deploy no projeto. Deve ser carregado ao planejar, executar ou corrigir rotinas de build, install, CI/CD ou deploy de smart contracts.
---

# Build e Deploy

## Contexto

O projeto  é um monorepo com módulos independentes, sempre que fizer um deploy antes deve certificar que o smartcontract foi compilado e testado com Hardhat/Foundry (`npm run compile`, `npm run test`)

O agente deve respeitar a autonomia de cada módulo e evitar assumir a existência de um workspace único do npm.

## Build

1. **Sempre inicie pela instalação das dependências do módulo alterado:**
   - `npm install` dentro da pasta do módulo
   - use `npm ci` em pipelines/CI para reprodutibilidade

2. **Scripts padrão esperados em cada módulo:**
   - `build:install` — instala dependências e executa build (ex.: `npm install && npm run build`)
   - `build` — compila o módulo
   - `test` — roda testes unitários/integração

3. **Smart Contracts (`smartcontracts/`):**
   - `npm run compile` — Hardhat
   - `npm run test` — Hardhat
   - `npm run test:foundry` — Foundry
   - `npm run audit:full` — lint + Slither + Mythril + Echidna
   - Nunca rode deploy em mainnet sem revisão humana e checklist de segurança.

4. **Validações antes do build:**
   - Presença de `.env` e `.env.local` quando exigidos pelo módulo.
   - Variáveis críticas como `DATABASE_URL`, `NEO4J_URI`, `RPC_*`, `PRIVATE_KEY` (apenas via `.env`).
   - Versão do Node (`>=22.x`) conforme `engines` dos `package.json`.

## Deploy

1. **Deploy de smart contracts:**
   - Use scripts `deploy:*:amoy` para testes em testnet.
   - Use scripts `deploy:*:polygon` apenas para mainnet após revisão.
   - Sempre verifique e valide endereços, proxies e timelocks após o deploy.

2. **Checklist de deploy:**
   - [ ] Testes passam (`npm test` no módulo alterado)
   - [ ] Build gera sem erros
   - [ ] `.env` atualizado e não versionado
   - [ ] Smart contracts auditados (se alterados)
   - [ ] Git commit e push realizados no repositório correto
   - [ ] Logs de deploy revisados

## Segurança

- Nunca escreva chaves privadas, mnemônicos, tokens ou senhas em arquivos de código, configuração ou logs.
- Mantenha segredos em `.env` e certifique-se de que `.gitignore` o inclui.
- Em caso de dúvida, peça confirmação humana antes de executar deploy em mainnet ou produção.