import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import useEmblaCarousel from 'embla-carousel-react';
import type { CurrentPlanCandidate } from '../../api/client.ts';
import { Header } from './Stage1Understand.tsx';

function ArrowIcon({ direction }: { direction: 'previous' | 'next' }) {
  const path = direction === 'previous' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6';
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d={path} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function shouldReduceMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// 段2a · Current 候选计划：选择的稳定标识是 planVersionId，而不是展示用 candidateId。
export function Stage2Candidates({
  candidates, onSelect, selectedId, loading, readOnly = false,
}: {
  candidates: CurrentPlanCandidate[];
  onSelect: (planVersionId: CurrentPlanCandidate['planVersionId']) => void;
  selectedId?: CurrentPlanCandidate['planVersionId'];
  loading?: boolean;
  readOnly?: boolean;
}) {
  const initialIndex = Math.max(0, candidates.findIndex((candidate) => candidate.planVersionId === selectedId));
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [canScrollPrevious, setCanScrollPrevious] = useState(false);
  const [canScrollNext, setCanScrollNext] = useState(candidates.length > 1);
  const [carouselRef, carouselApi] = useEmblaCarousel({
    align: 'center',
    containScroll: 'trimSnaps',
    dragFree: false,
    duration: 22,
    skipSnaps: false,
    startIndex: initialIndex,
  });

  const updateCarouselState = useCallback(() => {
    if (!carouselApi) return;
    setCurrentIndex(carouselApi.selectedScrollSnap());
    setCanScrollPrevious(carouselApi.canScrollPrev());
    setCanScrollNext(carouselApi.canScrollNext());
  }, [carouselApi]);

  useEffect(() => {
    if (!carouselApi) return;
    updateCarouselState();
    carouselApi.on('select', updateCarouselState);
    carouselApi.on('reInit', updateCarouselState);
    return () => {
      carouselApi.off('select', updateCarouselState);
      carouselApi.off('reInit', updateCarouselState);
    };
  }, [carouselApi, updateCarouselState]);

  const scrollTo = useCallback((index: number, jump = shouldReduceMotion()) => {
    carouselApi?.scrollTo(index, jump);
  }, [carouselApi]);

  const chooseOrReveal = useCallback((candidate: CurrentPlanCandidate, index: number) => {
    if (index !== currentIndex) {
      scrollTo(index);
      return;
    }
    onSelect(candidate.planVersionId);
  }, [currentIndex, onSelect, scrollTo]);

  const handleKeyboardNavigation = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!carouselApi || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const selectedIndex = carouselApi.selectedScrollSnap();
    let targetIndex: number | null = null;
    if (event.key === 'ArrowLeft') {
      targetIndex = Math.max(0, selectedIndex - 1);
    } else if (event.key === 'ArrowRight') {
      targetIndex = Math.min(candidates.length - 1, selectedIndex + 1);
    } else if (event.key === 'Home') {
      targetIndex = 0;
    } else if (event.key === 'End') {
      targetIndex = candidates.length - 1;
    }

    if (targetIndex == null || targetIndex === selectedIndex) return;
    event.preventDefault();
    carouselApi.scrollTo(targetIndex, true);

    const eventTarget = event.target as HTMLElement;
    const focusSelector = eventTarget.classList.contains('candidate-carousel-dot')
      ? '.candidate-carousel-dot'
      : eventTarget.classList.contains('candidate-card')
        ? '.candidate-card'
        : null;
    if (!focusSelector) return;
    const carouselRoot = event.currentTarget;
    requestAnimationFrame(() => {
      const target = carouselRoot.querySelector<HTMLElement>(`${focusSelector}[data-carousel-index="${targetIndex}"]`);
      target?.focus();
    });
  }, [carouselApi, candidates.length]);

  const currentCandidate = candidates[currentIndex];

  return (
    <section className="stage-card candidate-stage">
      <Header n="2" title="待选执行方案" note={readOnly ? '左右滑动查看，旧任务不可修改' : '左右滑动对比，点击主卡片选择'} />
      <div
        className="candidate-carousel"
        role="region"
        aria-roledescription="carousel"
        aria-label="执行方案"
        onKeyDown={handleKeyboardNavigation}
      >
        <div className="candidate-carousel-viewport" ref={carouselRef}>
          <div className="candidate-carousel-track">
            {candidates.map((candidate, candidateIndex) => {
              const current = candidateIndex === currentIndex;
              const active = selectedId === candidate.planVersionId;
              const steps = candidate.plan.steps;
              return (
                <div
                  key={candidate.planVersionId}
                  className={`candidate-slide${current ? ' is-current' : ''}`}
                  role="group"
                  aria-roledescription="slide"
                  aria-label={`${candidateIndex + 1} / ${candidates.length}`}
                >
                  <button
                    type="button"
                    data-carousel-index={candidateIndex}
                    aria-label={current ? `选择方案：${candidate.title}` : `查看方案：${candidate.title}`}
                    aria-pressed={active}
                    aria-busy={active && loading}
                    disabled={readOnly || loading}
                    tabIndex={current ? 0 : -1}
                    onClick={() => chooseOrReveal(candidate, candidateIndex)}
                    className={`candidate-card${active ? ' is-active' : ''}`}
                  >
                    <div className="candidate-head">
                      <span className={`candidate-tag tag-${candidate.candidateId}`}>
                        {candidate.candidateId === 'depth' ? '深度优先' : '速度优先'}
                      </span>
                      <b className="candidate-title">{candidate.title}</b>
                      {active && loading ? <span className="spinner candidate-spinner" /> : null}
                    </div>
                    <p className="candidate-rationale">{candidate.rationale}</p>
                    <div className="candidate-tradeoffs">
                      <span>代价</span>{candidate.tradeoffs}
                    </div>
                    <ol className="candidate-steps">
                      {steps.map((step, index) => (
                        <li key={step.step_no ?? index}>
                          <span className={`badge badge-${step.actor_type === 'llm' ? 'llm' : step.actor_type === 'reviewer' ? 'reviewer' : step.actor_type}`}>
                            {step.actor_type.toUpperCase()}
                          </span>
                          <span className="step-name">{step.step_name || step.actor_id}</span>
                          <code className="step-id" title={step.actor_id}>{step.actor_id}</code>
                        </li>
                      ))}
                    </ol>
                    <div className="candidate-meta">
                      <span>
                        共 {steps.length} 步 · {steps.filter((step) => step.actor_type === 'skill').length} skill / {steps.filter((step) => step.actor_type === 'tool').length} tool
                      </span>
                      <span className="candidate-card-action" aria-hidden="true">
                        {readOnly ? '只读预览' : current ? '点击选择' : '点击查看'}
                      </span>
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {candidates.length > 1 ? (
          <div className="candidate-carousel-controls" aria-label="方案滑动导航">
            <button
              type="button"
              className="candidate-carousel-arrow"
              aria-label="上一个方案"
              disabled={!canScrollPrevious || loading}
              onClick={() => carouselApi?.scrollPrev(shouldReduceMotion())}
            >
              <ArrowIcon direction="previous" />
            </button>
            <div className="candidate-carousel-position">
              <span className="candidate-carousel-count" aria-hidden="true">
                {String(currentIndex + 1).padStart(2, '0')} / {String(candidates.length).padStart(2, '0')}
              </span>
              <div className="candidate-carousel-dots">
                {candidates.map((candidate, candidateIndex) => (
                  <button
                    key={candidate.planVersionId}
                    type="button"
                    data-carousel-index={candidateIndex}
                    className={`candidate-carousel-dot${candidateIndex === currentIndex ? ' is-current' : ''}`}
                    aria-label={`查看第 ${candidateIndex + 1} 个方案：${candidate.title}`}
                    aria-current={candidateIndex === currentIndex ? 'true' : undefined}
                    disabled={loading}
                    tabIndex={candidateIndex === currentIndex ? 0 : -1}
                    onClick={() => scrollTo(candidateIndex)}
                  />
                ))}
              </div>
            </div>
            <button
              type="button"
              className="candidate-carousel-arrow"
              aria-label="下一个方案"
              disabled={!canScrollNext || loading}
              onClick={() => carouselApi?.scrollNext(shouldReduceMotion())}
            >
              <ArrowIcon direction="next" />
            </button>
          </div>
        ) : null}
        <p className="sr-only" aria-live="polite">
          {currentCandidate ? `正在查看第 ${currentIndex + 1} 个方案：${currentCandidate.title}` : '暂无可选方案'}
        </p>
      </div>
    </section>
  );
}
