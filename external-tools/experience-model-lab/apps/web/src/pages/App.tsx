import { useEffect, useState } from 'react';
import type { ExperienceAnalyzeResult, ExperienceModelProfile } from '@experience-model-lab/core';
import { analyze, listModels } from '../lib/api.js';
import './styles.css';

const defaultQuery = '评估电商首页内容种草区是否提升用户参与、信任和转化意愿';

export const App = () => {
  const [query, setQuery] = useState(defaultQuery);
  const [models, setModels] = useState<ExperienceModelProfile[]>([]);
  const [result, setResult] = useState<ExperienceAnalyzeResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    listModels().then(setModels).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
  }, []);

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await analyze({ query }));
    } catch (analyzeError) {
      setError(analyzeError instanceof Error ? analyzeError.message : String(analyzeError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell">
      <section className="toolbar">
        <div>
          <h1>Experience Model Lab</h1>
          <p>输入研究问题，返回可解释的体验模型推荐和问题模板。</p>
        </div>
        <button disabled={busy || !query.trim()} onClick={run}>{busy ? '分析中' : '分析'}</button>
      </section>

      <section className="workspace">
        <aside className="sidebar">
          <h2>模型目录</h2>
          {models.map((model) => (
            <article className="model" key={model.id}>
              <strong>{model.name}</strong>
              <span>{model.bestFor.slice(0, 2).join(' / ')}</span>
            </article>
          ))}
        </aside>

        <section className="main-panel">
          <label>
            <span>研究问题</span>
            <textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={5} />
          </label>
          {error ? <pre className="error">{error}</pre> : null}

          {result ? (
            <div className="result">
              <h2>推荐结果</h2>
              <p>{result.summary}</p>
              <div className="cards">
                {result.selectedModels.map((model) => (
                  <article className="card" key={model.id}>
                    <div className="score">{model.score}</div>
                    <h3>{model.name}</h3>
                    <p>{model.reasons.join('；')}</p>
                    <small>{model.filename}</small>
                  </article>
                ))}
              </div>
              <h2>问题模板</h2>
              <ul>{result.questionTemplates.map((item) => <li key={item}>{item}</li>)}</ul>
              <h2>边界</h2>
              <ul>{result.boundaryNotes.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
};
