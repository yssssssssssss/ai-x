import { useEffect, useState } from 'react';
import type { PersonaProfile, VirtualUserSimulateResult } from '@virtual-user-lab/core';
import { listPersonas, simulate } from '../lib/api.js';
import './styles.css';

const defaultScenario = '评估电商首页内容种草区是否能提升用户参与、信任和转化意愿';

export const App = () => {
  const [scenario, setScenario] = useState(defaultScenario);
  const [personas, setPersonas] = useState<PersonaProfile[]>([]);
  const [result, setResult] = useState<VirtualUserSimulateResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    listPersonas().then(setPersonas).catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
  }, []);

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await simulate({ scenario }));
    } catch (simulateError) {
      setError(simulateError instanceof Error ? simulateError.message : String(simulateError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell">
      <section className="toolbar">
        <div>
          <h1>Virtual User Lab</h1>
          <p>用虚拟 Persona 做方案初筛，输出模拟反馈和待验证假设。</p>
        </div>
        <button disabled={busy || !scenario.trim()} onClick={run}>{busy ? '模拟中' : '开始模拟'}</button>
      </section>
      <section className="notice">模拟结果不是真实用户研究证据。</section>
      <section className="workspace">
        <aside className="sidebar">
          <h2>内置 Persona</h2>
          {personas.map((persona) => (
            <article className="persona" key={persona.id}>
              <strong>{persona.name}</strong>
              <span>{persona.type}</span>
            </article>
          ))}
        </aside>
        <section className="main-panel">
          <label>
            <span>模拟场景</span>
            <textarea value={scenario} onChange={(event) => setScenario(event.target.value)} rows={5} />
          </label>
          {error ? <pre className="error">{error}</pre> : null}
          {result ? (
            <div className="result">
              <h2>模拟反馈</h2>
              <p>{result.summary}</p>
              <div className="cards">
                {result.reviews.map((review) => (
                  <article className="card" key={review.profileId}>
                    <div className="score">{review.overallScore}</div>
                    <h3>{review.personaName}</h3>
                    <small>{review.personaType} / {review.stance} / simulated</small>
                    <p>{review.firstImpression}</p>
                    <p>{review.topChangeRequest}</p>
                  </article>
                ))}
              </div>
              <h2>共性痛点</h2>
              <ul>{result.aggregate.sharedPainPoints.map((item) => <li key={item}>{item}</li>)}</ul>
              <h2>边界</h2>
              <ul>{result.boundaryNotes.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
};
