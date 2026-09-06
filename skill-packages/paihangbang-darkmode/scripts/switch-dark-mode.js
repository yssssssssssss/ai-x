// Phase 2: switch copied root to dark mode only. Do not recolor internals.
// Replace COPY_ID before running in use_design_script.

const COPY_ID = 'REPLACE_WITH_COPY_NODE_ID';
const SAMPLE_DARK_NODE_ID = '7:17986';
const FALLBACK_DARK_MODE_ID = '712:7139';
const FALLBACK_COLLECTION_IDS = ['7:11334','7:11336','7:11338','7:11341','7:11343','7:11351','7:11361','7:11377','7:15135','7:17374','7:11350'];

const copy = await relay.getNodeByIdAsync(COPY_ID);
if (!copy) throw new Error(`copy not found: ${COPY_ID}`);

async function getModesFromSample() {
  const sample = await relay.getNodeByIdAsync(SAMPLE_DARK_NODE_ID);
  if (!sample) return null;
  const modes = sample.explicitVariableModes || {};
  return Object.keys(modes).length ? modes : null;
}

async function getModesFromCollections() {
  const modes = {};
  const collections = await relay.variables.getLocalVariableCollectionsAsync();
  for (const collection of collections) {
    const dark = collection.modes.find(m => /暗色模式|暗黑模式|暗色|深色|dark|night/i.test(m.name));
    if (dark && /色彩|colors|color|语义/i.test(collection.name)) modes[collection.id] = dark.modeId;
  }
  return modes;
}

let modes = await getModesFromSample();
if (!modes) modes = await getModesFromCollections();
if (!Object.keys(modes).length) {
  modes = Object.fromEntries(FALLBACK_COLLECTION_IDS.map(id => [id, FALLBACK_DARK_MODE_ID]));
}

const applied = [];
const failed = [];
for (const collectionId of Object.keys(modes)) {
  const modeId = modes[collectionId];
  try {
    const collection = await relay.variables.getVariableCollectionByIdAsync(collectionId);
    if (!collection) { failed.push({ collectionId, modeId, reason: 'collection not found' }); continue; }
    if (!collection.modes.some(m => m.modeId === modeId)) { failed.push({ collectionId, collectionName: collection.name, modeId, reason: 'mode not in collection' }); continue; }
    copy.setExplicitVariableModeForCollection(collection, modeId);
    applied.push({ collectionId, collectionName: collection.name, modeId });
  } catch (e) {
    failed.push({ collectionId, modeId, reason: String(e && e.message ? e.message : e) });
  }
}
copy.setSharedPluginData('zero_dark_mode_adapter', 'phase', 'switch-dark-mode');
return { phase: 'switch-dark-mode', copy: { id: copy.id, name: copy.name, explicitModeCount: Object.keys(copy.explicitVariableModes || {}).length }, applied, failed, mutatedNodeIds: [copy.id] };

