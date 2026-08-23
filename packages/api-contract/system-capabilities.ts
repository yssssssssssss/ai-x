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
  compiledSkills: string[];
  knowledgeIndexHash: string | null;
  toolRegistryHash: string;
}
