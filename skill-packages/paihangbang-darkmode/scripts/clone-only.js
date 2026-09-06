// Phase 1: clone only. Do not traverse, recolor, bind, load fonts, or modify internals.
// Replace SOURCE_ID before running in use_design_script.


const SOURCE_ID = 'REPLACE_WITH_SOURCE_NODE_ID';
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
copy.setSharedPluginData('zero_dark_mode_adapter', 'phase', 'clone-only');


return {
  phase: 'clone-only',
  original: { id: source.id, name: source.name, x: source.x, y: source.y, width: source.width, height: source.height },
  copy: { id: copy.id, name: copy.name, x: copy.x, y: copy.y, width: copy.width, height: copy.height },
  createdNodeIds: [copy.id],
  mutatedNodeIds: [copy.id],
};
