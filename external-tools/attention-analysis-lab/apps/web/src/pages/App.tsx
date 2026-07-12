import { useState } from 'react';
import type { AttentionAnalyzeResult, UploadedImageRef } from '@attention-analysis-lab/core';
import { analyze, uploadImage } from '../lib/api.js';
import './styles.css';

export const App = () => {
  const [image, setImage] = useState<UploadedImageRef>();
  const [result, setResult] = useState<AttentionAnalyzeResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const onFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      setImage(await uploadImage(file));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await analyze({
        image,
        mode: 'heuristic',
        rois: [
          { id: 'hero', label: '主视觉', x: 0.1, y: 0.1, width: 0.52, height: 0.38 },
          { id: 'cta', label: '行动按钮', x: 0.58, y: 0.62, width: 0.28, height: 0.18 },
        ],
      }));
    } catch (analyzeError) {
      setError(analyzeError instanceof Error ? analyzeError.message : String(analyzeError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Independent Capability Project</p>
        <h1>Attention Analysis Lab</h1>
        <p>独立估算页面第一眼注意力、热点、ROI 排序和分散风险。</p>
      </section>
      <section className="panel">
        <input type="file" accept="image/*" onChange={(event) => onFile(event.target.files?.[0])} />
        {image ? <p className="muted">已上传：{image.fileName || image.id}</p> : null}
        <button disabled={!image || busy} onClick={run}>{busy ? '分析中…' : '开始注意力分析'}</button>
        {error ? <pre className="error">{error}</pre> : null}
      </section>
      {result ? (
        <section className="grid">
          <article className="card highlight"><span>峰值</span><strong>{result.peakAttentionScore}</strong><p>{result.summary}</p></article>
          <article className="card"><h2>分散风险</h2><p>{result.distractionRiskScore}</p><p>焦点平衡：{result.focusBalanceScore}</p></article>
          <article className="card"><h2>热点数量</h2><p>{result.hotspots.length}</p></article>
          <article className="card wide"><h2>ROI 排名</h2><ol>{result.roiAttentionRanking.map((roi) => <li key={roi.id}>{roi.label}: 平均 {roi.attentionAverage}, 占比 {roi.attentionShare}</li>)}</ol></article>
          <article className="card wide"><h2>边界</h2><ul>{result.boundaryNotes.map((item) => <li key={item}>{item}</li>)}</ul></article>
        </section>
      ) : null}
    </main>
  );
};
