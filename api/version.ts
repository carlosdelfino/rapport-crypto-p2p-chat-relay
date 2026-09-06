import { readFileSync } from 'fs';
import path from 'path';
import { setCorsHeaders } from '../lib/cors.js';
import type { VercelRequest, VercelResponse } from '../lib/vercel.js';

const MANIFEST_PATH = path.resolve(process.cwd(), 'public', 'install', 'manifest.json');

interface PublicManifest {
  latestVersion: string | null;
  uploadedAt: string | null;
  filename: string | null;
  downloadUrl: string | null;
  installUrl: string;
  apkServerUrl: string;
  size: number | null;
}

function readManifest(): PublicManifest | null {
  try {
    const raw = readFileSync(MANIFEST_PATH, 'utf8');
    return JSON.parse(raw) as PublicManifest;
  } catch {
    return null;
  }
}

/**
 * GET /api/version
 *
 * Retorna metadados da última versão do APK publicada pelo script
 * build-android-apk.ts. Não requer autenticação. Utilizável por humano
 * e por agente.
 *
 * Resposta:
 *   200 — { code, message, data: PublicManifest, next_step }
 *   503 — { code, message, details, next_step } quando manifest indisponível
 */
export default async function handler(
  _req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  setCorsHeaders(res);

  if (_req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const manifest = readManifest();

  if (!manifest) {
    res.status(503).json({
      code: 503,
      message: 'Manifest de versão indisponível',
      details: 'Nenhum APK foi publicado ainda. Execute npm run apk:publish no relay.',
      next_step: 'Aguarde a publicação do primeiro APK ou execute build-android-apk.ts publish',
    });
    return;
  }

  res.status(200).json({
    code: 200,
    message: manifest.latestVersion
      ? `Última versão disponível: ${manifest.latestVersion}`
      : 'Nenhuma versão publicada ainda',
    data: manifest,
    next_step: manifest.latestVersion
      ? 'Compare a versão local do app com latestVersion; se diferente, oriente o usuário a baixar em installUrl'
      : 'Nenhuma ação necessária até a publicação do primeiro APK',
  });
}
