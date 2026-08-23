export interface SystemCapabilitiesResponse {
  applicationVersion: string;
  planContractVersions: string[];
  reportDocumentVersions: string[];
  activeTaskTypes: string[];
  activeDeliverables: string[];
  compiledSkills: string[];
  knowledgeIndexHash: string | null;
  toolRegistryHash: string;
}
