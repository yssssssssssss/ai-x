import type { AestheticProfileDefinition } from '@aesthetic-quant-lab/core';

export const profiles: AestheticProfileDefinition[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    description: '均衡看待整图、ROI 与前景/背景关系。',
    defaultDepth: 'standard',
    defaults: {
      enableAttention: true,
      includeAttentionInOverallScore: false,
    },
  },
  {
    id: 'readability_first',
    label: 'Readability First',
    description: '更关注阅读清晰度与信息秩序。',
    defaultDepth: 'standard',
    defaults: {
      enableAttention: true,
      includeAttentionInOverallScore: true,
    },
  },
  {
    id: 'marketing_impact',
    label: 'Marketing Impact',
    description: '更强调视觉冲击、局部吸睛与营销表现。',
    defaultDepth: 'standard',
    defaults: {
      enableAttention: true,
      includeAttentionInOverallScore: true,
    },
  },
];

export const getProfile = (id: unknown) => profiles.find((item) => item.id === id) || profiles[0];
