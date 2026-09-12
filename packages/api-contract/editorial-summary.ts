export interface EditorialSummaryModelCallV1 {
  stage: 'editorial_summary_plan' | 'editorial_summary_html' | 'editorial_summary_fidelity' | 'editorial_summary_repair';
  modelName: string;
  modelVersion: string;
  traceId: string;
  promptHash: string;
  receiptId?: string;
  responseHash: string;
}

export interface EditorialSummaryManifestV1 {
  version: 'editorial-summary-publication-v1';
  authority: 'derived';
  status: 'ready';
  generationMode: 'llm_html';
  taskId: string;
  planVersionId: string;
  attemptId: string;
  requestKey: string;
  publicationId: string;
  sourceReportPackage: {
    artifactId: string;
    kind: string;
    schemaVersion: string;
    contentSha256: string;
  };
  sourceHash: string;
  planHash: string;
  htmlHash: string;
  validationHash: string;
  fidelityHash: string;
  modelCalls: EditorialSummaryModelCallV1[];
  generatedAt: string;
}
