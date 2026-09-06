export interface SystemCapabilitiesResponse {
  applicationVersion: string;
  build: {
    id: string;
    sourceRevision: string | null;
    builtAt: string | null;
    configurationHash: string;
  };
  planContractVersion: string;
  skillPackages: string[];
  unavailableSkillPackages: number;
  toolRegistryHash: string;
  sandboxAvailable: boolean;
  zeroPublicationEnabled: boolean;
}
