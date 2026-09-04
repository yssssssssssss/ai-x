import type {
  SkillNativeZeroPublication,
  SkillNativeZeroPublicationDraft,
} from '../../../../../packages/api-contract/skill-native.ts';
import type { SkillNativeReportPublisher } from '../../../../orchestrator-runtime/src/skill-native/service.ts';
import type { ZeroPublicationMcp } from './zero-publication-service.ts';

export class SkillNativeZeroPublisher implements SkillNativeReportPublisher {
  constructor(private readonly zero: ZeroPublicationMcp) {}

  async prepare(input: {
    taskId: string;
    title: string;
    html: string;
  }): Promise<SkillNativeZeroPublicationDraft> {
    const status = await this.zero.getStatus();
    if (!status.available) throw new Error('Zero 未启动');
    if (!status.authenticated) throw new Error('Zero 尚未登录');
    const target = await this.zero.getCurrentTarget();
    const finalName = `[ai-x:${input.taskId}] ${input.title}`;
    const draft = await this.zero.createHtmlDraft({ html: input.html, name: `[draft] ${finalName}` });
    return {
      taskId: input.taskId,
      fileKey: target.fileKey,
      pageId: target.pageId,
      pageName: target.pageName,
      draftRootNodeId: draft.rootNodeId,
      finalName,
    };
  }

  async finalize(draft: SkillNativeZeroPublicationDraft): Promise<SkillNativeZeroPublication> {
    const published = await this.zero.finalizeDraft({
      pageId: draft.pageId,
      draftRootNodeId: draft.draftRootNodeId,
      finalName: draft.finalName,
    });
    return {
      taskId: draft.taskId,
      fileKey: draft.fileKey,
      pageId: draft.pageId,
      pageName: draft.pageName,
      rootNodeId: published.finalRootNodeId,
    };
  }

  async cleanup(draft: SkillNativeZeroPublicationDraft): Promise<void> {
    await this.zero.cleanupDraft({ pageId: draft.pageId, rootNodeId: draft.draftRootNodeId });
  }
}
