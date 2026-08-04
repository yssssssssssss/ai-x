export type KBMode = 'none' | 'gold' | 'live';

export interface KnowledgeSourceRule {
  path: string;
  role: 'standard' | 'method' | 'model' | 'asset' | 'template' | 'one_of';
  trigger?: string;
  status?: string;
}

export interface SkillKnowledgeMapping {
  skill_id: string;
  kb_mode: 'required' | 'not_applicable' | 'manual_review';
  required_sources: KnowledgeSourceRule[];
  conditional_sources: KnowledgeSourceRule[];
  optional_sources: KnowledgeSourceRule[];
  retrieval_tags: string[];
  source_status_policy: 'draft_allowed_with_warning' | 'reviewed_required' | 'not_applicable';
  unresolved_items: string[];
}

export interface KnowledgeIndexItem {
  id: string;
  type?: string;
  title?: string;
  source_path: string;
  content_hash?: string;
  status: string;
  [key: string]: unknown;
}

export interface KnowledgeSnapshot {
  snapshot_id: string;
  index_path: string;
  index_hash: string;
  built_at: string;
  source_files: Array<{ path: string; content_hash: string; status: string }>;
}

export interface GoldSourceSelection {
  skill_id: string;
  mode: 'gold' | 'not_applicable' | 'manual_review';
  selected_source_ids: string[];
  unresolved_items: string[];
}

export interface KnowledgeSnapshotResult {
  snapshot: KnowledgeSnapshot;
  index: Map<string, KnowledgeIndexItem>;
  warnings: string[];
}
