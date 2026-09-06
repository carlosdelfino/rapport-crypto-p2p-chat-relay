import { existsSync, readFileSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';

export interface JavaInstallation {
  javaHome: string;
  version: string;
}

export interface AndroidToolchainEnvironment {
  androidHome: string;
  javaHome: string;
  nodeBinDirectory: string;
  nvmDir: string;
  home: string;
}

export type BuildProcessEnvironment = Omit<NodeJS.ProcessEnv, 'NODE_ENV'> & {
  NODE_ENV: 'production' | 'development' | 'test';
};

export interface AndroidInstallCreditGuidance {
  whatsappDisplay: string;
  whatsappUrl: string;
  pixCnpj: string;
  businessDayReleaseHours: number;
  weekendCustomerFee: string;
  firstExchangeFee: string;
  cczToBrlRate: string;
  /**
   * Taxa cobrada de clientes que já fazem uso recorrente do aplicativo
   * quando optam por pagar o câmbio via PIX.
   */
  pixRecurrentCustomerFee: string;
  /**
   * Canal pelo qual clientes em fase inicial/experimental devem solicitar
   * o boleto para o câmbio (em vez de usar PIX).
   */
  boletoExperimentalChannel: string;
}

export const ANDROID_INSTALL_CREDIT_GUIDANCE: Readonly<AndroidInstallCreditGuidance> = Object.freeze({
  whatsappDisplay: '(+55 85) 98520-5490',
  whatsappUrl: 'https://wa.me/5585985205490',
  pixCnpj: '67.904.299/0001-80',
  businessDayReleaseHours: 24,
  weekendCustomerFee: 'R$ 10,00',
  firstExchangeFee: 'R$ 20,00',
  cczToBrlRate: '1 CCZ = R$ 1,00',
  pixRecurrentCustomerFee: 'R$ 5,00',
  boletoExperimentalChannel: 'WhatsApp',
});

function readJavaVersion(javaHome: string): string {
  const releasePath = path.join(javaHome, 'release');
  if (!existsSync(releasePath)) {
    throw new Error(`release do Java nao encontrado em ${releasePath}`);
  }
  const release = readFileSync(releasePath, 'utf8');
  const match = release.match(/^JAVA_VERSION="([^\"]+)"/m);
  if (!match?.[1]) {
    throw new Error(`versao do Java nao identificada em ${releasePath}`);
  }
  return match[1];
}

export function validateJavaHome(candidate: string): JavaInstallation {
  const javaHome = path.resolve(candidate);
  if (!existsSync(javaHome)) {
    throw new Error(`JAVA_HOME invalido: diretorio nao existe (${javaHome})`);
  }
  if (!existsSync(path.join(javaHome, 'bin', 'java'))) {
    throw new Error(`JAVA_HOME invalido: java nao encontrado (${javaHome})`);
  }
  if (!existsSync(path.join(javaHome, 'bin', 'javac'))) {
    throw new Error(`JAVA_HOME invalido: javac nao encontrado; instale o JDK completo (${javaHome})`);
  }
  const version = readJavaVersion(javaHome);
  if (Number.parseInt(version, 10) !== 21) {
    throw new Error(`Java 21 obrigatorio; versao encontrada: ${version}`);
  }
  return { javaHome, version };
}

export function resolveJavaHome(
  explicitJavaHome: string | undefined,
  candidates: string[],
): JavaInstallation {
  const failures: string[] = [];
  if (explicitJavaHome) {
    try {
      return validateJavaHome(explicitJavaHome);
    } catch (error) {
      failures.push(`JAVA_HOME explicito invalido: ${(error as Error).message}`);
    }
  }
  for (const candidate of candidates) {
    try {
      return validateJavaHome(candidate);
    } catch (error) {
      failures.push((error as Error).message);
    }
  }
  throw new Error(
    `JDK 21 completo nao encontrado. Instale openjdk-21-jdk ou defina JAVA_HOME. Detalhes: ${failures.join('; ')}`,
  );
}

export function loadDappEnvironment(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) {
    throw new Error(`Arquivo de ambiente do dApp nao encontrado: ${envPath}`);
  }
  return dotenv.parse(readFileSync(envPath));
}

export function composeBuildEnvironment(
  inheritedEnvironment: Readonly<Record<string, string | undefined>>,
  dappEnvironment: Record<string, string>,
  toolchain: AndroidToolchainEnvironment,
): BuildProcessEnvironment {
  const inheritedNodeEnvironment = inheritedEnvironment.NODE_ENV;
  const nodeEnvironment =
    inheritedNodeEnvironment === 'development' ||
    inheritedNodeEnvironment === 'test' ||
    inheritedNodeEnvironment === 'production'
      ? inheritedNodeEnvironment
      : 'production';
  return {
    ...inheritedEnvironment,
    ...dappEnvironment,
    NODE_ENV: nodeEnvironment,
    ANDROID_HOME: toolchain.androidHome,
    ANDROID_SDK_ROOT: toolchain.androidHome,
    JAVA_HOME: toolchain.javaHome,
    NVM_DIR: toolchain.nvmDir,
    HOME: toolchain.home,
    PATH: `${toolchain.nodeBinDirectory}:${inheritedEnvironment.PATH ?? ''}`,
    GRADLE_OPTS:
      inheritedEnvironment.GRADLE_OPTS ??
      '-Dorg.gradle.jvmargs="-Xmx3072m -XX:MaxMetaspaceSize=1536m -Dfile.encoding=UTF-8"',
  };
}
