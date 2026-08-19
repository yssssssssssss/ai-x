import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type ResolveHost = (hostname: string) => Promise<string[]>;

export class PublicWebAccessError extends Error {
  constructor(message: string, readonly safeUrl?: string) {
    super(message);
    this.name = 'PublicWebAccessError';
  }
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : null;
}

function ipv4Number(address: string): number | null {
  const octets = parseIpv4(address);
  if (!octets) return null;
  return (
    ((octets[0]! << 24) >>> 0)
    + (octets[1]! << 16)
    + (octets[2]! << 8)
    + octets[3]!
  ) >>> 0;
}

function inIpv4Cidr(address: number, base: string, prefix: number): boolean {
  const baseNumber = ipv4Number(base);
  if (baseNumber === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (baseNumber & mask);
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return false;
  const blocked: ReadonlyArray<readonly [string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.31.196.0', 24],
    ['192.52.193.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['192.175.48.0', 24],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  return !blocked.some(([base, prefix]) => inIpv4Cidr(value, base, prefix));
}

function ipv6Words(address: string): number[] | null {
  const zoneIndex = address.indexOf('%');
  const input = (zoneIndex < 0 ? address : address.slice(0, zoneIndex)).toLowerCase();
  if (input.split('::').length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const pieces = side.split(':');
    const words: number[] = [];
    for (const [index, piece] of pieces.entries()) {
      if (piece.includes('.')) {
        const ipv4 = parseIpv4(piece);
        if (!ipv4 || index !== pieces.length - 1) return null;
        words.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(piece)) return null;
        words.push(Number.parseInt(piece, 16));
      }
    }
    return words;
  };
  const [leftText, rightText] = input.split('::');
  const left = parseSide(leftText ?? '');
  const right = parseSide(rightText ?? '');
  if (!left || !right) return null;
  if (!input.includes('::')) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  return missing >= 1 ? [...left, ...Array<number>(missing).fill(0), ...right] : null;
}

function isPublicIpv6(address: string): boolean {
  const words = ipv6Words(address);
  if (!words) return false;
  const mappedIpv4 = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (mappedIpv4) {
    return isPublicIpv4(`${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`);
  }
  const first = words[0]!;
  const second = words[1]!;
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && second <= 0x01ff) return false;
  if (first === 0x2001 && second === 0x0db8) return false;
  if (first === 0x2002) return false;
  if (first === 0x3fff && (second & 0xf000) === 0) return false;
  return true;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? isPublicIpv4(address) : family === 6 ? isPublicIpv6(address) : false;
}

export async function defaultResolveHost(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map(({ address }) => address);
}

export function normalizedHostname(url: URL): string {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

export function parseHttpUrl(value: string, context: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicWebAccessError(`${context} must resolve to a valid HTTP URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PublicWebAccessError(`${context} uses a forbidden scheme; only HTTP(S) is allowed`);
  }
  if (url.username || url.password) {
    throw new PublicWebAccessError(`${context} HTTP URL must not contain credentials`);
  }
  return url;
}

const CREDENTIAL_QUERY = /(^|[_-])(token|key|signature|authorization|password|session|credential)([_-]|$)/iu;

export function parseBrowserUrl(
  value: string,
  context: string,
  options: { allowCredentialQuery?: boolean } = {},
): URL {
  const url = parseHttpUrl(value, context);
  const safeUrl = `${url.origin}${url.pathname}`;
  if (url.protocol !== 'https:') {
    throw new PublicWebAccessError(`${context} must use HTTPS`, safeUrl);
  }
  if (url.port && url.port !== '443') {
    throw new PublicWebAccessError(`${context} uses a forbidden port`, safeUrl);
  }
  if (!options.allowCredentialQuery) {
    for (const key of url.searchParams.keys()) {
      if (CREDENTIAL_QUERY.test(key)) {
        throw new PublicWebAccessError(`${context} contains a credential-like query parameter`, safeUrl);
      }
    }
  }
  url.hash = '';
  return url;
}

export async function resolvePublicTarget(url: URL, resolveHost: ResolveHost): Promise<string[]> {
  const hostname = normalizedHostname(url);
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new PublicWebAccessError(
      `HTTP target ${hostname} does not resolve exclusively to public addresses; private, loopback, link-local, reserved, and metadata addresses are forbidden`,
      `${url.origin}${url.pathname}`,
    );
  }
  return [...new Set(addresses)];
}

export async function validateBrowserTarget(
  value: string,
  resolveHost: ResolveHost = defaultResolveHost,
): Promise<URL> {
  const url = parseBrowserUrl(value, 'browser target');
  await resolvePublicTarget(url, resolveHost);
  return url;
}

export async function validateBrowserResourceTarget(
  value: string,
  resolveHost: ResolveHost = defaultResolveHost,
): Promise<URL> {
  const url = parseBrowserUrl(value, 'browser resource', { allowCredentialQuery: true });
  await resolvePublicTarget(url, resolveHost);
  return url;
}
