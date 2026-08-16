export interface ScheduledStep {
  key: string;
  dependsOn: string[];
  tier?: 'core' | 'optional' | string;
}

export interface ScheduledPlan {
  steps: ScheduledStep[];
}

export interface SchedulerExecutionContext {
  reusableOutputs: Record<string, unknown>;
}

export interface SchedulerCheckpoint {
  output: unknown;
  fingerprint?: string;
  valid?: boolean;
}

export type SchedulerCheckpoints = Record<string, SchedulerCheckpoint | null | undefined>;

export type SchedulerStepStatus = 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'reused';

export interface ScheduleResult {
  waves: string[][];
  statuses: Record<string, SchedulerStepStatus>;
  outputs: Record<string, unknown>;
  errors: Record<string, unknown>;
}

interface SchedulerDependencies {
  execute(step: ScheduledStep, context: SchedulerExecutionContext): Promise<unknown>;
}

function checkpointOutput(value: unknown): { reusable: boolean; output: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { reusable: false, output: undefined };
  const checkpoint = value as SchedulerCheckpoint;
  if (checkpoint.valid === false || !Object.prototype.hasOwnProperty.call(checkpoint, 'output')) {
    return { reusable: false, output: undefined };
  }
  return { reusable: true, output: checkpoint.output };
}

export class ExecutionScheduler {
  constructor(private readonly dependencies: SchedulerDependencies) {}

  async schedule(
    plan: ScheduledPlan,
    checkpoints: SchedulerCheckpoints,
  ): Promise<ScheduleResult> {
    const steps = plan.steps ?? [];
    const byKey = new Map<string, ScheduledStep>();
    for (const step of steps) {
      if (byKey.has(step.key)) throw new Error(`duplicate execution step: ${step.key}`);
      byKey.set(step.key, step);
    }
    for (const step of steps) {
      for (const dependency of step.dependsOn ?? []) {
        if (!byKey.has(dependency)) throw new Error(`execution step ${step.key} depends on unknown step ${dependency}`);
      }
    }

    const statuses: Record<string, SchedulerStepStatus> = {};
    const outputs: Record<string, unknown> = {};
    const errors: Record<string, unknown> = {};
    const reusableOutputs: Record<string, unknown> = {};
    const completed = new Set<string>();
    const waves: string[][] = [];

    while (completed.size < steps.length) {
      const wave = steps
        .filter((step) => !completed.has(step.key))
        .filter((step) => (step.dependsOn ?? []).every((dependency) => completed.has(dependency)))
        .map((step) => step.key);

      if (wave.length === 0) {
        const unresolved = steps.filter((step) => !completed.has(step.key)).map((step) => step.key);
        throw new Error(`execution plan contains a dependency cycle: ${unresolved.join(', ')}`);
      }
      waves.push(wave);

      const runnable: ScheduledStep[] = [];
      for (const key of wave) {
        const step = byKey.get(key)!;
        const failedDependency = (step.dependsOn ?? []).find((dependency) => {
          const dependencyStatus = statuses[dependency];
          return dependencyStatus === 'failed' || dependencyStatus === 'blocked' || dependencyStatus === 'cancelled';
        });
        if (failedDependency) {
          const dependencyStep = byKey.get(failedDependency)!;
          const dependencyStatus = statuses[failedDependency];
          statuses[key] = dependencyStatus === 'cancelled'
            || dependencyStep.tier === 'core'
            || dependencyStatus === 'failed' && dependencyStep.tier === 'core'
            ? 'cancelled'
            : 'blocked';
          completed.add(key);
          continue;
        }

        const checkpoint = checkpointOutput(checkpoints?.[key]);
        if (checkpoint.reusable) {
          statuses[key] = 'reused';
          outputs[key] = checkpoint.output;
          reusableOutputs[key] = checkpoint.output;
          completed.add(key);
          continue;
        }

        runnable.push(step);
      }

      const settled = await Promise.allSettled(
        runnable.map((step) => this.dependencies.execute(step, { reusableOutputs: { ...reusableOutputs } })),
      );
      for (let index = 0; index < runnable.length; index += 1) {
        const step = runnable[index]!;
        const result = settled[index]!;
        if (result.status === 'fulfilled') {
          statuses[step.key] = 'succeeded';
          outputs[step.key] = result.value;
          reusableOutputs[step.key] = result.value;
        } else {
          statuses[step.key] = 'failed';
          errors[step.key] = result.reason;
        }
        completed.add(step.key);
      }
    }

    return { waves, statuses, outputs, errors };
  }
}
