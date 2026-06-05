import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SSH_PORT,
  type SshAuth,
  type SshConnectionId,
  type SshConnectionInfo,
} from '../../shared/ssh.ts';
import {
  concreteAliases,
  globMatches,
  hostBlockMatches,
  parseHostBlocks,
  type HostBlock,
} from './config-parser.ts';

export type DiscoveredSshConfigConnection = {
  readonly info: SshConnectionInfo;
  readonly auth: SshAuth;
};

export type DiscoverLocalSshConfigOptions = {
  readonly homeDir?: string;
  readonly localUsername?: string;
  readonly configPath?: string;
};

type TokenValues = {
  readonly host: string;
  readonly user: string;
  readonly port: number;
};

export function discoverLocalSshConfigConnections(
  options: DiscoverLocalSshConfigOptions = {},
): readonly DiscoveredSshConfigConnection[] {
  const homeDir = options.homeDir ?? os.homedir();
  const configPath = options.configPath ?? path.join(homeDir, '.ssh', 'config');
  if (!fs.existsSync(configPath)) return [];
  const localUsername = options.localUsername ?? defaultLocalUsername();
  const content = readConfigTree(configPath, homeDir, new Set<string>(), 0);
  return connectionsFromBlocks(parseHostBlocks(content), homeDir, localUsername);
}

function readConfigTree(
  configPath: string,
  homeDir: string,
  seen: Set<string>,
  depth: number,
): string {
  if (depth > 8) return '';
  const abs = path.resolve(configPath);
  if (seen.has(abs) || !fs.existsSync(abs)) return '';
  seen.add(abs);
  const baseDir = path.dirname(abs);
  const parts: string[] = [];
  for (const line of fs.readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const include = includePattern(line);
    if (!include) {
      parts.push(line);
      continue;
    }
    for (const included of expandInclude(include, baseDir, homeDir)) {
      parts.push(readConfigTree(included, homeDir, seen, depth + 1));
    }
  }
  return parts.join('\n');
}

function includePattern(line: string): string | null {
  const match = /^\s*include\s+(.+?)\s*(?:#.*)?$/i.exec(line);
  return match?.[1] ?? null;
}

function expandInclude(pattern: string, baseDir: string, homeDir: string): readonly string[] {
  return pattern
    .split(/\s+/)
    .flatMap((part) => expandIncludePart(part, baseDir, homeDir));
}

function expandIncludePart(part: string, baseDir: string, homeDir: string): readonly string[] {
  const expanded = expandHome(part, homeDir);
  const abs = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
  if (!/[?*]/.test(abs)) return [abs];
  const dir = path.dirname(abs);
  const pattern = path.basename(abs);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => globMatches(pattern, name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(dir, name));
}

function expandHome(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

function defaultLocalUsername(): string {
  try {
    const username = os.userInfo().username.trim();
    if (username) return username;
  } catch (err) {
    if (!(err instanceof Error)) throw err;
  }
  return process.env.USERNAME ?? process.env.USER ?? 'user';
}

function connectionsFromBlocks(
  blocks: readonly HostBlock[],
  homeDir: string,
  localUsername: string,
): readonly DiscoveredSshConfigConnection[] {
  const aliases = concreteAliases(blocks);
  return aliases.map((alias) => connectionForAlias(alias, blocks, homeDir, localUsername));
}

function connectionForAlias(
  alias: string,
  blocks: readonly HostBlock[],
  homeDir: string,
  localUsername: string,
): DiscoveredSshConfigConnection {
  const options = resolvedOptions(alias, blocks);
  const rawHost = options.get('hostname') ?? alias;
  const rawUser = options.get('user') ?? localUsername;
  const port = parsePort(options.get('port'));
  const host = expandTokens(rawHost, { host: alias, user: rawUser, port });
  const username = expandTokens(rawUser, { host, user: rawUser, port });
  const identityFile = firstUsableIdentityFile(
    options.identityFiles,
    homeDir,
    { host, user: username, port },
  );
  const auth: SshAuth = identityFile
    ? { method: 'key', privateKeyPath: identityFile }
    : { method: 'agent' };
  const info: SshConnectionInfo = {
    id: sshConfigConnectionId(alias),
    label: alias,
    host,
    port,
    username,
    authMethod: auth.method,
    source: 'ssh-config',
    connected: false,
  };
  return { info, auth };
}

function resolvedOptions(
  alias: string,
  blocks: readonly HostBlock[],
): Map<string, string> & { readonly identityFiles: readonly string[] } {
  const values = new Map<string, string>();
  const identityFiles: string[] = [];
  for (const block of blocks) {
    if (!hostBlockMatches(block.patterns, alias)) continue;
    for (const option of block.options) {
      if (option.key === 'identityfile') {
        identityFiles.push(option.value);
        continue;
      }
      if (!values.has(option.key)) values.set(option.key, option.value);
    }
  }
  return Object.assign(values, { identityFiles });
}

function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_SSH_PORT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_SSH_PORT;
  }
  return parsed;
}

function firstUsableIdentityFile(
  candidates: readonly string[],
  homeDir: string,
  tokens: TokenValues,
): string | null {
  for (const candidate of candidates) {
    const expanded = resolveIdentityFile(candidate, homeDir, tokens);
    if (isExistingFile(expanded)) return expanded;
  }
  return null;
}

function resolveIdentityFile(value: string, homeDir: string, tokens: TokenValues): string {
  const expanded = expandTokens(value, tokens);
  const tildeExpanded =
    expanded === '~'
      ? homeDir
      : expanded.startsWith('~/') || expanded.startsWith('~\\')
        ? path.join(homeDir, expanded.slice(2))
        : expanded;
  return path.isAbsolute(tildeExpanded)
    ? path.normalize(tildeExpanded)
    : path.resolve(homeDir, tildeExpanded);
}

function expandTokens(value: string, tokens: TokenValues): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch !== '%' || i + 1 >= value.length) {
      out += ch;
      continue;
    }
    const next = value[i + 1];
    i += 1;
    if (next === '%') out += '%';
    else if (next === 'h') out += tokens.host;
    else if (next === 'r') out += tokens.user;
    else if (next === 'p') out += String(tokens.port);
    else out += `%${next}`;
  }
  return out;
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch (err) {
    if (err instanceof Error) return false;
    throw err;
  }
}

function sshConfigConnectionId(alias: string): SshConnectionId {
  return `ssh-config-${Buffer.from(alias, 'utf8').toString('base64url')}`;
}
