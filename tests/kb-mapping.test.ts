import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigRoot, loadSkillRegistry, setConfigRoot, type SkillRegistryEntry } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import {
  loadSkillKnowledgeMappings,
  loadGoldSourceSelections,
} from '../evaluations/skills/kb/snapshot.ts';
const activeSkillFixture: SkillRegistryEntry = {
  id: 'alpha',
  name: 'Alpha',
  path: 'skills/alpha',
  when_to_use: 'Test fixture',
  owner: 'test',
  status: 'active',
  risk_level: 'low',
};


test('loads exactly 22 mappings in active registry order', () => {
  const activeSkills = loadSkillRegistry().skills.filter((skill) => skill.status === 'active');
  const mappings = loadSkillKnowledgeMappings(activeSkills);
  assert.equal(mappings.size, 22);
  assert.deepEqual([...mappings.keys()], activeSkills.map((skill) => skill.id));
  assert.equal(mappings.get('competitive-web-research')?.kb_mode, 'not_applicable');
  assert.equal((mappings.get('generate-survey')?.required_sources.length ?? 0) > 0, true);
});

test('preserves source role, status policy, one-of semantics, and unresolved paths', () => {
  const activeSkills = loadSkillRegistry().skills.filter((skill) => skill.status === 'active');
  const mappings = loadSkillKnowledgeMappings(activeSkills);
  const survey = mappings.get('generate-survey')!;
  assert.equal(survey.source_status_policy, 'draft_allowed_with_warning');
  assert.ok(survey.required_sources.every((source) => source.role));
  const transcript = mappings.get('structure-interview-transcript')!;
  assert.ok(transcript.required_sources.some((source) => source.role === 'one_of'));
  assert.deepEqual(transcript.required_sources.map((source) => source.path), ['methods/toolbox/collection/interview-guide-design.md', 'methods/toolbox/analysis/affinity-diagram.md', 'models/orid.md', 'methods/toolbox/analysis/qualitative-insight-frameworks.md']);
  const competitive = mappings.get('competitive-analysis')!;
  assert.ok(competitive.unresolved_items.some((item) => item.includes('models/aarrr.md')));
  assert.ok(mappings.get('conversion-funnel-analysis')!.unresolved_items.some((item) => item.includes('models/fogg-behavior-model.md')));
  assert.ok(mappings.get('analyze-satisfaction')!.unresolved_items.some((item) => item.includes('methods/toolbox/analysis/ipa-matrix.md')));
  assert.ok(mappings.get('generate-interview-guide')!.unresolved_items.some((item) => item.includes('<主题>') || item.includes('<业务线>')));
  assert.ok(competitive.required_sources.some((source) => source.path === 'models/kano.md'));
  assert.ok(competitive.unresolved_items.some((item) => item.includes('kano') && item.includes('contradiction')));
});

test('rejects unknown and missing mapping IDs', () => {
  const activeSkills: SkillRegistryEntry[] = [activeSkillFixture];
  const dir = mkdtempSync(join('/tmp', 'kb-mapping-'));
  const unknownPath = join(dir, 'unknown.json');
  writeFileSync(unknownPath, JSON.stringify([{ skill_id: 'ghost', kb_mode: 'not_applicable', required_sources: [], conditional_sources: [], optional_sources: [], retrieval_tags: [], source_status_policy: 'not_applicable', unresolved_items: [] }]));
  assert.throws(() => loadSkillKnowledgeMappings(activeSkills, unknownPath), /unknown skill/);
  const missingPath = join(dir, 'missing.json');
  writeFileSync(missingPath, JSON.stringify([]));
  assert.throws(() => loadSkillKnowledgeMappings(activeSkills, missingPath), /missing mapping/);
});

test('gold selections cover every Skill and keep native selections empty', () => {
  const activeSkills = loadSkillRegistry().skills.filter((skill) => skill.status === 'active');
  const selections = loadGoldSourceSelections(activeSkills);
  assert.equal(selections.size, activeSkills.length);
  assert.deepEqual(selections.get('competitive-web-research')?.selected_source_ids, []);
  assert.equal(selections.get('competitive-web-research')?.mode, 'not_applicable');
  assert.ok(selections.get('generate-survey')?.selected_source_ids.length);
  assert.deepEqual(selections.get('structure-interview-transcript')?.selected_source_ids, ['toolbox_collection_interview_guide_design', 'toolbox_analysis_affinity_diagram', 'model_orid']);
});

test('gold selections preserve unresolved items and current case triggers', () => {
  const activeSkills = loadSkillRegistry().skills.filter((skill) => skill.status === 'active');
  const mappings = loadSkillKnowledgeMappings(activeSkills);
  const selections = loadGoldSourceSelections(activeSkills);
  for (const [skillId, mapping] of mappings) {
    assert.deepEqual(selections.get(skillId)?.unresolved_items, mapping.unresolved_items);
  }
  assert.ok(selections.get('generate-interview-guide')?.selected_source_ids.includes('toolbox_collection_interviews'));
  assert.ok(selections.get('generate-persona')?.selected_source_ids.includes('toolbox_collection_interviews'));
  assert.ok(selections.get('generate-research-plan')?.selected_source_ids.includes('standard_sampling'));
  assert.ok(selections.get('issue-prioritization')?.selected_source_ids.includes('path:assets/playbooks/priority-frameworks-overview.md'));
  assert.ok(selections.get('issue-prioritization')?.selected_source_ids.includes('toolbox_analysis_priority_quadrant_method'));
  assert.ok(selections.get('journey-map')?.selected_source_ids.includes('toolbox_collection_interviews'));
  assert.ok(!selections.get('generate-survey')?.selected_source_ids.includes('path:assets/scales/standardized-ux-scales.md'));
  assert.ok(mappings.get('digital-human-competitive-analysis')?.unresolved_items.some((item) => item.includes('competitive-research-method.md')));
});

test('rejects duplicate and unresolvable gold source selections', () => {
  const activeSkills = loadSkillRegistry().skills.filter((skill) => skill.status === 'active');
  const dir = mkdtempSync(join('/tmp', 'kb-gold-'));
  const selections = JSON.parse(readFileSync(join(process.cwd(), 'evaluations/skills/kb/gold-source-selections.json'), 'utf8')) as unknown[];
  writeFileSync(join(dir, 'duplicate.json'), JSON.stringify([...selections, selections[0]]));
  assert.throws(() => loadGoldSourceSelections(activeSkills, join(dir, 'duplicate.json')), /duplicate gold selection/);
  const invalid = (selections as Array<Record<string, unknown>>).map((selection) => ({ ...selection, selected_source_ids: selection.skill_id === 'generate-survey' ? ['ghost-source'] : selection.selected_source_ids }));
  writeFileSync(join(dir, 'invalid.json'), JSON.stringify(invalid));
  assert.throws(() => loadGoldSourceSelections(activeSkills, join(dir, 'invalid.json')), /unresolvable gold source ID/);
});

test('honors current config root and propagates mapping errors', () => {
  const previousRoot = getConfigRoot();
  const root = mkdtempSync(join('/tmp', 'kb-root-'));
  const mappingDir = join(root, 'evaluations/skills/kb');
  mkdirSync(mappingDir, { recursive: true });
  const active: SkillRegistryEntry[] = [activeSkillFixture];
  const mapping = [{ skill_id: 'alpha', kb_mode: 'not_applicable', required_sources: [], conditional_sources: [], optional_sources: [], retrieval_tags: [], source_status_policy: 'not_applicable', unresolved_items: [] }];
  writeFileSync(join(mappingDir, 'skill-knowledge-mapping.json'), JSON.stringify(mapping));
  setConfigRoot(root);
  try {
    assert.equal(loadSkillKnowledgeMappings(active).get('alpha')?.kb_mode, 'not_applicable');
    writeFileSync(join(mappingDir, 'skill-knowledge-mapping.json'), JSON.stringify([]));
    const goldPath = join(root, 'gold.json');
    writeFileSync(goldPath, JSON.stringify([]));
    assert.throws(() => loadGoldSourceSelections(active, goldPath), /missing mapping/);
  } finally {
    setConfigRoot(previousRoot);
  }
});

test('rejects gold mode that disagrees with mapping mode', () => {
  const activeSkills = loadSkillRegistry().skills.filter((skill) => skill.status === 'active');
  const dir = mkdtempSync(join('/tmp', 'kb-mode-'));
  const selections = JSON.parse(readFileSync(join(process.cwd(), 'evaluations/skills/kb/gold-source-selections.json'), 'utf8')) as Array<Record<string, unknown>>;
  selections[0] = { ...selections[0], mode: 'gold' };
  const path = join(dir, 'mode.json');
  writeFileSync(path, JSON.stringify(selections));
  assert.throws(() => loadGoldSourceSelections(activeSkills, path), /mode mismatch/);
});

test('rejects selected sources for non-KB gold modes', () => {
  const activeSkills = loadSkillRegistry().skills.filter((skill) => skill.status === 'active');
  const dir = mkdtempSync(join('/tmp', 'kb-native-selected-'));
  const selections = JSON.parse(readFileSync(join(process.cwd(), 'evaluations/skills/kb/gold-source-selections.json'), 'utf8')) as Array<Record<string, unknown>>;
  selections[0] = { ...selections[0], selected_source_ids: ['ghost_source'] };
  const path = join(dir, 'native-selected.json');
  writeFileSync(path, JSON.stringify(selections));
  assert.throws(() => loadGoldSourceSelections(activeSkills, path), /non-KB gold selection must be empty/);
});
