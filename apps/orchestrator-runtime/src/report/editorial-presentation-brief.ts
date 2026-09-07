import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  canonicalJsonBytes,
  hashBytes,
  type Sha256,
} from './editorial-report-contract.ts';

export const EDITORIAL_PRESENTATION_BRIEF_VERSION = 'editorial-presentation-brief-v1' as const;
export const RICH_EDITORIAL_PRESENTATION_PROFILE = 'rich-editorial-v1' as const;

export const EDITORIAL_PRESENTATION_KINDS = [
  'decision-cover',
  'metric-cards',
  'truth-triad',
  'card-grid',
  'journey-flow',
  'strategy-matrix',
  'mind-model',
  'roadmap',
  'validation-gates',
  'risk-register',
  'visual-gallery',
  'narrative',
  'audit-appendix',
] as const;

export type EditorialPresentationKindV1 = typeof EDITORIAL_PRESENTATION_KINDS[number];
export type EditorialPresentationProfile = typeof RICH_EDITORIAL_PRESENTATION_PROFILE;

export interface EditorialPresentationBriefV1 {
  version: typeof EDITORIAL_PRESENTATION_BRIEF_VERSION;
  id: EditorialPresentationProfile;
  objective: Array<
    | 'structure_clear'
    | 'content_detailed'
    | 'hierarchy_explicit'
    | 'presentation_varied'
    | 'reading_efficient'
  >;
  readingOrder: Array<'decision' | 'evidence' | 'analysis' | 'strategy' | 'actions' | 'validation' | 'risks' | 'audit'>;
  preferredPresentations: EditorialPresentationKindV1[];
  constraints: {
    maxMainSections: number;
    maxConsecutiveNarrativeBlocks: number;
    requireRiskSectionWhenEligible: boolean;
    requireAuditAppendix: boolean;
    decorativeNumbering: 'css_counter_only';
    interactiveForms: false;
  };
}

export interface EditorialPresentationBriefResult {
  brief: EditorialPresentationBriefV1;
  bytes: Buffer;
  hash: Sha256;
}

export class EditorialPresentationBriefError extends Error {
  readonly name = 'EditorialPresentationBriefError';

  constructor(readonly code:
    | 'EDITORIAL_PRESENTATION_PROFILE_UNSUPPORTED'
    | 'EDITORIAL_PRESENTATION_BRIEF_INVALID'
  ) {
    super(code);
  }
}

const EditorialObjectives = [
  'structure_clear',
  'content_detailed',
  'hierarchy_explicit',
  'presentation_varied',
  'reading_efficient',
] as const;

const OBJECTIVES = new Set<string>(EditorialObjectives);

const READING_ORDER = [
  'decision', 'evidence', 'analysis', 'strategy', 'actions', 'validation', 'risks', 'audit',
] as const;

function invalid(): never {
  throw new EditorialPresentationBriefError('EDITORIAL_PRESENTATION_BRIEF_INVALID');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) invalid();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) invalid();
  if (new Set(value).size !== value.length) invalid();
  return [...value];
}

function parseBrief(value: unknown): EditorialPresentationBriefV1 {
  const item = record(value);
  exactKeys(item, ['version', 'id', 'objective', 'reading_order', 'preferred_presentations', 'constraints']);
  const objective = stringArray(item.objective);
  const readingOrder = stringArray(item.reading_order);
  const preferredPresentations = stringArray(item.preferred_presentations);
  const constraints = record(item.constraints);
  exactKeys(constraints, [
    'max_main_sections',
    'max_consecutive_narrative_blocks',
    'require_risk_section_when_eligible',
    'require_audit_appendix',
    'decorative_numbering',
    'interactive_forms',
  ]);
  if (
    item.version !== EDITORIAL_PRESENTATION_BRIEF_VERSION
    || item.id !== RICH_EDITORIAL_PRESENTATION_PROFILE
    || objective.length !== EditorialObjectives.length
    || objective.some((entry) => !OBJECTIVES.has(entry as typeof EditorialObjectives[number]))
    || readingOrder.length !== READING_ORDER.length
    || readingOrder.some((entry) => !(READING_ORDER as readonly string[]).includes(entry))
    || preferredPresentations.length < 1
    || preferredPresentations.some((entry) => !(EDITORIAL_PRESENTATION_KINDS as readonly string[]).includes(entry))
    || !Number.isSafeInteger(constraints.max_main_sections)
    || Number(constraints.max_main_sections) < 1
    || Number(constraints.max_main_sections) > 24
    || !Number.isSafeInteger(constraints.max_consecutive_narrative_blocks)
    || Number(constraints.max_consecutive_narrative_blocks) < 0
    || Number(constraints.max_consecutive_narrative_blocks) > 8
    || typeof constraints.require_risk_section_when_eligible !== 'boolean'
    || typeof constraints.require_audit_appendix !== 'boolean'
    || constraints.decorative_numbering !== 'css_counter_only'
    || constraints.interactive_forms !== false
  ) invalid();
  return {
    version: EDITORIAL_PRESENTATION_BRIEF_VERSION,
    id: RICH_EDITORIAL_PRESENTATION_PROFILE,
    objective: objective as EditorialPresentationBriefV1['objective'],
    readingOrder: readingOrder as EditorialPresentationBriefV1['readingOrder'],
    preferredPresentations: preferredPresentations as EditorialPresentationKindV1[],
    constraints: {
      maxMainSections: Number(constraints.max_main_sections),
      maxConsecutiveNarrativeBlocks: Number(constraints.max_consecutive_narrative_blocks),
      requireRiskSectionWhenEligible: constraints.require_risk_section_when_eligible as boolean,
      requireAuditAppendix: constraints.require_audit_appendix as boolean,
      decorativeNumbering: 'css_counter_only',
      interactiveForms: false,
    },
  };
}

export function loadEditorialPresentationBrief(
  profile: string = RICH_EDITORIAL_PRESENTATION_PROFILE,
): EditorialPresentationBriefResult {
  if (profile !== RICH_EDITORIAL_PRESENTATION_PROFILE) {
    throw new EditorialPresentationBriefError('EDITORIAL_PRESENTATION_PROFILE_UNSUPPORTED');
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(
      join(process.cwd(), 'orchestrator', 'report-presentations', `${profile}.yaml`),
      'utf8',
    ));
  } catch (error) {
    if (error instanceof EditorialPresentationBriefError) throw error;
    invalid();
  }
  const brief = parseBrief(parsed);
  const bytes = canonicalJsonBytes(brief);
  return { brief, bytes, hash: hashBytes(bytes) };
}
