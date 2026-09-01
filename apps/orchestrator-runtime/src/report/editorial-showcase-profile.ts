import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { canonicalJsonBytes, hashBytes, type Sha256 } from './editorial-report-contract.ts';

export interface EditorialShowcaseProfileV1 {
  version: 'universal-editorial-showcase-profile-v1';
  id: 'universal-editorial-showcase-v1';
  viewport: { width: 1440; height: 900 };
  layout: { maxWidth: number; railWidth: number };
  colors: {
    paper: string; surface: string; ink: string; muted: string; accent: string;
    fact: string; inference: string; unknown: string; method: string;
  };
  typography: { display: string; body: string };
  principles: {
    cardWallForbidden: true;
    externalResourcesAllowed: false;
    mobileRequired: false;
    printRequired: false;
  };
}

export interface EditorialShowcaseProfileResult {
  profile: EditorialShowcaseProfileV1;
  bytes: Buffer;
  hash: Sha256;
}

export class EditorialShowcaseProfileError extends Error {
  readonly name = 'EditorialShowcaseProfileError';
  constructor(readonly code: 'SHOWCASE_PROFILE_INVALID') { super(code); }
}

function invalid(): never { throw new EditorialShowcaseProfileError('SHOWCASE_PROFILE_INVALID'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) invalid();
  return Number(value);
}
function color(value: unknown): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) invalid();
  return value.toLowerCase();
}
function fontStack(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) invalid();
  if (!/^[A-Za-z0-9 ,.'"-]+$/u.test(value)) invalid();
  return value;
}

export function loadEditorialShowcaseProfile(): EditorialShowcaseProfileResult {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(join(
      process.cwd(), 'orchestrator', 'report-presentations', 'universal-editorial-showcase-v1.yaml',
    ), 'utf8'));
  } catch {
    invalid();
  }
  const root = object(raw);
  const viewport = object(root.viewport);
  const layout = object(root.layout);
  const colors = object(root.colors);
  const typography = object(root.typography);
  const principles = object(root.principles);
  if (
    root.version !== 'universal-editorial-showcase-profile-v1'
    || root.id !== 'universal-editorial-showcase-v1'
    || viewport.width !== 1440
    || viewport.height !== 900
    || principles.card_wall_forbidden !== true
    || principles.external_resources_allowed !== false
    || principles.mobile_required !== false
    || principles.print_required !== false
  ) invalid();
  const profile: EditorialShowcaseProfileV1 = {
    version: 'universal-editorial-showcase-profile-v1',
    id: 'universal-editorial-showcase-v1',
    viewport: { width: 1440, height: 900 },
    layout: { maxWidth: number(layout.max_width), railWidth: number(layout.rail_width) },
    colors: {
      paper: color(colors.paper), surface: color(colors.surface), ink: color(colors.ink),
      muted: color(colors.muted), accent: color(colors.accent), fact: color(colors.fact),
      inference: color(colors.inference), unknown: color(colors.unknown), method: color(colors.method),
    },
    typography: { display: fontStack(typography.display), body: fontStack(typography.body) },
    principles: {
      cardWallForbidden: true, externalResourcesAllowed: false, mobileRequired: false, printRequired: false,
    },
  };
  const bytes = canonicalJsonBytes(profile);
  return { profile, bytes, hash: hashBytes(bytes) };
}
