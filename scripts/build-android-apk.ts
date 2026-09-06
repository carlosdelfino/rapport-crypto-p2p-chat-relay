import { execFileSync, type SpawnSyncReturns } from 'child_process';
import { existsSync, readFileSync, promises as fs, type Stats } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  ANDROID_INSTALL_CREDIT_GUIDANCE,
  composeBuildEnvironment,
  loadDappEnvironment,
  resolveJavaHome,
  type BuildProcessEnvironment,
  type JavaInstallation,
} from './build-android-environment';

/**
 * build-android-apk.ts
 *
 * Orquestra a compilação do dApp (Expo + EAS local) em APK e o envio do
 * artefato para o servidor de distribuição (host SSH `apk_rapport`).
 *
 * O processo é dividido em três subcomandos para permitir recuperação
 * parcial quando o build demora (~2h) mas o upload falha (SSH, chave,
 * rede):
 *
 *   build    — compila o APK e deposita em `assets/apk-staging/` com um
 *              arquivo `.meta.json` lado a lado (versão, tamanho, data).
 *   upload   — lê o APK mais recente do staging (ou um específico via
 *              --file), envia via scp ao servidor, atualiza o manifest
 *              local, sincroniza com o remoto e regenera a página
 *              /install.
 *   publish  — executa build seguido de upload (comportamento original).
 *
 * Uso:
 *   npm run apk:build           # apenas compilar
 *   npm run apk:upload          # enviar o APK mais recente do staging
 *   npm run apk:upload -- --file rapport-crypto-chat-0.3.1-20260829-120000.apk
 *   npm run apk:publish         # build + upload
 *
 * Variáveis de ambiente opcionais (lidas do shell):
 *   DAPP_DIR         — caminho absoluto do dApp (default: ../dApp)
 *   APK_SSH_HOST     — alias SSH do servidor de APKs (default: apk_rapport)
 *   APK_REMOTE_DIR   — pasta remota destino (default: ~/public_html/rapport/apk)
 *   APK_PUBLIC_URL   — URL pública base para download (default:
 *                      https://apk.rapport.tec.br)
 *   EAS_PROFILE      — perfil do eas.json (default: preview)
 *   JAVA_HOME        — JDK 21 completo; detectado automaticamente se ausente
 *
 * Variáveis Expo são lidas exclusivamente de dApp/.env.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');
const DEFAULT_DAPP_DIR = path.resolve(BACKEND_DIR, '../rapport-crypto-p2p-chat');
const MANIFEST_PATH = path.resolve(BACKEND_DIR, 'assets/apk-manifest.json');
const PUBLIC_INSTALL_DIR = path.resolve(BACKEND_DIR, 'public/install');
const STAGING_DIR = path.resolve(BACKEND_DIR, 'assets/apk-staging');
const SSH_CONTROL_PATH = path.join(
  os.tmpdir(),
  `rapport-ssh-control-${process.pid}`,
);

const DAPP_DIR = process.env.DAPP_DIR
  ? path.resolve(process.env.DAPP_DIR)
  : DEFAULT_DAPP_DIR;
const APK_SSH_HOST = process.env.APK_SSH_HOST ?? 'apk_rapport';
/**
 * Diretório remoto onde os APKs são publicados. Pode começar com `~`, que é
 * expandido para o home directory real via `pwd` do SFTP em
 * `resolveRemoteDir()`. O SFTP não expande `~` em caminhos de `put`/`mkdir`/
 * `ls` — só em `cd` — então precisamos resolver para caminho absoluto.
 */
let APK_REMOTE_DIR = process.env.APK_REMOTE_DIR ?? '~/public_html/rapport/apk';
const APK_PUBLIC_URL = (
  process.env.APK_PUBLIC_URL ?? 'https://apk.rapport.tec.br'
).replace(/\/+$/, '');
const LANDING_URL = 'https://rapport.tec.br/';
const RELAY_INSTALL_URL = (
  process.env.RELAY_INSTALL_URL ?? 'https://rapport-crypto-p2p-chat-relay.vercel.app/install'
).replace(/\/+$/, '');
const EAS_PROFILE = process.env.EAS_PROFILE ?? 'preview';

const ANDROID_HOME = process.env.ANDROID_HOME ?? path.join(os.homedir(), 'Android/Sdk');
const DAPP_ENV_PATH = path.join(DAPP_DIR, '.env');
const JAVA_HOME_CANDIDATES = [
  '/usr/lib/jvm/default-java',
  '/usr/lib/jvm/java-21-openjdk-amd64',
  '/usr/lib/jvm/java-1.21.0-openjdk-amd64',
];

interface ApkEntry {
  filename: string;
  version: string;
  uploadedAt: Date;
  size: number;
}

interface ManifestEntry {
  filename: string;
  version: string;
  uploadedAt: string;
  size: number;
}

interface Manifest {
  apks: ManifestEntry[];
}

interface StagingMeta {
  filename: string;
  version: string;
  builtAt: string;
  size: number;
}

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(
  fn: string,
  level: string,
  message: string,
  params: Record<string, unknown> = {},
): void {
  console.log(
    `[${ts()}] [build-android-apk:${fn}] ${level} ${message} - ${JSON.stringify(params)}`,
  );
}

function fail(
  fn: string,
  message: string,
  params: Record<string, unknown> = {},
): never {
  log(fn, 'ERROR', message, params);
  process.exit(1);
}

/**
 * Resolve o binário `node` do NVM para a versão exigida pelo dApp (.nvmrc).
 * Retorna o caminho absoluto do node, garantindo reprodutibilidade entre
 * shells one-shot (cada exec do Devin abre um shell novo sem `nvm use`).
 */
function resolveNvmNode(): string {
  const homeNvmDir = path.join(os.homedir(), '.nvm');
  const envNvmDir = process.env.NVM_DIR;
  // Prefere NVM_DIR do ambiente, mas faz fallback para ~/.nvm se o
  // nvm.sh nao existir no caminho indicado (NVM_DIR pode apontar para
  // /root/.nvm em shells herdados de outro usuario).
  const nvmDirCandidates = [
    ...(envNvmDir ? [envNvmDir] : []),
    homeNvmDir,
  ];
  const nvmDir = nvmDirCandidates.find((dir) =>
    existsSync(path.join(dir, 'nvm.sh')),
  );
  if (!nvmDir) {
    fail('resolveNvmNode', 'NVM nao encontrado', {
      tried: nvmDirCandidates,
    });
  }
  const nvmSh = path.join(nvmDir, 'nvm.sh');
  // Carrega o NVM e resolve o binário da versão do .nvmrc do dApp.
  // Importante: passar NVM_DIR e HOME explicitamente no env do subprocesso,
  // pois execFileSync pode não herdar todas as variáveis do shell pai.
  const script = [
    'unset npm_config_prefix NPM_CONFIG_PREFIX',
    `source "${nvmSh}"`,
    `cd "${DAPP_DIR}"`,
    'nvm use >/dev/null 2>&1',
    'which node',
  ].join(' && ');
  try {
    const out = execFileSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NVM_DIR: nvmDir,
        HOME: os.homedir(),
      },
    }).trim();
    if (!out) {
      fail('resolveNvmNode', 'node do NVM nao resolvido');
    }
    log('resolveNvmNode', 'INFO', 'Node do NVM resolvido', { node: out });
    return out;
  } catch (err) {
    fail('resolveNvmNode', 'Falha ao resolver node do NVM', {
      error: (err as Error).message,
    });
  }
}

function runPreflight(nodeBin: string): {
  java: JavaInstallation;
  dappEnvironment: Record<string, string>;
} {
  const requiredPaths = [
    DAPP_DIR,
    path.join(DAPP_DIR, '.nvmrc'),
    path.join(DAPP_DIR, 'app.json'),
    path.join(DAPP_DIR, 'eas.json'),
    DAPP_ENV_PATH,
    ANDROID_HOME,
    path.join(ANDROID_HOME, 'platform-tools', 'adb'),
    path.join(path.dirname(nodeBin), 'eas'),
  ];
  const missingPaths = requiredPaths.filter((requiredPath) => !existsSync(requiredPath));
  if (missingPaths.length > 0) {
    fail('runPreflight', 'Pre-requisitos do build ausentes', { missingPaths });
  }
  try {
    const java = resolveJavaHome(process.env.JAVA_HOME, JAVA_HOME_CANDIDATES);
    const dappEnvironment = loadDappEnvironment(DAPP_ENV_PATH);
    log('runPreflight', 'INFO', 'Preflight concluido', {
      javaHome: java.javaHome,
      javaVersion: java.version,
      androidHome: ANDROID_HOME,
      dappEnvPath: DAPP_ENV_PATH,
      dappEnvKeys: Object.keys(dappEnvironment).sort(),
    });
    return { java, dappEnvironment };
  } catch (error) {
    fail('runPreflight', 'Preflight do build falhou', {
      error: (error as Error).message,
    });
  }
}

function readDappVersion(): string {
  const appJsonPath = path.join(DAPP_DIR, 'app.json');
  try {
    const raw = readFileSync(appJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { expo?: { version?: string } };
    const version = parsed?.expo?.version;
    if (!version || typeof version !== 'string') {
      fail('readDappVersion', 'Versao ausente em app.json', { appJsonPath });
    }
    log('readDappVersion', 'INFO', 'Versao do dApp lida', { version });
    return version;
  } catch (err) {
    fail('readDappVersion', 'Falha ao ler app.json', {
      appJsonPath,
      error: (err as Error).message,
    });
  }
}

function timestampStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Executa `eas build --local` no diretório do dApp.
 * Retorna o caminho do APK gerado (parâmetro --output).
 */
function runEasBuild(
  easBin: string,
  outputPath: string,
  buildEnvironment: BuildProcessEnvironment,
): void {
  const args = [
    'build',
    '--local',
    '--non-interactive',
    '--profile',
    EAS_PROFILE,
    '--platform',
    'android',
    '--output',
    outputPath,
  ];
  log('runEasBuild', 'INFO', 'Iniciando EAS build local', {
    profile: EAS_PROFILE,
    output: outputPath,
  });
  try {
    execFileSync(easBin, args, {
      cwd: DAPP_DIR,
      stdio: 'inherit',
      env: buildEnvironment,
    });
    log('runEasBuild', 'INFO', 'EAS build concluido', { output: outputPath });
  } catch (err) {
    const e = err as SpawnSyncReturns<Buffer>;
    fail('runEasBuild', 'EAS build falhou', {
      status: e.status,
      signal: e.signal,
    });
  }
}

async function readManifest(): Promise<Manifest> {
  try {
    const raw = await fs.readFile(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Manifest;
    if (!Array.isArray(parsed?.apks)) {
      return { apks: [] };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { apks: [] };
    }
    throw err;
  }
}

async function writeManifest(manifest: Manifest): Promise<void> {
  await ensureDir(path.dirname(MANIFEST_PATH));
  await fs.writeFile(
    MANIFEST_PATH,
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );
}

async function addApkToManifest(entry: ApkEntry): Promise<void> {
  const manifest = await readManifest();
  // Remove entradas duplicadas com o mesmo filename.
  manifest.apks = manifest.apks.filter((e) => e.filename !== entry.filename);
  manifest.apks.push({
    filename: entry.filename,
    version: entry.version,
    uploadedAt: entry.uploadedAt.toISOString(),
    size: entry.size,
  });
  await writeManifest(manifest);
}

async function listApks(): Promise<ApkEntry[]> {
  const manifest = await readManifest();
  const apks: ApkEntry[] = manifest.apks.map((e) => ({
    filename: e.filename,
    version: e.version,
    uploadedAt: new Date(e.uploadedAt),
    size: e.size,
  }));
  // Mais novos primeiro.
  apks.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
  return apks;
}

// ---------------------------------------------------------------------------
// SSH ControlMaster + SFTP batch
// ---------------------------------------------------------------------------
// O servidor apk_rapport não permite shell access ("Shell access is not
// enabled"), o que impede comandos SSH arbitrários. SFTP (subsystem)
// funciona. Usamos ControlMaster para autenticar uma única vez (passphrase
// da chave) e reusar a conexão em todas as operações SFTP subsequentes.
// ---------------------------------------------------------------------------

/**
 * Abre uma conexão SSH ControlMaster em background. Todas as chamadas
 * SFTP/SCP/SSH subsequentes com `-o ControlPath=...` reusam esta conexão
 * sem pedir passphrase novamente.
 */
function openSshControlMaster(): void {
  log('openSshControlMaster', 'INFO', 'Abrindo conexao ControlMaster', {
    host: APK_SSH_HOST,
    controlPath: SSH_CONTROL_PATH,
  });
  try {
    execFileSync(
      'ssh',
      [
        '-MNf',
        '-o', 'ControlPersist=300',
        '-o', `ControlPath=${SSH_CONTROL_PATH}`,
        APK_SSH_HOST,
      ],
      { stdio: 'inherit' },
    );
    log('openSshControlMaster', 'INFO', 'ControlMaster estabelecido');
  } catch (err) {
    const e = err as SpawnSyncReturns<Buffer>;
    fail('openSshControlMaster', 'Falha ao abrir ControlMaster', {
      status: e.status,
      signal: e.signal,
    });
  }
}

/**
 * Fecha a conexão ControlMaster.
 */
function closeSshControlMaster(): void {
  try {
    execFileSync(
      'ssh',
      ['-S', SSH_CONTROL_PATH, '-O', 'exit', APK_SSH_HOST],
      { stdio: 'pipe' },
    );
    log('closeSshControlMaster', 'INFO', 'ControlMaster fechado');
  } catch {
    // Silencioso na limpeza.
  }
}

/**
 * Executa uma lista de comandos SFTP em batch mode, reusando o
 * ControlMaster. Retorna a saída concatenada (stdout).
 */
function sftpBatch(commands: string[]): string {
  const batch = commands.join('\n') + '\n';
  log('sftpBatch', 'INFO', 'Executando batch SFTP', {
    commands: commands.length,
    controlPath: SSH_CONTROL_PATH,
  });
  try {
    const output = execFileSync(
      'sftp',
      [
        '-b', '-',
        '-o', `ControlPath=${SSH_CONTROL_PATH}`,
        APK_SSH_HOST,
      ],
      {
        encoding: 'utf8',
        input: batch,
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    );
    return output;
  } catch (err) {
    const e = err as SpawnSyncReturns<Buffer>;
    fail('sftpBatch', 'Falha no batch SFTP', {
      status: e.status,
      signal: e.signal,
    });
  }
}

/**
 * Envia o APK ao servidor via SFTP put -P (resume de transferência parcial).
 * Pula o envio se o arquivo já existe remotamente com o mesmo tamanho.
 */
function uploadApkSmart(
  localPath: string,
  filename: string,
  remoteFiles: Map<string, number>,
  force = false,
): void {
  const remotePath = `${APK_REMOTE_DIR}/${filename}`;
  const localStat = existsSync(localPath)
    ? execFileSync('stat', ['-c', '%s', localPath], { encoding: 'utf8' }).trim()
    : '0';
  const localSize = parseInt(localStat, 10);

  // Pula se o arquivo já existe com o mesmo tamanho (a menos que --force).
  if (!force && remoteFiles.has(filename) && remoteFiles.get(filename) === localSize) {
    log('uploadApkSmart', 'INFO', 'APK ja existe remotamente com mesmo tamanho, pulando', {
      filename,
      size: localSize,
    });
    return;
  }

  log('uploadApkSmart', 'INFO', 'Enviando APK ao servidor', {
    filename,
    localSize,
    remoteExists: remoteFiles.has(filename),
  });

  // SFTP put -P habilita resume de transferência parcial.
  sftpBatch([`put -P "${localPath}" "${remotePath}"`]);
  log('uploadApkSmart', 'INFO', 'APK enviado via SFTP', { filename });
}

/**
 * Lista os APKs remotos via SFTP (não exige shell access).
 * Retorna um Map de filename -> size (bytes).
 */
function listRemoteApksViaSftp(): Map<string, number> {
  log('listRemoteApksViaSftp', 'INFO', 'Listando APKs remotos via SFTP', {
    remoteDir: APK_REMOTE_DIR,
  });
  const output = sftpBatch([`ls -l "${APK_REMOTE_DIR}"`]);

  const files = new Map<string, number>();
  // SFTP ls -l output: linhas como:
  //   -rw-r--r--   1 user  group  143861300 Aug 29 12:01 file.apk
  // ou sem detalhes dependendo do servidor. Filtramos por .apk.
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('sftp>')) continue;
    // Tenta extrair tamanho e nome do formato longo.
    const match = trimmed.match(/^(\S+)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\w+\s+\d+\s+[\d:]+\s+(.+)$/);
    if (match && match[3].endsWith('.apk')) {
      files.set(match[3].trim(), parseInt(match[2], 10));
    } else if (trimmed.endsWith('.apk')) {
      // Formato curto: apenas o nome do arquivo.
      files.set(trimmed, 0);
    }
  }
  log('listRemoteApksViaSftp', 'INFO', 'APKs remotos listados', {
    count: files.size,
  });
  return files;
}

/**
 * Resolve `~` no início de `APK_REMOTE_DIR` para o caminho absoluto do home
 * directory remoto, via `pwd` do SFTP. O SFTP não expande `~` em caminhos de
 * `put`, `mkdir` ou `ls` — só em `cd` — então sem esta resolução o arquivo
 * acaba num diretório literal chamado `~` em vez do home real.
 *
 * Se o caminho não começa com `~`, não faz nada.
 */
function resolveRemoteDir(): void {
  if (!APK_REMOTE_DIR.startsWith('~')) return;
  const output = sftpBatch(['pwd']);
  // O SFTP retorna algo como:
  //   sftp> pwd
  //   Remote working directory: /home/usuario
  // Usamos regex para extrair o caminho real, evitando capturar o prompt
  // ou a linha do comando.
  const match = output.match(/Remote working directory:\s*(\S+)/);
  const homeDir = match?.[1]?.trim();
  if (!homeDir) {
    fail('resolveRemoteDir', 'Nao foi possivel obter o home directory remoto via pwd', {
      output: output.replace(/\s+/g, ' ').slice(0, 200),
    });
  }
  const rest = APK_REMOTE_DIR.slice(1); // remove o ~
  APK_REMOTE_DIR = `${homeDir}${rest}`;
  log('resolveRemoteDir', 'INFO', 'Diretorio remoto resolvido', {
    resolved: APK_REMOTE_DIR,
  });
}

/**
 * Sincroniza o manifest local com os APKs realmente presentes no servidor.
 * Remove entradas cujo arquivo não existe mais remotamente.
 * Retorna o número de entradas removidas.
 */
async function syncManifestWithRemote(): Promise<number> {
  const remoteFiles = listRemoteApksViaSftp();
  const remoteSet = new Set(remoteFiles.keys());
  const manifest = await readManifest();
  const before = manifest.apks.length;
  manifest.apks = manifest.apks.filter((e) => remoteSet.has(e.filename));
  const removed = before - manifest.apks.length;
  if (removed > 0) {
    await writeManifest(manifest);
    log('syncManifestWithRemote', 'INFO', 'Manifest sincronizado', {
      before,
      after: manifest.apks.length,
      removed,
    });
  } else {
    log('syncManifestWithRemote', 'INFO', 'Manifest ja consistente', {
      count: manifest.apks.length,
    });
  }
  return removed;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Gera a página /install que lista todos os APKs disponíveis para download.
 * Os arquivos são servidos por https://apk.rapport.tec.br; esta página atua
 * como índice navegável com links diretos para cada versão.
 */
function renderInstallPage(apks: ApkEntry[]): string {
  const latest = apks[0];
  const versionLabel = latest ? `v${latest.version}` : '';

  const apkRows = apks.map((apk, idx) => {
    const downloadUrl = `${APK_PUBLIC_URL}/${encodeURIComponent(apk.filename)}`;
    const isLatest = idx === 0;
    return `      <a class="apk-row${isLatest ? ' apk-latest' : ''}" href="${downloadUrl}" download>
        <div class="apk-info">
          <span class="apk-version">v${escapeHtml(apk.version)}${isLatest ? ' <span class="latest-tag">mais recente</span>' : ''}</span>
          <span class="apk-meta">${escapeHtml(formatDate(apk.uploadedAt))} &middot; ${escapeHtml(humanSize(apk.size))}</span>
          <span class="apk-filename">${escapeHtml(apk.filename)}</span>
        </div>
        <span class="apk-download">Baixar</span>
      </a>`;
  }).join('\n');

  const emptyState = apks.length === 0
    ? '    <p class="empty">Nenhum APK disponível ainda. Volte em breve.</p>\n'
    : `    <div class="apk-list">\n${apkRows}\n    </div>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="robots" content="index, follow"/>
  <title>Rapport Crypto P2P Chat — Instalar aplicativo Android${versionLabel ? ' (' + versionLabel + ')' : ''}</title>
  <meta name="description" content="Baixe a versão mais recente do aplicativo Rapport Crypto P2P Chat para Android."/>
  <style>
    :root {
      --bg:#020617; --card:#0f172a; --card-60:rgba(15,23,42,0.6);
      --border:#1e293b; --text:#f1f5f9; --muted:#94a3b8; --secondary:#cbd5e1;
      --brand:#ea580c; --brand-light:#fb923c; --brand-300:#fdba74; --brand-500:#f97316;
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    body {
      font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      background:var(--bg); color:var(--text); line-height:1.6;
      min-height:100vh; padding:1rem; -webkit-font-smoothing:antialiased;
    }
    .container { max-width:48rem; margin:0 auto; padding:1rem 0; }
    .hero { text-align:center; padding:1.5rem 1rem 1rem; }
    .hero h1 { font-size:clamp(1.5rem,3.5vw,2rem); font-weight:800; color:var(--brand-light); margin-bottom:.5rem; }
    .hero p { color:var(--secondary); font-size:.95rem; max-width:32rem; margin:0 auto; }
    .section-title { font-size:1.1rem; font-weight:700; color:var(--brand-light); margin:2rem 0 .75rem; }
    .apk-list { display:flex; flex-direction:column; gap:.75rem; }
    .apk-row {
      display:flex; align-items:center; justify-content:space-between; gap:1rem;
      border:1px solid var(--border); border-radius:1rem;
      background:var(--card-60); backdrop-filter:blur(8px);
      padding:1.25rem 1.5rem; text-decoration:none; color:inherit;
      transition:border-color .2s, transform .2s, box-shadow .2s;
    }
    .apk-row:hover {
      border-color:var(--brand); transform:translateY(-1px);
      box-shadow:0 6px 20px rgba(234,88,12,.1);
    }
    .apk-latest { border-color:var(--brand-500); }
    .apk-info { display:flex; flex-direction:column; gap:.2rem; min-width:0; }
    .apk-version { font-size:1.1rem; font-weight:700; color:var(--text); }
    .latest-tag {
      display:inline-block; padding:.1rem .5rem; border-radius:999px;
      background:rgba(234,88,12,.15); color:var(--brand-light);
      font-size:.7rem; font-weight:700; margin-left:.4rem; vertical-align:middle;
    }
    .apk-meta { font-size:.8rem; color:var(--muted); }
    .apk-filename {
      font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
      font-size:.75rem; color:var(--secondary); word-break:break-all;
    }
    .apk-download {
      flex-shrink:0; padding:.6rem 1.2rem; border-radius:.6rem;
      background:var(--brand); color:#fff; font-size:.85rem; font-weight:700;
      white-space:nowrap;
    }
    .apk-row:hover .apk-download { background:var(--brand-500); }
    .empty { color:var(--muted); text-align:center; padding:2rem; }
    .install-guide {
      border:1px solid var(--border); border-radius:1rem;
      background:var(--card-60); backdrop-filter:blur(8px);
      padding:1.5rem; margin-top:1.5rem;
    }
    .install-guide h2 { font-size:.95rem; font-weight:700; color:var(--brand-light); margin-bottom:.75rem; }
    .install-guide ol { padding-left:1.5rem; color:var(--secondary); font-size:.85rem; }
    .install-guide li { margin-bottom:.4rem; }
    .footer { text-align:center; color:var(--muted); font-size:.8rem; margin-top:2rem; padding-top:1.5rem; border-top:1px solid var(--border); }
    .footer a { color:var(--brand-light); text-decoration:none; }
    .footer a:hover { color:var(--brand); }
  </style>
</head>
<body>
  <div class="container">
    <header class="hero">
      <h1>Instalar Rapport Crypto P2P Chat</h1>
      <p>Baixe o aplicativo Android diretamente do servidor de distribuição. ${versionLabel ? `Versão mais recente: <strong>${versionLabel}</strong>.` : ''}</p>
    </header>

    <h2 class="section-title">Vers&otilde;es dispon&iacute;veis</h2>
${emptyState}
    <div class="install-guide">
      <h2>Como instalar</h2>
      <ol>
        <li>Toque no link "Baixar" acima para baixar o arquivo .apk.</li>
        <li>Se solicitado, permita instala&ccedil;&otilde;es de fontes desconhecidas nas configura&ccedil;&otilde;es do Android.</li>
        <li>Abra o arquivo baixado e confirme a instala&ccedil;&atilde;o.</li>
        <li>Abra o Rapport Crypto P2P Chat e configure sua carteira.</li>
      </ol>
    </div>

    <div class="footer">
      <p><a href="/">&larr; Voltar ao in&iacute;cio</a> &middot; <a href="/stats">Estat&iacute;sticas</a></p>
      <p>&copy; 2026 <a href="https://rapport.tec.br">Rapport Tecnologia e Inova&ccedil;&atilde;o</a>.</p>
    </div>
  </div>
</body>
</html>
`;
}

interface PublicManifest {
  latestVersion: string | null;
  uploadedAt: string | null;
  filename: string | null;
  downloadUrl: string | null;
  installUrl: string;
  apkServerUrl: string;
  size: number | null;
}

async function regenerateInstallPage(): Promise<void> {
  const apks = await listApks();
  const html = renderInstallPage(apks);
  await ensureDir(PUBLIC_INSTALL_DIR);
  await fs.writeFile(path.join(PUBLIC_INSTALL_DIR, 'index.html'), html, 'utf8');

  // Manifest JSON para o dApp consultar a versão mais recente sem parsear HTML.
  const latest = apks[0];
  const manifest: PublicManifest = latest !== undefined
    ? {
        latestVersion: latest.version,
        uploadedAt: latest.uploadedAt.toISOString(),
        filename: latest.filename,
        downloadUrl: `${APK_PUBLIC_URL}/${encodeURIComponent(latest.filename)}`,
        installUrl: RELAY_INSTALL_URL,
        apkServerUrl: APK_PUBLIC_URL,
        size: latest.size,
      }
    : {
        latestVersion: null,
        uploadedAt: null,
        filename: null,
        downloadUrl: null,
        installUrl: RELAY_INSTALL_URL,
        apkServerUrl: APK_PUBLIC_URL,
        size: null,
      };
  await fs.writeFile(
    path.join(PUBLIC_INSTALL_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  log('regenerateInstallPage', 'INFO', 'Pagina /install regenerada', {
    apkCount: apks.length,
    latestVersion: manifest.latestVersion,
  });
}

/**
 * Envia o manifest.json público ao servidor de APKs via SFTP, para que
 * o dApp possa consultar a versão mais recente diretamente em
 * https://apk.rapport.tec.br/manifest.json como fallback do relay.
 */
function uploadManifestToServer(): void {
  const localManifest = path.join(PUBLIC_INSTALL_DIR, 'manifest.json');
  if (!existsSync(localManifest)) {
    log('uploadManifestToServer', 'WARN', 'manifest.json local nao encontrado, pulando upload', {
      localManifest,
    });
    return;
  }
  const remotePath = `${APK_REMOTE_DIR}/manifest.json`;
  log('uploadManifestToServer', 'INFO', 'Enviando manifest.json ao servidor de APKs', {
    remotePath,
  });
  sftpBatch([`put -P "${localManifest}" "${remotePath}"`]);
  log('uploadManifestToServer', 'INFO', 'manifest.json enviado ao servidor de APKs');
}

// ---------------------------------------------------------------------------
// Staging helpers
// ---------------------------------------------------------------------------

function stagingMetaPath(apkPath: string): string {
  return `${apkPath}.meta.json`;
}

async function writeStagingMeta(apkPath: string, meta: StagingMeta): Promise<void> {
  await fs.writeFile(stagingMetaPath(apkPath), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

async function readStagingMeta(apkPath: string): Promise<StagingMeta> {
  const raw = await fs.readFile(stagingMetaPath(apkPath), 'utf8');
  return JSON.parse(raw) as StagingMeta;
}

/**
 * Lista os APKs presentes no diretório de staging, ordenados do mais novo
 * para o mais velho (por mtime).
 */
async function listStagingApks(): Promise<string[]> {
  await ensureDir(STAGING_DIR);
  const entries = await fs.readdir(STAGING_DIR);
  const apks = entries.filter((e) => e.endsWith('.apk'));
  const withStats = await Promise.all(
    apks.map(async (name) => {
      const fullPath = path.join(STAGING_DIR, name);
      const stat = await fs.stat(fullPath);
      return { name, mtime: stat.mtimeMs };
    }),
  );
  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats.map((e) => e.name);
}

/**
 * Resolve qual APK do staging enviar. Se `--file` foi passado, valida que
 * ele existe; caso contrário pega o mais recente.
 */
async function resolveStagingApk(fileFlag?: string): Promise<string> {
  if (fileFlag) {
    const candidate = path.isAbsolute(fileFlag) ? fileFlag : path.join(STAGING_DIR, fileFlag);
    if (!existsSync(candidate)) {
      fail('resolveStagingApk', 'APK nao encontrado no staging', { file: fileFlag });
    }
    return candidate;
  }
  const apks = await listStagingApks();
  if (apks.length === 0) {
    fail(
      'resolveStagingApk',
      'Nenhum APK no staging. Execute "npm run apk:build" primeiro.',
      { stagingDir: STAGING_DIR },
    );
  }
  const latest = apks[0];
  log('resolveStagingApk', 'INFO', 'APK mais recente do staging selecionado', {
    file: latest,
    available: apks.length,
  });
  return path.join(STAGING_DIR, latest);
}

// ---------------------------------------------------------------------------
// Subcomandos
// ---------------------------------------------------------------------------

/**
 * Subcomando `build`: compila o APK via EAS local e deposita em
 * `assets/apk-staging/` com um `.meta.json` lado a lado.
 */
async function runBuild(): Promise<void> {
  log('runBuild', 'INFO', 'Iniciando build do APK (somente compilacao)', {
    dappDir: DAPP_DIR,
    stagingDir: STAGING_DIR,
    profile: EAS_PROFILE,
    androidHome: ANDROID_HOME,
    dappEnvPath: DAPP_ENV_PATH,
  });

  const nodeBin = resolveNvmNode();
  const easBin = path.join(path.dirname(nodeBin), 'eas');
  const { java, dappEnvironment } = runPreflight(nodeBin);
  const buildEnvironment = composeBuildEnvironment(process.env, dappEnvironment, {
    androidHome: ANDROID_HOME,
    javaHome: java.javaHome,
    nodeBinDirectory: path.dirname(nodeBin),
    nvmDir: process.env.NVM_DIR ?? path.join(os.homedir(), '.nvm'),
    home: os.homedir(),
  });
  const version = readDappVersion();

  const tmpApk = path.join(os.tmpdir(), `rapport-build-${process.pid}.apk`);

  try {
    runEasBuild(easBin, tmpApk, buildEnvironment);

    let stat: Stats;
    try {
      stat = await fs.stat(tmpApk);
    } catch {
      fail('runBuild', 'APK nao encontrado apos build', { tmpApk });
    }

    const stamp = timestampStamp(new Date());
    const destName = `rapport-crypto-p2p-chat-${version}-${stamp}.apk`;
    await ensureDir(STAGING_DIR);
    const destPath = path.join(STAGING_DIR, destName);
    await fs.copyFile(tmpApk, destPath);

    await writeStagingMeta(destPath, {
      filename: destName,
      version,
      builtAt: new Date().toISOString(),
      size: stat.size,
    });

    log('runBuild', 'INFO', 'APK depositado no staging', {
      dest: destName,
      version,
      size: stat.size,
      stagingDir: STAGING_DIR,
    });
    log('runBuild', 'INFO', 'Build concluido. Para enviar, execute: npm run apk:upload');
  } finally {
    await fs.rm(tmpApk, { force: true }).catch(() => undefined);
  }
}

/**
 * Subcomando `upload`: envia um APK do staging ao servidor de distribuição,
 * atualiza o manifest local, sincroniza com o remoto e regenera a página
 * /install.
 */
async function runUpload(fileFlag?: string, force = false): Promise<void> {
  log('runUpload', 'INFO', 'Iniciando upload do APK (do staging)', {
    sshHost: APK_SSH_HOST,
    remoteDir: APK_REMOTE_DIR,
    publicUrl: APK_PUBLIC_URL,
    manifestPath: MANIFEST_PATH,
    stagingDir: STAGING_DIR,
    force,
  });

  const apkPath = await resolveStagingApk(fileFlag);
  const apkName = path.basename(apkPath);

  let meta: StagingMeta;
  try {
    meta = await readStagingMeta(apkPath);
  } catch {
    // Fallback: deriva metadados do próprio arquivo.
    const stat = await fs.stat(apkPath);
    const versionMatch = apkName.match(/^rapport-crypto-p2p-chat-([^-]+)-/);
    meta = {
      filename: apkName,
      version: versionMatch?.[1] ?? 'unknown',
      builtAt: stat.mtime.toISOString(),
      size: stat.size,
    };
    log('runUpload', 'WARN', 'Meta.json ausente, derivando do arquivo', {
      apkName,
      version: meta.version,
    });
  }

  // Abre ControlMaster uma única vez — passphrase pedida só aqui.
  // Todas as operações SFTP subsequentes reusam a conexão.
  openSshControlMaster();

  try {
    // 0. Resolve ~ para caminho absoluto (SFTP não expande ~ em put/mkdir/ls).
    resolveRemoteDir();

    // 1. Lista APKs remotos atuais (SFTP ls) — para sync e skip.
    const remoteFiles = listRemoteApksViaSftp();

    // 3. Envia o APK (SFTP put -P; pula se já existe).
    uploadApkSmart(apkPath, apkName, remoteFiles, force);

    // 4. Registra no manifest local.
    await addApkToManifest({
      filename: apkName,
      version: meta.version,
      uploadedAt: new Date(),
      size: meta.size,
    });
    log('runUpload', 'INFO', 'APK registrado no manifest', {
      dest: apkName,
      version: meta.version,
      size: meta.size,
    });

    // 5. Sincroniza manifest com remoto e regenera página.
    await syncManifestWithRemote();
    await regenerateInstallPage();

    // 6. Envia manifest.json ao servidor de APKs (fallback para o dApp).
    uploadManifestToServer();

    log('runUpload', 'INFO', 'APK enviado e artefatos locais de divulgacao atualizados', {
      dest: apkName,
      latestManifestPath: path.join(PUBLIC_INSTALL_DIR, 'manifest.json'),
    });
    log('runUpload', 'WARN', 'Divulgacao no dApp pendente de deploy do backend', {
      installManifestUrl: `${RELAY_INSTALL_URL}/manifest.json`,
      apkServerManifestUrl: `${APK_PUBLIC_URL}/manifest.json`,
      action: 'publique o backend com public/install atualizado',
    });
  } finally {
    // Sempre fecha o ControlMaster.
    closeSshControlMaster();
  }
}

/**
 * Subcomando `publish`: executa build seguido de upload.
 */
async function runPublish(force?: boolean): Promise<void> {
  log('runPublish', 'INFO', 'Iniciando publish (build + upload)', {
    dappDir: DAPP_DIR,
    sshHost: APK_SSH_HOST,
    remoteDir: APK_REMOTE_DIR,
    publicUrl: APK_PUBLIC_URL,
    manifestPath: MANIFEST_PATH,
    profile: EAS_PROFILE,
    androidHome: ANDROID_HOME,
    dappEnvPath: DAPP_ENV_PATH,
    force,
  });

  await runBuild();

  // Pega o APK mais recente do staging (acabou de ser gerado).
  await runUpload(undefined, force);
}

/**
 * Subcomando `regenerate`: regenera apenas a página /install e o
 * manifest.json público a partir do manifest local de APKs, sem acessar
 * o servidor SSH. Útil para refletir mudanças de copy/orientações sem
 * precisar reenviar artefatos.
 */
async function runRegenerate(): Promise<void> {
  log('runRegenerate', 'INFO', 'Regenerando pagina /install (sem upload)', {
    manifestPath: MANIFEST_PATH,
    publicInstallDir: PUBLIC_INSTALL_DIR,
  });
  await regenerateInstallPage();
  log('runRegenerate', 'INFO', 'Pagina /install regenerada com sucesso');
}

// ---------------------------------------------------------------------------
// CLI dispatcher
// ---------------------------------------------------------------------------

interface UploadFlags {
  file?: string;
  force?: boolean;
}

function parseUploadFlags(argv: string[]): UploadFlags {
  const idx = argv.indexOf('--file');
  const file =
    idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  const force = argv.includes('--force');
  return { file, force };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const validCommands = ['build', 'upload', 'publish', 'regenerate'];

  if (!command || !validCommands.includes(command)) {
    console.error(
      `Uso: tsx scripts/build-android-apk.ts <build|upload|publish|regenerate> [--file <name>] [--force]\n` +
        '  build      — compila o APK e deposita em assets/apk-staging/\n' +
        '  upload     — envia o APK do staging ao servidor\n' +
        '  publish    — build + upload\n' +
        '  regenerate — regenera apenas a página /install (sem upload)\n' +
        '  --file <name>  — envia um APK específico do staging\n' +
        '  --force        — reenvia mesmo que o APK já exista no servidor',
    );
    process.exit(1);
  }

  try {
    const uploadFlags = parseUploadFlags(process.argv.slice(3));
    switch (command) {
      case 'build':
        await runBuild();
        break;
      case 'upload':
        await runUpload(uploadFlags.file, uploadFlags.force);
        break;
      case 'publish':
        await runPublish(uploadFlags.force);
        break;
      case 'regenerate':
        await runRegenerate();
        break;
    }
  } catch (err) {
    log('main', 'ERROR', 'Erro fatal', { command, error: (err as Error).message });
    process.exit(1);
  }
}

main().catch((err: Error) => {
  log('main', 'ERROR', 'Erro fatal nao tratado', { error: err.message });
  process.exit(1);
});
