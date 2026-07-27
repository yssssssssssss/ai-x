import { useState } from 'react';
import {
  api,
  type PlanCandidatesResponse,
  type PlanCandidate,
  type PlanResponse,
  type ExecuteResponse,
  type Upload,
  type PlanProgress,
  ApiError,
} from '../api/client.ts';

// 任务执行流状态机(与 UI 解耦,可脱离 dom 推理/守护):
// idle → planning → picking(选候选)→ selecting(POST select)→ planned(确认闸门)
//      → executing →(paused 失败步待决策)→ done;任意步出错落 error。
export type Phase =
  | 'idle' | 'planning' | 'picking' | 'selecting'
  | 'planned' | 'executing' | 'paused' | 'done' | 'error';

// 执行成功后的副作用回调(如刷新历史列表)——导航关注点由调用方注入,hook 不自持。
export interface UseTaskFlowOptions {
  onExecuted?: () => void;
}

export function useTaskFlow(options: UseTaskFlowOptions = {}) {
  const { onExecuted } = options;
  const [phase, setPhase] = useState<Phase>('idle');
  const [candidatesResp, setCandidatesResp] = useState<PlanCandidatesResponse | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<PlanCandidate['id'] | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null); // finalize 后
  const [originalInput, setOriginalInput] = useState('');
  const [exec, setExec] = useState<ExecuteResponse | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<PlanProgress[]>([]); // 规划阶段流式进度

  function reset() {
    setPhase('idle');
    setCandidatesResp(null); setSelectedCandidateId(null); setPlan(null); setExec(null);
    setOriginalInput(''); setError(''); setProgress([]);
  }

  async function submitInput(text: string) {
    setPhase('planning'); setCandidatesResp(null); setPlan(null); setExec(null); setError('');
    setSelectedCandidateId(null); setOriginalInput(text); setProgress([]);
    try {
      const resp = await api.planStream(
        { originalInput: text },
        {
          onProgress: (ev) => {
            // start 追加占位;done 更新同 phase 的最后一条为完成态
            setProgress((prev) => {
              const i = prev.findIndex((p) => p.phase === ev.phase);
              if (i >= 0) { const next = [...prev]; next[i] = ev; return next; }
              return [...prev, ev];
            });
          },
        },
      );
      setCandidatesResp(resp);
      setPhase('picking');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '规划失败'); setPhase('error');
    }
  }

  async function pickCandidate(candidateId: PlanCandidate['id']) {
    if (!candidatesResp) return;
    setSelectedCandidateId(candidateId); setPhase('selecting'); setError('');
    try {
      const r = await api.selectCandidate(candidatesResp.taskId, candidateId);
      // 拼成 Stage2Plan 期望的 PlanResponse 形状(复用现成组件)。
      setPlan({
        conversationId: candidatesResp.conversationId,
        taskId: candidatesResp.taskId,
        task: candidatesResp.task,
        activatedNodes: candidatesResp.activatedNodes,
        plan: r.plan,
        pendingUploads: r.pendingUploads,
      });
      setPhase('planned');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '候选选择失败');
      setSelectedCandidateId(null); setPhase('picking'); // 回到选择态,让用户重选
    }
  }

  async function confirmAndExecute(uploads: Upload[] = []) {
    if (!plan) return;
    setPhase('executing'); setError('');
    try {
      const r = await api.execute(plan.taskId, uploads);
      setExec(r); onExecuted?.();
      setPhase(r.status === 'paused' ? 'paused' : 'done');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '执行失败'); setPhase('error');
    }
  }

  // 失败步恢复:skip=跳过该步续跑,abort=终止任务。
  async function resumeStep(action: 'skip' | 'abort') {
    if (!plan) return;
    setPhase('executing'); setError('');
    try {
      const r = await api.resume(plan.taskId, action);
      setExec(r); onExecuted?.();
      setPhase(r.status === 'paused' ? 'paused' : 'done');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '恢复失败'); setPhase('error');
    }
  }

  return {
    phase, candidatesResp, selectedCandidateId, plan, originalInput, exec, error, progress,
    reset, submitInput, pickCandidate, confirmAndExecute, resumeStep,
  };
}
