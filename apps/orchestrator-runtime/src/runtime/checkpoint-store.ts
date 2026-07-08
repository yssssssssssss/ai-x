import * as repo from '../../../../database/repository.ts';

// 会话与步骤状态外置到 DB(方案 §2.5)。
// Agent Runtime 通过此 store 落库,不直接碰 SQL。
// 平台 DB 是可迁移/可审计/可恢复的真相源;runtime 自带 session 只是加速层。

export class CheckpointStore {
  // 段1:落库结构化任务
  createTask = repo.createResearchTask;
  getTask = repo.getResearchTask;
  updateTaskStatus = repo.updateTaskStatus;

  // 段2:决策节点状态(调度复盘核心)
  writeDecisionState = repo.writeDecisionState;
  listDecisionStates = repo.listDecisionStates;

  // 段3:执行日志(任务执行真相源 + 版本追溯)
  writeExecutionLog = repo.writeExecutionLog;
  listExecutionLog = repo.listExecutionLog;

  // 段4:产物
  writeArtifact = repo.writeArtifact;
  listArtifacts = repo.listArtifacts;

  // 会话/消息(会话记忆、历史回看)
  createConversation = repo.createConversation;
  writeMessage = repo.writeMessage;
  listMessages = repo.listMessages;
  listRecentTasks = repo.listRecentTasks;
}
