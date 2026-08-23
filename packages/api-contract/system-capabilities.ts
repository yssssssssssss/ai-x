export interface SystemCapabilitiesResponse {
  applicationVersion: string;
  build: {
    id: string;
    sourceRevision: string | null;
    builtAt: string | null;
    configurationHash: string;
  };
  planContractVersions: string[];
  reportDocumentVersions: string[];
  activeTaskTypes: string[];
  activeDeliverables: string[];
  deliverableContracts: Array<{
    id: string;
    writePayloadSchema: string;
    readablePayloadSchemas: string[];
    synthesisMode: 'model_synthesis' | 'reviewed_skill_assembly';
  }>;
  reportLayoutVersions: string[];
  compiledSkills: string[];
  knowledgeIndexHash: string | null;
  toolRegistryHash: string;
}
