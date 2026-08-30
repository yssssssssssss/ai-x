import type {
  ContributionLedgerV1,
  ContributionSummaryV1,
  CrossSkillReviewV1,
} from '../../../../packages/api-contract/research-deliverable.ts';

const DISPOSITION_LABELS = {
  included: '原样纳入',
  merged: '综合合并',
  conflicted: '存在冲突',
  omitted: '经审校省略',
} as const;

export function SkillContributionView({
  summary,
  ledger,
  review,
}: {
  summary: ContributionSummaryV1;
  ledger: ContributionLedgerV1;
  review: CrossSkillReviewV1;
}) {
  return (
    <section className="stage-card skill-contribution-view" aria-label="Skill 独立贡献">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
        <div>
          <strong>贡献与最终映射</strong>
          <div style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 3 }}>
            仅任务所有者可见 · 非 Canonical 报告
          </div>
        </div>
        <span className="badge badge-reviewer">{review.verdict}</span>
      </div>
      <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
        {summary.contributors.map((contributor) => {
          const ledgerEntries = ledger.entries.filter(({ invocationId }) => (
            invocationId === contributor.invocationId
          ));
          return (
            <article key={contributor.invocationId} style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: 10 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
                <strong>{contributor.skillId}</strong>
                <code style={{ color: 'var(--text-faint)', fontSize: 11 }}>{contributor.invocationId}</code>
                <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                  {contributor.contributionTypes.join(' / ')} · {contributor.unitCount} units
                </span>
              </div>
              {contributor.limitations.length > 0 ? (
                <ul style={{ margin: '8px 0', paddingLeft: 18, color: 'var(--warn)', fontSize: 12 }}>
                  {contributor.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
                </ul>
              ) : null}
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
                {contributor.units.map((unit) => (
                  <li key={unit.sourceUnitKey} style={{ marginBottom: 8 }}>
                    <strong>{unit.title}</strong> · {DISPOSITION_LABELS[unit.disposition]}
                    {unit.canonicalNodeIds.length > 0 ? ` → ${unit.canonicalNodeIds.join('、')}` : ''}
                    <div>{unit.statement}</div>
                    {ledgerEntries.find(({ sourceUnitKey }) => sourceUnitKey === unit.sourceUnitKey)?.reason ? (
                      <div style={{ color: 'var(--text-dim)' }}>
                        {ledgerEntries.find(({ sourceUnitKey }) => sourceUnitKey === unit.sourceUnitKey)!.reason}
                      </div>
                    ) : null}
                    <div style={{ color: 'var(--text-faint)' }}>
                      {unit.status} · 置信度 {Math.round(unit.confidence * 100)}%
                      {unit.evidenceIds.length > 0 ? ` · Evidence ${unit.evidenceIds.join('、')}` : ''}
                      {' · '}source <code>{unit.sourceArtifactId}:{unit.sourceUnitKey}</code>
                    </div>
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>
      {review.issues.length > 0 ? (
        <details style={{ marginTop: 12 }}>
          <summary>跨 Skill 审校问题（{review.issues.length}）</summary>
          <ul style={{ paddingLeft: 18, fontSize: 12 }}>
            {review.issues.map((issue) => (
              <li key={issue.id}>
                <strong>{issue.type}</strong> · {issue.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
