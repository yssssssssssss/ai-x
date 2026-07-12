export interface PersonaProfile {
  id: string;
  name: string;
  type: string;
  description: string;
  goals: string[];
  concerns: string[];
}

export interface VirtualUserSimulateRequest {
  scenario?: string;
  productDescription?: string;
  artifactText?: string;
  targetUserGroups?: string[];
  personaProfiles?: PersonaProfile[];
  reviewDimensions?: string[];
}

export interface PersonaReview {
  profileId: string;
  personaName: string;
  personaType: string;
  firstImpression: string;
  detailedExperience: string;
  scores: {
    usability?: number;
    attractiveness?: number;
    trust?: number;
    conversionIntent?: number;
    emotionalResonance?: number;
  };
  overallScore: number;
  topChangeRequest: string;
  stance: 'positive' | 'mixed' | 'negative';
  isSimulated: true;
}

export interface VirtualUserSimulateResult {
  status: 'available' | 'failed' | 'insufficient_inputs';
  isSimulated: true;
  summary: string;
  digitalPersonas: PersonaProfile[];
  reviews: PersonaReview[];
  aggregate: {
    scoreSummary: Record<string, number | undefined>;
    sharedPainPoints: string[];
    sharedHighlights: string[];
    divergences: string[];
    churnRisks: string[];
  };
  recommendations: string[];
  warnings: string[];
  boundaryNotes: string[];
}
