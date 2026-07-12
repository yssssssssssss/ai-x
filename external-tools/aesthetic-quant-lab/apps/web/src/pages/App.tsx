import { useState } from 'react';
import type { AestheticAnalyzeResult, UploadedImageRef } from '@aesthetic-quant-lab/core';
import { analyze, uploadImage } from '../lib/api.js';
import './styles.css';

export const App = () => {
  const [designImage, setDesignImage] = useState<UploadedImageRef>();
  const [result, setResult] = useState<AestheticAnalyzeResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const onFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      setDesignImage(await uploadImage(file));
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
        designImage,
        profileId: 'balanced',
        depth: 'standard',
        rois: [
          { id: 'hero', label: '主视觉区域', x: 0.12, y: 0.12, width: 0.52, height: 0.38 },
          { id: 'action', label: '行动区域', x: 0.58, y: 0.62, width: 0.3, height: 0.22 },
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
        <h1>Aesthetic Quant Lab</h1>
        <p>上传一张设计图，独立生成美学量化、ROI、启发式注意力和优化建议。</p>
      </section>

      <section className="panel">
        <label className="upload">
          <span>选择设计图</span>
          <input type="file" accept="image/*" onChange={(event) => onFile(event.target.files?.[0])} />
        </label>
        {designImage ? <p className="muted">已上传：{designImage.fileName || designImage.id}</p> : null}
        <button disabled={!designImage || busy} onClick={run}>{busy ? '分析中…' : '开始分析'}</button>
        {error ? <pre className="error">{error}</pre> : null}
      </section>

      {result ? (
        <section className="grid">
          <article className="card highlight">
            <span>综合分</span>
            <strong>{result.overallScore ?? '-'}</strong>
            <p>{result.summary}</p>
          </article>
          <article className="card">
            <h2>整图</h2>
            <p>主色：{result.wholeImage?.dominantColor}</p>
            <p>亮度：{result.wholeImage?.brightness}</p>
            <p>边缘密度：{result.wholeImage?.edgeDensity}</p>
          </article>
          <article className="card">
            <h2>注意力</h2>
            <p>{result.attentionResult?.summary || '未启用'}</p>
            <p>分散风险：{result.attentionResult?.distractionRiskScore ?? '-'}</p>
          </article>
          <article className="card wide">
            <h2>建议</h2>
            <ul>{result.recommendations.map((item) => <li key={item}>{item}</li>)}</ul>
          </article>
          <article className="card wide">
            <h2>边界</h2>
            <ul>{result.boundaryNotes.map((item) => <li key={item}>{item}</li>)}</ul>
          </article>
        </section>
      ) : null}
    </main>
  );
};
