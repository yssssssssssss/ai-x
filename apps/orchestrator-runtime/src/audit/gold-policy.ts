import { join } from 'node:path';
import { getConfigRoot, loadYaml } from '../runtime/config-loader.ts';

export interface InvalidatedGoldBatch {
  status: 'INVALIDATED';
  reasons: string[];
}

export interface GoldPolicy {
  version: number;
  trusted_gold_enabled: boolean;
  disabled_reason: string;
  legacy_batches: Record<string, InvalidatedGoldBatch>;
}

const GOLD_POLICY_FILE = 'orchestrator/gold-policy.yaml';

export function loadGoldPolicy(): GoldPolicy {
  return loadYaml<GoldPolicy>(join(getConfigRoot(), GOLD_POLICY_FILE));
}

export function assertTrustedGoldEnabled(policy: GoldPolicy = loadGoldPolicy()): void {
  if (!policy.trusted_gold_enabled) {
    throw new Error(`GOLD_TRUST_DISABLED: ${policy.disabled_reason}`);
  }
}

export function isP0EligibleBatch(batchId: string, policy: GoldPolicy = loadGoldPolicy()): boolean {
  return policy.trusted_gold_enabled && policy.legacy_batches[batchId]?.status !== 'INVALIDATED';
}
