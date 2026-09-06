import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type {
  ConfirmSkillNativeTaskRequest,
  CreateSkillNativeTaskRequest,
  PublishSkillNativeReportRequest,
  ResumeSkillNativeTaskRequest,
  SkillNativeInputAnswer,
} from '../../../../packages/api-contract/skill-native.ts';
import {
  SkillNativeTaskService,
  SkillNativeWorkflowError,
} from '../../../orchestrator-runtime/src/skill-native/service.ts';
import { SkillNativeStoreError } from '../../../orchestrator-runtime/src/skill-native/store.ts';
import { requireAuth, requireLoopbackPeer } from '../middleware.ts';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function expectedVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function inputAnswers(value: unknown): Record<string, SkillNativeInputAnswer> | null {
  const answers = record(value);
  if (!answers) return null;
  for (const answer of Object.values(answers)) {
    const item = record(answer);
    if (
      !item
      || (item.source !== 'conversation' && item.source !== 'upload')
      || !Object.hasOwn(item, 'value')
      || Object.keys(item).some((key) => key !== 'source' && key !== 'value')
    ) return null;
  }
  return answers as Record<string, SkillNativeInputAnswer>;
}

function publicError(res: Response, error: unknown): void {
  if (error instanceof SkillNativeStoreError) {
    res.status(error.code === 'not_found' ? 404 : 409).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof SkillNativeWorkflowError) {
    const status = error.code === 'not_found'
      ? 404
      : error.code === 'conflict' ? 409
        : error.code === 'unavailable' ? 409 : 422;
    res.status(status).json({ error: error.message, code: error.code, ...(error.details === undefined ? {} : { details: error.details }) });
    return;
  }
  res.status(500).json({ error: 'Skill 原生任务处理失败' });
}

type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

export type SkillNativeTasksHttpPort = Pick<
  SkillNativeTaskService,
  'catalog' | 'list' | 'create' | 'get' | 'select' | 'confirm' | 'execute' | 'cancel' | 'resume' | 'replan' | 'html' | 'markdown' | 'artifact' | 'skillResult' | 'publishZero'
>;

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => { void handler(req, res); };
}

function routeParam(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export function createSkillNativeTasksRouter(
  service: SkillNativeTasksHttpPort,
  auth: AuthMiddleware = requireAuth,
): Router {
  const router = Router();
  router.use(auth);
  router.use(express.json({ limit: '16mb' }));

  router.get('/catalog', (_req, res) => {
    try {
      res.json(service.catalog());
    } catch (error) {
      publicError(res, error);
    }
  });

  router.get('/', asyncRoute(async (req, res) => {
    try {
      res.json({ tasks: await service.list(req.userId!) });
    } catch (error) {
      publicError(res, error);
    }
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const body = record(req.body);
    const providedInputs = inputAnswers(body?.inputs ?? {});
    if (
      !body
      || typeof body.originalInput !== 'string'
      || (body.orchestrationMode !== 'single_skill' && body.orchestrationMode !== 'multi_skill')
      || (body.projectId !== undefined && typeof body.projectId !== 'string')
      || !providedInputs
    ) {
      res.status(400).json({ error: 'originalInput、orchestrationMode 或 inputs 无效' });
      return;
    }
    try {
      const request: CreateSkillNativeTaskRequest = {
        originalInput: body.originalInput,
        orchestrationMode: body.orchestrationMode,
        ...(typeof body.projectId === 'string' ? { projectId: body.projectId } : {}),
        inputs: providedInputs,
      };
      res.status(201).json(await service.create(req.userId!, request));
    } catch (error) {
      publicError(res, error);
    }
  }));

  router.get('/:id', asyncRoute(async (req, res) => {
    try {
      res.json(await service.get(routeParam(req.params.id), req.userId!));
    } catch (error) {
      publicError(res, error);
    }
  }));

  router.post('/:id/select', asyncRoute(async (req, res) => {
    const body = record(req.body);
    const version = expectedVersion(body?.expectedVersion);
    if (version === null || typeof body?.candidateId !== 'string' || !body.candidateId.trim()) {
      res.status(400).json({ error: 'expectedVersion 和 candidateId 必填' });
      return;
    }
    try {
      res.json(await service.select({
        taskId: routeParam(req.params.id),
        ownerUserId: req.userId!,
        expectedVersion: version,
        candidateId: body.candidateId,
      }));
    } catch (error) {
      publicError(res, error);
    }
  }));

  router.post('/:id/confirm', asyncRoute(async (req, res) => {
    const body = record(req.body);
    const version = expectedVersion(body?.expectedVersion);
    const answers = inputAnswers(body?.answers ?? {});
    if (version === null || !answers) {
      res.status(400).json({ error: 'expectedVersion 和 answers 必填' });
      return;
    }
    try {
      const request: ConfirmSkillNativeTaskRequest = { expectedVersion: version, answers };
      res.json(await service.confirm({ taskId: routeParam(req.params.id), ownerUserId: req.userId!, body: request }));
    } catch (error) {
      publicError(res, error);
    }
  }));

  for (const action of ['execute', 'cancel', 'replan'] as const) {
    router.post(`/:id/${action}`, asyncRoute(async (req, res) => {
      const version = expectedVersion(record(req.body)?.expectedVersion);
      if (version === null) {
        res.status(400).json({ error: 'expectedVersion 必填' });
        return;
      }
      try {
        res.json(await service[action]({ taskId: routeParam(req.params.id), ownerUserId: req.userId!, expectedVersion: version }));
      } catch (error) {
        publicError(res, error);
      }
    }));
  }

  router.post('/:id/resume', asyncRoute(async (req, res) => {
    const body = record(req.body);
    const version = expectedVersion(body?.expectedVersion);
    const answers = inputAnswers(body?.answers ?? {});
    if (version === null || !answers) {
      res.status(400).json({ error: 'expectedVersion 和 answers 必填' });
      return;
    }
    try {
      const request: ResumeSkillNativeTaskRequest = { expectedVersion: version, answers };
      res.json(await service.resume({
        taskId: routeParam(req.params.id),
        ownerUserId: req.userId!,
        body: request,
      }));
    } catch (error) {
      publicError(res, error);
    }
  }));

  router.get('/:id/report.html', asyncRoute(async (req, res) => {
    try {
      const html = await service.html(routeParam(req.params.id), req.userId!);
      if (!html) {
        res.status(404).json({ error: '报告不存在' });
        return;
      }
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'inline; filename="research-report.html"',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(html);
    } catch (error) {
      publicError(res, error);
    }
  }));

  router.get('/:id/artifacts/:artifactId', asyncRoute(async (req, res) => {
    try {
      const artifact = await service.artifact(
        routeParam(req.params.id),
        req.userId!,
        routeParam(req.params.artifactId),
      );
      if (!artifact) {
        res.status(404).json({ error: 'Artifact 不存在' });
        return;
      }
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': ['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mediaType)
          ? 'inline'
          : 'attachment',
        'Content-Length': String(artifact.bytes.byteLength),
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Type': artifact.mediaType,
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(artifact.bytes);
    } catch (error) {
      publicError(res, error);
    }
  }));

  router.get('/:id/results/:invocationId.json', asyncRoute(async (req, res) => {
    try {
      const report = await service.skillResult(
        routeParam(req.params.id),
        req.userId!,
        routeParam(req.params.invocationId),
      );
      if (!report) {
        res.status(404).json({ error: 'Skill 结果不存在' });
        return;
      }
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'attachment; filename="skill-result.json"',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(JSON.stringify(report, null, 2));
    } catch (error) {
      publicError(res, error);
    }
  }));

  router.post('/:id/publications/zero', requireLoopbackPeer, asyncRoute(async (req, res) => {
    const body = record(req.body);
    const version = expectedVersion(body?.expectedVersion);
    const target = record(body?.target);
    if (
      version === null
      || !target
      || Object.keys(body ?? {}).some((key) => key !== 'expectedVersion' && key !== 'target')
      || Object.keys(target).some((key) => key !== 'mode')
      || target.mode !== 'current_page'
    ) {
      res.status(400).json({ error: 'expectedVersion 和 current_page target 必填' });
      return;
    }
    try {
      const request: PublishSkillNativeReportRequest = {
        expectedVersion: version,
        target: { mode: 'current_page' },
      };
      res.status(201).json(await service.publishZero({
        taskId: routeParam(req.params.id),
        ownerUserId: req.userId!,
        expectedVersion: request.expectedVersion,
      }));
    } catch (error) {
      publicError(res, error);
    }
  }));

  router.get('/:id/report.md', asyncRoute(async (req, res) => {
    try {
      const markdown = await service.markdown(routeParam(req.params.id), req.userId!);
      if (!markdown) {
        res.status(404).json({ error: '报告不存在' });
        return;
      }
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'attachment; filename="research-report.md"',
        'Content-Type': 'text/markdown; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(markdown);
    } catch (error) {
      publicError(res, error);
    }
  }));

  return router;
}
