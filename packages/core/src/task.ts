import { randomUUID } from "node:crypto";

/**
 * What an executor produces in one attempt. The runner stamps `taskId` and `attempt`
 * so an artifact is always traceable back to the run that produced it.
 */
export interface ArtifactInput {
  /** Stable id for this artifact; defaults to a UUID. */
  id?: string;
  createdAt?: number;
  /** The thing to verify: a patch, a draft, a file, a URL, a JSON blob. */
  content: string;
  meta?: Record<string, unknown>;
}

export interface Artifact extends ArtifactInput {
  id: string;
  taskId: string;
  attempt: number;
  createdAt: number;
}

export interface VerificationResult {
  ok: boolean;
  /** Short human-readable reason, shown in logs and returned to the executor next attempt. */
  detail: string;
  /** Optional score, so a host can keep the best attempt even when none pass. */
  score?: number;
}

export interface Task {
  id: string;
  goal: string;
  /** Upper bound on attempts. Defaults to 3. */
  maxAttempts?: number;
}

export interface TaskContext {
  task: Task;
  /** Previous attempts, oldest first. */
  attempts: Artifact[];
  /** Previous verifications, same order as `attempts`. */
  verifications: VerificationResult[];
  signal?: AbortSignal | undefined;
}

export interface TaskExecutor {
  /** Produce one attempt. It may read `context.attempts` to avoid repeating a failure. */
  execute(context: TaskContext): Promise<ArtifactInput> | ArtifactInput;
}

export interface Verifier {
  readonly name: string;
  /**
   * Decide whether an artifact solves the task. A verifier is the trust anchor of the loop:
   * if it cannot be run automatically and cheaply, the runner should not retry blindly.
   */
  check(artifact: Artifact, context: TaskContext): Promise<VerificationResult> | VerificationResult;
}

export interface TaskRunResult {
  task: Task;
  status: "verified" | "exhausted" | "blocked";
  attempts: Artifact[];
  verifications: VerificationResult[];
  winner?: Artifact;
  error?: string;
}

export interface TaskRunnerOptions {
  executor: TaskExecutor;
  verifier: Verifier;
  now?: () => number;
  logger?: { warn(message: string, error?: unknown): void };
  /** Called before each attempt. Return false to stop (budget, pause, human veto). */
  canStart?: (attempt: number, context: TaskContext) => boolean;
  /** Called after each attempt, pass or fail. Useful for traces and audit logs. */
  onAttempt?: (artifact: Artifact, result: VerificationResult) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * A small verify-retry loop.
 *
 * It does not call a model, run a shell or decide what "done" means: the host supplies an
 * executor and a verifier. That split is deliberate — the verifier is the part you can trust,
 * and it must be checkable without a human.
 */
export class TaskRunner {
  private readonly executor: TaskExecutor;
  private readonly verifier: Verifier;
  private readonly now: () => number;
  private readonly logger: { warn(message: string, error?: unknown): void };
  private readonly canStart: TaskRunnerOptions["canStart"];
  private readonly onAttempt: TaskRunnerOptions["onAttempt"];

  constructor(options: TaskRunnerOptions) {
    this.executor = options.executor;
    this.verifier = options.verifier;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? { warn: (message, error) => console.warn(message, error) };
    this.canStart = options.canStart;
    this.onAttempt = options.onAttempt;
  }

  async run(task: Task, options: { signal?: AbortSignal } = {}): Promise<TaskRunResult> {
    const maxAttempts = Math.max(1, task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const attempts: Artifact[] = [];
    const verifications: VerificationResult[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.signal?.aborted) {
        return { task, status: "blocked", attempts, verifications, error: "aborted" };
      }
      const context: TaskContext = {
        task,
        attempts: [...attempts],
        verifications: [...verifications],
        ...(options.signal ? { signal: options.signal } : {}),
      };
      if (this.canStart && !this.canStart(attempt, context)) {
        return { task, status: "blocked", attempts, verifications, error: "canStart returned false" };
      }

      let produced: ArtifactInput;
      try {
        produced = await this.executor.execute(context);
      } catch (error: unknown) {
        this.logger.warn(`task ${task.id} attempt ${attempt} failed to execute`, error);
        verifications.push({
          ok: false,
          detail: error instanceof Error ? error.message : "executor failed",
        });
        continue;
      }

      const artifact: Artifact = {
        ...produced,
        id: produced.id ?? randomUUID(),
        taskId: task.id,
        attempt,
        createdAt: produced.createdAt ?? this.now(),
      };

      let result: VerificationResult;
      try {
        result = await this.verifier.check(artifact, context);
      } catch (error: unknown) {
        this.logger.warn(`task ${task.id} verifier ${this.verifier.name} threw`, error);
        result = {
          ok: false,
          detail: error instanceof Error ? error.message : "verifier failed",
        };
      }

      attempts.push(artifact);
      verifications.push(result);
      try {
        this.onAttempt?.(artifact, result);
      } catch (error: unknown) {
        this.logger.warn("onAttempt callback failed", error);
      }

      if (result.ok) {
        return { task, status: "verified", attempts, verifications, winner: artifact };
      }
    }

    return { task, status: "exhausted", attempts, verifications };
  }
}
