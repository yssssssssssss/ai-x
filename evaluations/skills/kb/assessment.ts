import type { KnowledgeContext, RetrievalRecord } from './types.ts';

export interface KBAssessment {
  skill_id: string;
  mode: 'gold' | 'live';
  required_sources_available: boolean;
  required_source_ids: string[];
  selected_source_ids: string[];
  missing_required_source_ids: string[];
  cited_source_ids: string[];
  unsupported_canonical_claims: string[];
  draft_sources_used: string[];
  retrieval_recall: number | null;
  kb_grounding_verdict: 'pass' | 'needs_review' | 'fail' | 'not_applicable';
  status_warnings: string[];
  review_notes: string[];
}

const SOURCE_PATH_MARKER = /source_path\s*[:=]\s*\[?([A-Za-z0-9_./:-]+)/gi;
const SOURCE_MARKER = /(?:source_id|sources?|citations?)\s*[:=]\s*\[?([A-Za-z0-9_./:-]+)/gi;
const BRACKET_SOURCE_MARKER = /\[(?:source|citation)\s*[:=]\s*([^\]]+)\]/gi;

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === null || output === undefined) return '';
  return JSON.stringify(output);
}

function cleanMarker(value: string): string {
  return value.trim().replace(/^["'`]+|["'`,.;)\]]+$/g, '');
}

function extractMatches(text: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const raw = match[1] ?? '';
    for (const part of raw.split(/[,\s]+/)) {
      const cleaned = cleanMarker(part);
      if (cleaned) matches.push(cleaned);
    }
  }
  return matches;
}

function addExplicitCitation(
  value: unknown,
  sourceIds: Set<string>,
  sourcePathToId: Map<string, string>,
  cited: string[],
  unsupported: string[],
): void {
  if (typeof value !== 'string') return;
  if (sourceIds.has(value)) cited.push(value);
  else if (sourcePathToId.has(value)) cited.push(sourcePathToId.get(value)!);
  else unsupported.push(value);
}

function addSourcePathCitation(
  value: unknown,
  sourcePathToId: Map<string, string>,
  cited: string[],
  unsupported: string[],
): void {
  if (typeof value !== 'string') return;
  const sourceId = sourcePathToId.get(value);
  if (sourceId) cited.push(sourceId);
  else unsupported.push(value);
}

function collectStructuredCitations(
  value: unknown,
  sourceIds: Set<string>,
  sourcePathToId: Map<string, string>,
  cited: string[],
  unsupported: string[],
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStructuredCitations(entry, sourceIds, sourcePathToId, cited, unsupported);
    }
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (key === 'source_id') {
      addExplicitCitation(entry, sourceIds, sourcePathToId, cited, unsupported);
    } else if (key === 'source_path') {
      addSourcePathCitation(entry, sourcePathToId, cited, unsupported);
    } else if (key === 'source_ids' || key === 'sources' || key === 'citations') {
      const entries = Array.isArray(entry) ? entry : [entry];
      for (const citation of entries) {
        if (typeof citation === 'string') {
          addExplicitCitation(citation, sourceIds, sourcePathToId, cited, unsupported);
        } else {
          collectStructuredCitations(citation, sourceIds, sourcePathToId, cited, unsupported);
        }
      }
    } else {
      collectStructuredCitations(entry, sourceIds, sourcePathToId, cited, unsupported);
    }
  }
}

function extractCitedSourceIds(
  output: unknown,
  sourceIds: Set<string>,
  sourcePathToId: Map<string, string>,
): { cited: string[]; unsupported: string[] } {
  const text = outputText(output);
  const cited: string[] = [];
  const unsupported: string[] = [];
  collectStructuredCitations(output, sourceIds, sourcePathToId, cited, unsupported);
  for (const sourceId of extractMatches(text, SOURCE_MARKER)) {
    addExplicitCitation(sourceId, sourceIds, sourcePathToId, cited, unsupported);
  }
  for (const sourcePath of extractMatches(text, SOURCE_PATH_MARKER)) {
    addSourcePathCitation(sourcePath, sourcePathToId, cited, unsupported);
  }
  return { cited: unique(cited), unsupported: unique(unsupported) };
}

export function assessKnowledgeUsage(
  skillId: string,
  context: KnowledgeContext,
  retrieval: RetrievalRecord,
  generatedOutput: unknown,
): KBAssessment {
  const requiredSourceIds = [...context.required_source_ids];
  const selectedSourceIds = [...context.selected_source_ids];
  const missingRequiredSourceIds = unique([
    ...retrieval.missing_required_source_ids,
    ...requiredSourceIds.filter((sourceId) => !selectedSourceIds.includes(sourceId)),
  ]);
  const sourceIds = new Set(context.items.map((item) => item.source_id));
  const sourcePathToId = new Map(
    context.items.map((item) => [item.source_path, item.source_id] as const),
  );
  const { cited, unsupported } = extractCitedSourceIds(
    generatedOutput,
    sourceIds,
    sourcePathToId,
  );
  const citedSet = new Set(cited);
  const draftSourcesUsed = context.items
    .filter((item) => item.status === 'draft' && citedSet.has(item.source_id))
    .map((item) => item.source_id);
  const statusWarnings = draftSourcesUsed.map(
    (sourceId) => `draft source used: ${sourceId}`,
  );
  const reviewNotes: string[] = [];
  const requiredSourcesAvailable = missingRequiredSourceIds.length === 0;
  let verdict: KBAssessment['kb_grounding_verdict'] = 'pass';

  if (requiredSourceIds.length === 0 && selectedSourceIds.length === 0) {
    verdict = 'not_applicable';
  } else if (!requiredSourcesAvailable || unsupported.length > 0) {
    verdict = 'fail';
  } else {
    const uncitedRequired = requiredSourceIds.filter(
      (sourceId) => !citedSet.has(sourceId),
    );
    if (cited.length === 0 || uncitedRequired.length > 0) {
      verdict = 'needs_review';
      reviewNotes.push('required source citation coverage incomplete');
    }
    if (retrieval.unresolved_items.length > 0) {
      verdict = 'needs_review';
      reviewNotes.push(...retrieval.unresolved_items.map((item) => `unresolved retrieval item: ${item}`));
    }
  }

  return {
    skill_id: skillId,
    mode: context.mode,
    required_sources_available: requiredSourcesAvailable,
    required_source_ids: requiredSourceIds,
    selected_source_ids: selectedSourceIds,
    missing_required_source_ids: missingRequiredSourceIds,
    cited_source_ids: cited,
    unsupported_canonical_claims: unsupported,
    draft_sources_used: draftSourcesUsed,
    retrieval_recall: retrieval.required_source_recall,
    kb_grounding_verdict: verdict,
    status_warnings: statusWarnings,
    review_notes: reviewNotes,
  };
}
