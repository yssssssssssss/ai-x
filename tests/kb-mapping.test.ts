import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSkillRegistry } from '../apps/orchestrator-runtime/src/runtime/config-loader.ts';
import {
  loadSkillKnowledgeMappings,
  loadGoldSourceSelections,
} from '../evaluations/skills/kb/snapshot.ts';

test('loads exactly 22 mappings in active registry order', () => {
  const activeSkills = loadSkillRegistry().skills.filter((skill) => skill.status === 'active');
  const mappings = loadSkillKnowledgeMappings(activeSkills);
  assert.equal(mappings.size, 22);
  assert.deepEqual([...mappings.keys()], activeSkills.map((skill) => skill.id));
  assert.equal(mappings.get('competitive-web-research')?.kb_mode, 'not_applicable');
  assert.equal(mappings.get('generate-survey')?.required_sources.length > 0, true);
});

test('preserves source role, status policy, one-of semantics, and unresolved paths', () => {
  const activeSkills = loadSkillRegistry().skills.filter((skill) => skill.status === 'active');
  const mappings = loadSkillKnowledgeMappings(activeSkills);
  const survey = mappings.get('generate-survey')!;
  assert.equal(survey.source_status_policy, 'draft_allowed_with_warning');
  assert.ok(survey.required_sources.every((source) => source.role));
  const transcript = mappings.get('structure-interview-transcript')!;
  assert.ok(transcript.required_sources.some((source) => source.role === 'one_of'));
  const competitive = mappings.get('competitive-analysis')!;
  assert.ok(competitive.unresolved_items.some((item) => item.includes('models/aarrr.md')));
  assert.ok(mappings.get('conversion-funnel-analysis')!.unresolved_items.some((item) => item.includes('models/fogg-behavior-model.md')));
  assert.ok(mappings.get('analyze-satisfaction')!.unresolved_items.some((item) => item.includes('methods/toolbox/analysis/ipa-matrix.md')));
  assert.ok(mappings.get('generate-interview-guide')!.unresolved_items.some((item) => item.includes('<主题>') || item.includes('<业务线>')));
  assert.ok(competitive.required_sources.some((source) => source.path === 'models/kano.md'));
  assert.ok(competitive.unresolved_items.some((item) => item.includes('kano') && item.includes('contradiction')));
});

test('rejects unknown and missing mapping IDs', () => {
  const activeSkills = [{ id: 'alpha', status: 'active' }] as any[];
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
});
