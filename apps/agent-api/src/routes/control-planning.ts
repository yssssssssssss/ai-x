import { Router } from 'express';
import { ControlPlaneAuthorizationError, ControlPlaneConflictError } from '../../../../database/control-plane.ts';
import {
  isOrchestrationModeV1,
  type ControlPlanCandidatesResponse,
  type ControlTaskResponse,
  type PlanningGuidanceClarification,
  type PlanControlTaskRequest,
} from '../../../../packages/api-contract/control-workflow.ts';
import type { ResearchTaskV2, PlanProgress } from '../../../../packages/api-contract/plan.ts';
import { OrchestrationModePlanningError } from '../../../orchestrator-runtime/src/planners/research-planning-service.ts';
import { ModelDriftError } from '../../../orchestrator-runtime/src/runtime/receipt-llm-client.ts';
import { requireAuth } from '../middleware.ts';

export type CurrentCandidatesResponse = ControlPlanCandidatesResponse & {
  status?: 'current_candidates';
};

export interface ClarificationRequiredResponse {
  kind: 'current';
  status: 'clarification_required';
  conversationId: string;
  task: ControlTaskResponse;
  structuredTask: ResearchTaskV2;
  activatedNodes: string[];
  candidates: [];
  planningGuidance?: PlanningGuidanceClarification;
}

export type CurrentPlanningResponse = CurrentCandidatesResponse | ClarificationRequiredResponse;

export interface ControlPlanningPort {
  plan(
    input: PlanControlTaskRequest & { ownerUserId: string },
    onProgress?: (event: PlanProgress) => void,
    // 新建会话后、planning resolve 前回调:让 SSE 能实时先发 conversation,不等规划完成。
    onConversation?: (conversationId: string) => void,
  ): Promise<CurrentPlanningResponse>;
}
function isConversationLookupError(error: unknown): boolean {
  if (error instanceof ControlPlaneAuthorizationError) return true;
  return error instanceof ControlPlaneConflictError
    && /^conversation .+ (?:does not exist|does not belong)/i.test(error.message);
}

function planningErrorMessage(error: unknown): string {
  if (error instanceof OrchestrationModePlanningError) return error.message;
  if (error instanceof ModelDriftError) return error.message;
  return isConversationLookupError(error)
    ? '会话不存在'
    : '需求解析或规划未完成，请重试；如仍失败，请补充希望获得的结果类型。';
}


export function createControlPlanningRouter(port: ControlPlanningPort): Router {
  const router = Router();
  router.use(requireAuth);

  router.post('/plan', async (req, res) => {
    const { originalInput, conversationId, orchestrationMode } = req.body ?? {};
    if (typeof originalInput !== 'string' || originalInput.trim().length === 0) {
      res.status(400).json({ error: 'originalInput 必须是非空字符串' });
      return;
    }
    if (!isOrchestrationModeV1(orchestrationMode)) {
      res.status(400).json({ error: 'orchestrationMode 必须是 single_skill 或 multi_skill' });
      return;
    }

    try {
      const response = await port.plan({
        originalInput,
        orchestrationMode,
        ...(typeof conversationId === 'string' && conversationId.trim().length > 0
          ? { conversationId }
          : {}),
        ownerUserId: req.userId!,
      });
      res.json(response);
    } catch (error) {
      if (error instanceof OrchestrationModePlanningError) {
        res.status(error.kind === 'unavailable' ? 409 : 422).json({ error: error.message });
        return;
      }
      if (isConversationLookupError(error)) {
        res.status(404).json({ error: '会话不存在' });
        return;
      }
      res.status(502).json({ error: planningErrorMessage(error) });
    }
  });

  router.post('/plan/stream', async (req, res) => {
    const { originalInput, conversationId, orchestrationMode } = req.body ?? {};
    if (typeof originalInput !== 'string' || originalInput.trim().length === 0) {
      res.status(400).json({ error: 'originalInput 必须是非空字符串' });
      return;
    }
    if (!isOrchestrationModeV1(orchestrationMode)) {
      res.status(400).json({ error: 'orchestrationMode 必须是 single_skill 或 multi_skill' });
      return;
    }

    const requestedConversationId = typeof conversationId === 'string'
      && conversationId.trim().length > 0
      ? conversationId
      : undefined;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const bufferedProgress: PlanProgress[] = [];
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // 新会话回调在 planning resolve 前发送;已有会话须等 ownership 成功后再发送。
    let conversationSent = false;
    const sendConversation = (id: string): void => {
      if (conversationSent) return;
      conversationSent = true;
      send('conversation', { conversationId: id });
    };
    try {
      const response = await port.plan({
        originalInput,
        orchestrationMode,
        ...(requestedConversationId ? { conversationId: requestedConversationId } : {}),
        ownerUserId: req.userId!,
      }, (event) => {
        if (conversationSent) send('progress', event);
        else bufferedProgress.push(event);
      }, (conversationId) => {
        sendConversation(conversationId);
        for (const event of bufferedProgress.splice(0)) send('progress', event);
      });
      sendConversation(response.conversationId);
      for (const event of bufferedProgress) send('progress', event);
      send('result', response);
    } catch (error) {
      send('error', { error: planningErrorMessage(error) });
    } finally {
      res.end();
    }
  });

  return router;
}
