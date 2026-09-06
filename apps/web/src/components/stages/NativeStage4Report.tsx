import { useEffect, useState } from 'react';
import type {
  NativeFinalReport,
  NativeSkillResult,
} from '../../../../../packages/api-contract/native-skill-orchestration.ts';
import { api } from '../../api/client.ts';
import { Header } from './Stage1Understand.tsx';

export function NativeStage4Report({
  taskId,
  finalReport,
  skillResults,
}: {
  taskId: string;
  finalReport: NativeFinalReport;
  skillResults: NativeSkillResult[];
}) {
  const [view, setView] = useState<'final' | 'skills'>('final');
  const [selectedInvocationId, setSelectedInvocationId] = useState(
    skillResults[0]?.invocationId ?? '',
  );
  const [html, setHtml] = useState<string | null>(null);
  const [htmlError, setHtmlError] = useState('');
  const selectedResult = skillResults.find(({ invocationId }) => invocationId === selectedInvocationId)
    ?? skillResults[0];

  useEffect(() => {
    let active = true;
    setHtml(null);
    setHtmlError('');
    void api.controlFinalReportHtml(taskId)
      .then(async ({ blob }) => blob.text())
      .then((content) => { if (active) setHtml(content); })
      .catch((error: unknown) => {
        if (active) setHtmlError(error instanceof Error ? error.message : 'HTML 报告加载失败');
      });
    return () => { active = false; };
  }, [taskId, finalReport.attemptId]);

  function download(name: string, content: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <section className="stage-card native-report" aria-label="研究报告">
      <Header
        n="4"
        title={finalReport.title}
        note={finalReport.mode === 'multi_skill' ? '多项能力综合报告' : '单项能力报告'}
      />
      <nav className="report-view-toggle" aria-label="报告视图">
        <button type="button" className={view === 'final' ? 'is-active' : ''} onClick={() => setView('final')}>最终报告</button>
        <button type="button" className={view === 'skills' ? 'is-active' : ''} onClick={() => setView('skills')}>分析明细</button>
      </nav>
      {view === 'final' ? (
        <>
          <div className="report-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => download(
                `report-${taskId}.${finalReport.primary.format === 'html' ? 'html' : 'md'}`,
                finalReport.primary.content,
                finalReport.primary.format === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8',
              )}
            >
              下载原始报告
            </button>
            {html ? (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => download(`report-${taskId}.html`, html, 'text/html;charset=utf-8')}
              >
                下载 HTML
              </button>
            ) : null}
            {finalReport.attachments.map((attachment) => (
              <button
                key={attachment.path}
                type="button"
                className="btn-ghost"
                onClick={() => download(attachment.path.split('/').at(-1) ?? 'attachment', attachment.content, attachment.mediaType)}
              >
                下载 {attachment.path}
              </button>
            ))}
          </div>
          {htmlError ? <p role="alert">{htmlError}</p> : null}
          {html
            ? (
              <iframe
                className="native-report-document"
                title={finalReport.title}
                sandbox=""
                srcDoc={html}
              />
            )
            : <pre className="native-report-content">{finalReport.primary.content}</pre>}
        </>
      ) : (
        <>
          <div className="report-view-toggle" aria-label="分析结果选择">
            {skillResults.map((report) => (
              <button
                key={report.invocationId}
                type="button"
                className={selectedResult?.invocationId === report.invocationId ? 'is-active' : ''}
                onClick={() => setSelectedInvocationId(report.invocationId)}
              >
                {report.title}
              </button>
            ))}
          </div>
          {selectedResult ? (
            <article>
              <p><b>状态：</b>{selectedResult.status}</p>
              <pre className="native-report-content">{selectedResult.primary.content}</pre>
              {selectedResult.gaps.length > 0 ? (
                <section>
                  <h3>资料缺口</h3>
                  <ul>{selectedResult.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>
                </section>
              ) : null}
              {selectedResult.attachments.length > 0 ? (
                <section>
                  <h3>附件</h3>
                  <ul>{selectedResult.attachments.map((attachment) => (
                    <li key={attachment.path}>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => download(attachment.path.split('/').at(-1) ?? 'attachment', attachment.content, attachment.mediaType)}
                      >
                        {attachment.path}
                      </button>
                    </li>
                  ))}</ul>
                </section>
              ) : null}
              <section>
                <h3>来源</h3>
                {selectedResult.sources.length === 0 ? <p>无</p> : (
                  <ul>{selectedResult.sources.map((source) => (
                    <li key={source.id}>
                      <code>{source.id}</code>{' '}
                      {source.url
                        ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
                        : source.title}
                    </li>
                  ))}</ul>
                )}
              </section>
            </article>
          ) : <p>没有可用的分析结果。</p>}
        </>
      )}
    </section>
  );
}
