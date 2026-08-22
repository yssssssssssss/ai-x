import { getEntry, loadRuntimeKnowledgeIndex } from './index.ts';
import type { KnowledgeStatus } from './indexer.ts';
import { SchemaValidator } from '../schema/validator.ts';

export interface FrozenKnowledgeReference {
  resourceId: string;
  sourcePath: string;
  status: 'approved' | 'draft';
  contentHash: string;
  required: boolean;
  failurePolicy: 'block' | 'gap';
}

export interface KnowledgeBundle {
  version: 'knowledge-bundle-v1';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  stepNo: number;
  contractHash: string;
  resources: Array<{
    id: string;
    title: string;
    status: 'approved' | 'draft';
    sourcePath: string;
    contentHash: string;
    content: string;
  }>;
}

export interface KnowledgeResolutionGap {
  key: string;
  message: string;
}

export class RequiredKnowledgeUnavailableError extends Error {
  constructor(
    readonly resourceId: string,
    readonly reason: string,
  ) {
    super(`required knowledge ${resourceId} is unavailable: ${reason}`);
    this.name = 'RequiredKnowledgeUnavailableError';
  }
}

function unavailable(
  reference: FrozenKnowledgeReference,
  reason: string,
): { gap: KnowledgeResolutionGap } {
  if (reference.required || reference.failurePolicy === 'block') {
    throw new RequiredKnowledgeUnavailableError(reference.resourceId, reason);
  }
  return {
    gap: {
      key: `knowledge:${reference.resourceId}:unavailable`,
      message: `Optional knowledge ${reference.resourceId} is unavailable: ${reason}`,
    },
  };
}

function runtimeStatus(value: KnowledgeStatus): 'approved' | 'draft' | null {
  return value === 'approved' || value === 'draft' ? value : null;
}

export class KnowledgeBundleResolver {
  constructor(private readonly validator = new SchemaValidator()) {}

  resolve(input: {
    taskId: string;
    planVersionId: string;
    attemptId: string;
    stepNo: number;
    contractHash: string;
    references: readonly FrozenKnowledgeReference[];
  }): { bundle: KnowledgeBundle; gaps: KnowledgeResolutionGap[] } {
    const index = new Map(loadRuntimeKnowledgeIndex().map((item) => [item.id, item]));
    const resources: KnowledgeBundle['resources'] = [];
    const gaps: KnowledgeResolutionGap[] = [];
    const seen = new Set<string>();

    for (const reference of input.references) {
      if (seen.has(reference.resourceId)) {
        throw new Error(`duplicate frozen knowledge reference ${reference.resourceId}`);
      }
      seen.add(reference.resourceId);
      const item = index.get(reference.resourceId);
      if (!item) {
        gaps.push(unavailable(reference, 'not present in the runtime knowledge index').gap);
        continue;
      }
      const status = runtimeStatus(item.status);
      if (!status || status !== reference.status) {
        gaps.push(unavailable(reference, `status drifted from ${reference.status} to ${item.status}`).gap);
        continue;
      }
      if (item.source_path !== reference.sourcePath) {
        gaps.push(unavailable(reference, 'source path drifted after plan confirmation').gap);
        continue;
      }
      if (item.content_hash !== reference.contentHash) {
        gaps.push(unavailable(reference, 'content hash drifted after plan confirmation').gap);
        continue;
      }
      const entry = getEntry(reference.resourceId);
      if (!entry) {
        gaps.push(unavailable(reference, 'source content is missing').gap);
        continue;
      }
      resources.push({
        id: item.id,
        title: item.title,
        status,
        sourcePath: item.source_path,
        contentHash: item.content_hash,
        content: entry.content,
      });
    }

    const bundle: KnowledgeBundle = {
      version: 'knowledge-bundle-v1',
      taskId: input.taskId,
      planVersionId: input.planVersionId,
      attemptId: input.attemptId,
      stepNo: input.stepNo,
      contractHash: input.contractHash,
      resources,
    };
    this.validator.validateOrThrow('knowledge-bundle', bundle);
    return { bundle, gaps };
  }
}
