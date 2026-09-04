import { useEffect, useRef, useState } from 'react';
import type {
  FinalReport,
  SkillReport,
} from '../../../../../packages/api-contract/lightweight-orchestration.ts';
import { api } from '../../api/client.ts';
import { Header } from './Stage1Understand.tsx';

export function LightweightStage4Report({
  taskId,
  finalReport,
  skillReports,
}: {
  taskId: string;
  finalReport: FinalReport;
  skillReports: SkillReport[];
}) {
  const [view, setView] = useState<'final' | 'skills'>('final');
  const [selectedInvocationId, setSelectedInvocationId] = useState(
    skillReports[0]?.invocationId ?? '',
  );
  const [html, setHtml] = useState<string | null>(null);
  const [htmlError, setHtmlError] = useState('');
  const htmlHostRef = useRef<HTMLDivElement>(null);
  const selectedReport = skillReports.find(({ invocationId }) => invocationId === selectedInvocationId)
    ?? skillReports[0];

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

  useEffect(() => {
    const host = htmlHostRef.current;
    if (!host || !html) return;
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    parsed.querySelectorAll('script,iframe,form').forEach((element) => element.remove());
    parsed.querySelectorAll('*').forEach((element) => {
      for (const attribute of [...element.attributes]) {
        if (attribute.name.toLowerCase().startsWith('on')) element.removeAttribute(attribute.name);
      }
    });
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const fragment = document.createDocumentFragment();
    parsed.head.querySelectorAll('style').forEach((style) => fragment.append(style.cloneNode(true)));
    parsed.body.childNodes.forEach((child) => fragment.append(child.cloneNode(true)));
    shadow.replaceChildren(fragment);
    return () => { shadow.replaceChildren(); };
  }, [html]);

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
    <section className="stage-card lightweight-report" aria-label="轻量研究报告">
      <Header
        n="4"
        title={finalReport.title}
        note={finalReport.mode === 'multi_skill' ? 'Multi Skill 综合报告' : 'Single Skill 原始报告'}
      />
      <nav className="report-view-toggle" aria-label="报告视图">
        <button type="button" className={view === 'final' ? 'is-active' : ''} onClick={() => setView('final')}>最终报告</button>
        <button type="button" className={view === 'skills' ? 'is-active' : ''} onClick={() => setView('skills')}>Skill 明细</button>
      </nav>
      {view === 'final' ? (
        <>
          <div className="report-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => download(`report-${taskId}.md`, finalReport.markdown, 'text/markdown;charset=utf-8')}
            >
              下载 Markdown
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
          </div>
          {htmlError ? <p role="alert">{htmlError}</p> : null}
          {html
            ? <div ref={htmlHostRef} className="lightweight-report-document" aria-label={finalReport.title} />
            : <pre className="lightweight-report-markdown">{finalReport.markdown}</pre>}
        </>
      ) : (
        <>
          <div className="report-view-toggle" aria-label="Skill 报告选择">
            {skillReports.map((report) => (
              <button
                key={report.invocationId}
                type="button"
                className={selectedReport?.invocationId === report.invocationId ? 'is-active' : ''}
                onClick={() => setSelectedInvocationId(report.invocationId)}
              >
                {report.title}
              </button>
            ))}
          </div>
          {selectedReport ? (
            <article>
              <p><b>状态：</b>{selectedReport.status}</p>
              <pre className="lightweight-report-markdown">{selectedReport.markdown}</pre>
              {selectedReport.gaps.length > 0 ? (
                <section>
                  <h3>资料缺口</h3>
                  <ul>{selectedReport.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>
                </section>
              ) : null}
              <section>
                <h3>来源</h3>
                {selectedReport.sources.length === 0 ? <p>无</p> : (
                  <ul>{selectedReport.sources.map((source) => (
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
          ) : <p>没有可用的 Skill 报告。</p>}
        </>
      )}
    </section>
  );
}
