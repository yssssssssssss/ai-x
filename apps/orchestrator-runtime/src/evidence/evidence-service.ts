import { createHash } from 'node:crypto';

export type EvidenceClass = 'public_source' | 'screenshot' | 'user_input' | 'knowledge' | 'simulation' | 'derived';
export type EvidenceKind = 'tool_output' | 'knowledge_excerpt' | 'user_constraint' | 'screenshot';

export interface ToolProof {
  implementationId: string;
  executionMode: 'real' | 'fake' | 'unknown';
  outputHash: string;
}

export interface EvidenceEntry {
  id: string;
  kind: EvidenceKind;
  evidenceClass: EvidenceClass;
  artifactHash: string;
  jsonPointer: string;
  sourceUrl?: string;
  stepNo?: number;
  toolProof?: ToolProof;
  sensitivity: 'public' | 'internal' | 'sensitive';
  redaction: 'none' | 'masked' | 'blocked';
}

export interface EvidenceManifest {
  version: 'evidence-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  collectedAt: string;
  manifestHash: string;
  entries: EvidenceEntry[];
}

export interface FactFinding {
  id: string;
  kind: 'fact';
  evidenceIds: string[];
  statement: string;
}

export interface InferenceFinding {
  id: string;
  kind: 'inference';
  findingIds: string[];
  statement: string;
}

export interface AnalysisNode {
  id: string;
  findingIds: string[];
  statement: string;
}

export interface SummaryNode {
  id: string;
  findingIds: string[];
  analysisIds: string[];
  summary: string;
}

export interface ConclusionNode {
  id: string;
  summaryIds: string[];
  statement: string;
}

export interface FindingGraph {
  findings: Array<FactFinding | InferenceFinding>;
  analyses: AnalysisNode[];
  subQuestionSummaries: SummaryNode[];
  overallConclusions: ConclusionNode[];
}

export class EvidenceGraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceGraphValidationError';
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
}

function requireId(value: string, label: string): void {
  if (!value.trim()) throw new EvidenceGraphValidationError(`${label} is required`);
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new EvidenceGraphValidationError(`${label} contains duplicate ids`);
}

function pointer(value: string): void {
  if (!value.startsWith('/')) throw new EvidenceGraphValidationError(`invalid JSON pointer ${value}`);
}

export interface EvidenceOutputResolver {
  resolveOutput(artifactHash: string): unknown | null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolvePointer(value: unknown, jsonPointer: string): unknown | undefined {
  const segments = jsonPointer.slice(1).split('/').map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!isUnknownRecord(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

export class EvidenceService {
  createManifest(input: Omit<EvidenceManifest, 'version' | 'manifestHash'>): EvidenceManifest {
    const draft = { version: 'evidence-v1' as const, ...input };
    const manifest = { ...draft, manifestHash: hash(draft) };
    this.validateManifest(manifest);
    return manifest;
  }

  validateManifest(manifest: EvidenceManifest, resolver?: EvidenceOutputResolver): void {
    requireId(manifest.taskId, 'taskId');
    requireId(manifest.planVersionId, 'planVersionId');
    requireId(manifest.attemptId, 'attemptId');
    if (Number.isNaN(new Date(manifest.collectedAt).getTime())) {
      throw new EvidenceGraphValidationError('collectedAt is invalid');
    }
    unique(manifest.entries.map((entry) => entry.id), 'evidence manifest');
    for (const entry of manifest.entries) {
      requireId(entry.id, 'evidence id');
      pointer(entry.jsonPointer);
      if (!entry.artifactHash.startsWith('sha256:')) {
        throw new EvidenceGraphValidationError(`evidence ${entry.id} has invalid artifact hash`);
      }
      if (entry.evidenceClass === 'public_source') {
        if (!entry.sourceUrl?.startsWith('https://')) {
          throw new EvidenceGraphValidationError(`public evidence ${entry.id} requires an https source URL`);
        }
        if (!entry.toolProof || entry.toolProof.executionMode !== 'real' || entry.toolProof.implementationId === 'unknown') {
          throw new EvidenceGraphValidationError(`public evidence ${entry.id} requires a real Tool proof`);
        }
        if (entry.toolProof.outputHash !== entry.artifactHash) {
          throw new EvidenceGraphValidationError(`public evidence ${entry.id} output hash does not match artifact hash`);
        }
      }
      if (resolver) {
        const output = resolver.resolveOutput(entry.artifactHash);
        if (output === null || resolvePointer(output, entry.jsonPointer) === undefined) {
          throw new EvidenceGraphValidationError(`evidence ${entry.id} pointer does not resolve`);
        }
      }
    }
  }

  validateFindingGraph(input: { manifest: EvidenceManifest; graph: FindingGraph }): void {
    this.validateManifest(input.manifest);
    const evidence = new Map(input.manifest.entries.map((entry) => [entry.id, entry]));
    const findingIds = input.graph.findings.map((finding) => finding.id);
    unique(findingIds, 'findings');
    const findings = new Map(input.graph.findings.map((finding) => [finding.id, finding]));

    const visit = (id: string, visiting = new Set<string>(), visited = new Set<string>()): boolean => {
      if (visited.has(id)) return true;
      if (visiting.has(id)) throw new EvidenceGraphValidationError(`inference cycle at ${id}`);
      const finding = findings.get(id);
      if (!finding) throw new EvidenceGraphValidationError(`unknown finding ${id}`);
      if (finding.kind === 'fact') {
        if (finding.evidenceIds.length === 0) throw new EvidenceGraphValidationError(`fact ${id} has no evidence`);
        for (const evidenceId of finding.evidenceIds) {
          const entry = evidence.get(evidenceId);
          if (!entry) throw new EvidenceGraphValidationError(`fact ${id} references unknown evidence ${evidenceId}`);
          if (entry.evidenceClass !== 'public_source' && entry.evidenceClass !== 'screenshot') {
            throw new EvidenceGraphValidationError(`fact ${id} is rooted in non-factual evidence ${evidenceId}`);
          }
        }
        visited.add(id);
        return true;
      }
      if (finding.findingIds.length === 0) throw new EvidenceGraphValidationError(`inference ${id} has no supporting findings`);
      visiting.add(id);
      for (const parent of finding.findingIds) visit(parent, visiting, visited);
      visiting.delete(id);
      visited.add(id);
      return true;
    };

    for (const finding of input.graph.findings) visit(finding.id);
    const analyses = new Set(input.graph.analyses.map((analysis) => analysis.id));
    unique([...analyses], 'analyses');
    for (const analysis of input.graph.analyses) {
      if (analysis.findingIds.length === 0) throw new EvidenceGraphValidationError(`analysis ${analysis.id} has no findings`);
      analysis.findingIds.forEach((id) => visit(id));
    }
    const summaries = new Set(input.graph.subQuestionSummaries.map((summary) => summary.id));
    unique([...summaries], 'summaries');
    for (const summary of input.graph.subQuestionSummaries) {
      if (summary.findingIds.length + summary.analysisIds.length === 0) {
        throw new EvidenceGraphValidationError(`summary ${summary.id} has no roots`);
      }
      summary.findingIds.forEach((id) => visit(id));
      summary.analysisIds.forEach((id) => {
        if (!analyses.has(id)) throw new EvidenceGraphValidationError(`summary ${summary.id} references unknown analysis ${id}`);
      });
    }
    for (const conclusion of input.graph.overallConclusions) {
      if (conclusion.summaryIds.length === 0) throw new EvidenceGraphValidationError(`conclusion ${conclusion.id} has no summary roots`);
      conclusion.summaryIds.forEach((id) => {
        if (!summaries.has(id)) throw new EvidenceGraphValidationError(`conclusion ${conclusion.id} references unknown summary ${id}`);
      });
    }
  }
}
