// Zero dark mode adapter: clone source and switch copied root to dark mode.
// Replace SOURCE_ID before running in use_design_script.

const SOURCE_ID = 'REPLACE_WITH_SOURCE_NODE_ID';
const SAMPLE_DARK_NODE_ID = null; // Optional: a node manually switched to dark mode.
// Zero dark mode adapter: clone source and switch copied root to dark mode.
const COPY_SUFFIX = '_暗黑适配';
const GAP = 100;

const source = await relay.getNodeByIdAsync(SOURCE_ID);
if (!source) throw new Error(`source not found: ${SOURCE_ID}`);
if (!source.parent || !source.parent.children) throw new Error('source parent cannot contain copy');

const parent = source.parent;
let copyName = `${source.name}${COPY_SUFFIX}`;
let suffix = 1;
const names = new Set(parent.children.map(n => n.name));
while (names.has(copyName)) {
  suffix += 1;
  copyName = `${source.name}${COPY_SUFFIX}_${suffix}`;
}

const copy = source.clone();
copy.name = copyName;
copy.x = source.x + source.width + GAP + (suffix - 1) * (source.width + GAP);
copy.y = source.y;
copy.setSharedPluginData('zero_dark_mode_adapter', 'sourceNodeId', SOURCE_ID);

async function getDarkModesFromSample(sampleId) {
  if (!sampleId) return null;
  const sample = await relay.getNodeByIdAsync(sampleId);
  if (!sample) return null;
  const modes = sample.explicitVariableModes || {};
  return Object.keys(modes).length ? modes : null;
}

async function getDarkModesFromCollections() {
  const collections = await relay.variables.getLocalVariableCollectionsAsync();
  const modes = {};
  for (const collection of collections) {
    const dark = collection.modes.find(m => /暗色模式|暗黑模式|暗色|深色|dark|night/i.test(m.name));
    if (dark && /色彩|colors|color|语义/i.test(collection.name)) {
      modes[collection.id] = dark.modeId;
    }
  }
  return modes;
}

const explicitModes = (await getDarkModesFromSample(SAMPLE_DARK_NODE_ID)) || (await getDarkModesFromCollections());
const applied = [];
const failed = [];
for (const collectionId of Object.keys(explicitModes)) {
  const modeId = explicitModes[collectionId];
  try {
    const collection = await relay.variables.getVariableCollectionByIdAsync(collectionId);
    if (!collection) {
      failed.push({ collectionId, modeId, reason: 'collection not found' });
      continue;
    }
    if (!collection.modes.some(m => m.modeId === modeId)) {
      failed.push({ collectionId, collectionName: collection.name, modeId, reason: 'mode not in collection' });
      continue;
    }
    copy.setExplicitVariableModeForCollection(collection, modeId);
    applied.push({ collectionId, collectionName: collection.name, modeId });
  } catch (e) {
    failed.push({ collectionId, modeId, reason: String(e && e.message ? e.message : e) });
  }
}

return {
  original: { id: source.id, name: source.name, x: source.x, y: source.y, width: source.width, height: source.height },
  copy: { id: copy.id, name: copy.name, x: copy.x, y: copy.y, width: copy.width, height: copy.height, explicitModes: copy.explicitVariableModes },
  darkModeApplied: applied,
  darkModeFailed: failed,
  createdNodeIds: [copy.id],
  mutatedNodeIds: [copy.id],
};
