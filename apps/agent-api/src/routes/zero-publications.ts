import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { ControlZeroPublication } from '../../../../database/control-plane.ts';
import {
  parseCreateZeroPublicationRequest,
  ZeroPublicationContractError,
  type ZeroIntegrationStatusResponse,
} from '../../../../packages/api-contract/zero-publication.ts';
import {
  ZeroPublicationServiceError,
} from '../integrations/zero/zero-publication-service.ts';
import { requireAuth, requireLoopbackPeer } from '../middleware.ts';

export interface ZeroPublicationHttpPort {
  status(): Promise<ZeroIntegrationStatusResponse>;
  create(input: {
    taskId: string;
    ownerUserId: string;
    expectedTaskState: 'completed' | 'completed_with_gaps';
    idempotencyKey: string;
    updatePublicationId?: string;
  }): Promise<ControlZeroPublication>;
  execute(publicationId: string, ownerUserId: string): Promise<ControlZeroPublication>;
  get(publicationId: string, taskId: string, ownerUserId: string): Promise<ControlZeroPublication | null>;
}

type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function publicationResponse(row: ControlZeroPublication) {
  return {
    id: row.id,
    publicationId: row.id,
    taskId: row.taskId,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    zeroFileKey: row.zeroFileKey,
    zeroPageId: row.zeroPageId,
    zeroPageName: row.zeroPageName,
    draftRootNodeId: row.draftRootNodeId,
    finalRootNodeId: row.finalRootNodeId,
    updatePublicationId: row.updatePublicationId,
    imageManifest: row.imageManifest,
    screenshotManifest: row.screenshotManifest,
    receiptArtifactId: row.receiptArtifactId,
    failure: row.failure,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function statusFor(error: ZeroPublicationServiceError): number {
  if (error.code === 'task_not_found' || error.code === 'publication_not_found') return 404;
  if (error.code === 'zero_offline' || error.code === 'zero_unauthenticated' || error.code === 'zero_no_design_tab') return 503;
  if (
    error.code === 'task_not_publishable'
    || error.code === 'report_not_completed'
    || error.code === 'report_package_missing'
    || error.code === 'idempotency_conflict'
    || error.code === 'publication_conflict'
    || error.code === 'publication_lease_lost'
  ) return 409;
  if (error.code === 'invalid_request' || error.code === 'update_target_invalid' || error.code === 'update_not_supported') return 400;
  return 422;
}

function sendError(error: unknown, res: Response): void {
  if (error instanceof ZeroPublicationContractError) {
    res.status(400).json({ error: error.message, code: 'invalid_request' });
    return;
  }
  if (error instanceof ZeroPublicationServiceError) {
    res.status(statusFor(error)).json({
      error: error.message,
      code: error.code,
      retryable: error.retryable,
    });
    return;
  }
  res.status(500).json({ error: 'Zero publication request failed', code: 'internal_error' });
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => { void handler(req, res); };
}

function routeParam(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export function createZeroIntegrationRouter(
  service: Pick<ZeroPublicationHttpPort, 'status'> | undefined,
  auth: AuthMiddleware = requireAuth,
): Router {
  const router = Router();
  router.get('/status', requireLoopbackPeer, auth, asyncRoute(async (_req, res) => {
    if (!service) {
      res.json({ available: false, authenticated: false, reason: 'disabled' });
      return;
    }
    try {
      res.json(await service.status());
    } catch (error) {
      sendError(error, res);
    }
  }));
  return router;
}

export function createZeroPublicationRouter(
  service: ZeroPublicationHttpPort | undefined,
  auth: AuthMiddleware = requireAuth,
): Router {
  const router = Router();

  router.post('/:taskId/publications/zero', requireLoopbackPeer, auth, asyncRoute(async (req, res) => {
    if (!service) {
      res.status(503).json({ error: 'Zero publication is disabled', code: 'zero_offline' });
      return;
    }
    try {
      const request = parseCreateZeroPublicationRequest(req.body);
      const idempotencyKey = req.header('Idempotency-Key')?.trim();
      if (!idempotencyKey) throw new ZeroPublicationContractError('Idempotency-Key header is required');
      const ownerUserId = req.userId;
      if (!ownerUserId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const publication = await service.create({
        taskId: routeParam(req.params.taskId),
        ownerUserId,
        expectedTaskState: request.expectedTaskState,
        idempotencyKey,
      });
      if (publication.status !== 'completed') {
        void service.execute(publication.id, ownerUserId).catch(() => undefined);
      }
      res.status(publication.status === 'completed' ? 200 : 202).json(publicationResponse(publication));
    } catch (error) {
      sendError(error, res);
    }
  }));

  router.get('/:taskId/publications/zero/:publicationId', requireLoopbackPeer, auth, asyncRoute(async (req, res) => {
    if (!service) {
      res.status(503).json({ error: 'Zero publication is disabled', code: 'zero_offline' });
      return;
    }
    try {
      const ownerUserId = req.userId;
      if (!ownerUserId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const publication = await service.get(
        routeParam(req.params.publicationId),
        routeParam(req.params.taskId),
        ownerUserId,
      );
      if (!publication) {
        res.status(404).json({ error: 'Publication not found', code: 'publication_not_found' });
        return;
      }
      res.json(publicationResponse(publication));
    } catch (error) {
      sendError(error, res);
    }
  }));

  return router;
}
