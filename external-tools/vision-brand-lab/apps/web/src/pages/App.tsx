import { useState } from 'react';
import type { UploadedImageRef, VisionBrandAnalyzeResult } from '@vision-brand-lab/core';
import { analyze, uploadImage } from '../lib/api.js';
import './styles.css';

export const App = () => {
  const [designImage, setDesignImage] = useState<UploadedImageRef>();
  const [brandImage, setBrandImage] = useState<UploadedImageRef>();
  const [result, setResult] = useState<VisionBrandAnalyzeResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const upload = async (file: File | undefined, setter: (value: UploadedImageRef) => void) => {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      setter(await uploadImage(file));
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
        designImages: designImage ? [designImage] : [],
        brandReferenceImages: brandImage ? [brandImage] : [],
        businessGoal: '评估设计视觉清晰度、转化动线与品牌一致性',
      }));
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
          <h1>Vision Brand Lab</h1>
          <p>上传设计稿和品牌参考图，输出视觉评审与品牌联想度。</p>
        </div>
        <button disabled={busy || !designImage} onClick={run}>{busy ? '分析中' : '分析'}</button>
      </section>
      <section className="inputs">
        <label><span>设计稿</span><input type="file" accept="image/*" onChange={(event) => upload(event.target.files?.[0], setDesignImage)} /></label>
        <label><span>品牌参考图</span><input type="file" accept="image/*" onChange={(event) => upload(event.target.files?.[0], setBrandImage)} /></label>
      </section>
      {error ? <pre className="error">{error}</pre> : null}
      {result ? (
        <section className="result">
          <article className="summary"><h2>{result.status}</h2><p>{result.summary}</p></article>
          <div className="cards">
            {result.visualReview?.reviewers.map((reviewer) => (
              <article className="card" key={reviewer.role}>
                <div className="score">{reviewer.score}</div>
                <h3>{reviewer.role}</h3>
                <p>{reviewer.findings.join('；')}</p>
                <small>{reviewer.suggestions.join('；')}</small>
              </article>
            ))}
          </div>
          <article className="summary"><h2>品牌联想度</h2><p>{result.brandAssociation?.summary}</p></article>
          <article className="summary"><h2>边界</h2><ul>{result.boundaryNotes.map((item) => <li key={item}>{item}</li>)}</ul></article>
        </section>
      ) : null}
    </main>
  );
};
