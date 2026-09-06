// Read current 16.0 library local variables and output a token cache seed.
// Run only when the MCP is connected to the 16.0 design system file.

const collections = await relay.variables.getLocalVariableCollectionsAsync();
function toHex(value) {
  if (!value || typeof value !== 'object' || !('r' in value)) return null;
  const h = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(value.r)}${h(value.g)}${h(value.b)}${value.a != null && value.a < 1 ? Math.round(value.a * 255).toString(16).padStart(2, '0') : ''}`.toLowerCase();
}
function inferRole(name) {
  const n = name.toLowerCase();
  if (/background|背景|overlay|gray_1|gray_2|gray_3/.test(n)) return 'background/surface';
  if (/text|文本|title|gray_7|gray_6|gray_5|gray_4/.test(n)) return 'text';
  if (/border|line|线/.test(n)) return 'border';
  if (/mask|蒙层/.test(n)) return 'mask';
  if (/primary|brand|主色|品牌|red|jdred/.test(n)) return 'primary';
  if (/service|gold|服务金/.test(n)) return 'service';
  if (/ai/.test(n)) return 'ai';
  return 'unknown';
}
const cache = [];
for (const collection of collections) {
  if (!/色彩|colors|color/i.test(collection.name)) continue;
  const light = collection.modes.find(m => /日间|light/i.test(m.name));
  const dark = collection.modes.find(m => /暗色|暗黑|dark|night/i.test(m.name));
  if (!light || !dark) continue;
  for (const id of collection.variableIds) {
    const v = await relay.variables.getVariableByIdAsync(id);
    if (!v || v.resolvedType !== 'COLOR') continue;
    const lightHex = toHex(v.valuesByMode[light.modeId]);
    const darkHex = toHex(v.valuesByMode[dark.modeId]);
    if (!lightHex || !darkHex) continue;
    cache.push({ tokenName: v.name, role: inferRole(v.name), lightHex, darkHex, variableId: v.id, collectionId: collection.id, collectionName: collection.name, lightModeId: light.modeId, darkModeId: dark.modeId });
  }
}
return { count: cache.length, tokens: cache };

