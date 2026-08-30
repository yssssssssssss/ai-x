export interface SystemCapabilitiesResponse {
  applicationVersion: string;
  build: {
    id: string;
    sourceRevision: string | null;
    builtAt: string | null;
    configurationHash: string;
  };
  planContractVersions: string[];
  multiSkillPlanWriterEnabled: boolean;
  reportV3WriterEnabled: boolean;
  reportEditorialPlannerV1Enabled: boolean;
  reportEditorialExperienceV1Enabled: boolean;
  reportEditorialShowcaseV1Enabled: boolean;
  standaloneHtmlBundleV1Enabled: boolean;
  capabilityDemandGraphVersions: string[];
  researchContributionVersions: string[];
  researchContributionArtifactVersions: string[];
  researchContributionBundleVersions: string[];
  crossSkillReviewVersions: string[];
  contributionLedgerVersions: string[];
  contributionSummaryVersions: string[];
  reportDocumentVersions: string[];
  activeTaskTypes: string[];
  activeDeliverables: string[];
  deliverableContracts: Array<{
    id: string;
    writePayloadSchema: string;
    readablePayloadSchemas: string[];
    synthesisMode: 'model_synthesis' | 'reviewed_skill_assembly';
    compositionMode: 'portfolio' | 'standalone_compat';
    synthesizerSkillId: string | null;
  }>;
  reportLayoutVersions: string[];
  compiledSkills: string[];
  knowledgeIndexHash: string | null;
  toolRegistryHash: string;
}
