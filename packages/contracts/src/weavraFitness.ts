import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId } from "./baseSchemas.ts";

const count = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const nullableCount = Schema.NullOr(count);
const digest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/));
const id = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
);
const identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/));
const integrityReason = Schema.Literals([
  "AUTH_ERROR",
  "PROVIDER_ERROR",
  "TRANSPORT_ERROR",
  "TOOL_PROTOCOL_ERROR",
  "MEASUREMENT_INVALID",
  "ORACLE_INVALID",
  "CLEANUP_UNCONFIRMED",
  "USAGE_UNKNOWN",
  "TIMEOUT",
  "HARNESS_DEFECT",
]);
const integrityReasons = Schema.Array(integrityReason).check(Schema.isMaxLength(10));
const integrity = Schema.Struct({
  state: Schema.Literals(["READY", "INVALID"]),
  reasons: integrityReasons,
});
const target = Schema.Struct({
  provider: identifier,
  model: identifier,
  api: identifier,
  endpointIdentity: digest,
  harnessRevision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  toolSchemaRevision: digest,
  promptRuntimeRevision: digest,
  configurationDigest: digest,
});
export const WeavraFitnessSummary = Schema.Struct({
  id,
  target,
  status: Schema.Literals([
    "RUNNING",
    "COMPLETED",
    "CANCELLED",
    "BUDGET_EXHAUSTED",
    "CALIBRATION_FAILED",
    "FAILED",
    "INTERRUPTED",
  ]),
  kind: Schema.Literals(["ACTUAL", "FAUX"]),
  calibration: Schema.optionalKey(
    Schema.Literals(["PENDING", "CALIBRATION_READY", "CALIBRATION_INVALID"]),
  ),
  evaluation: Schema.optionalKey(Schema.Literals(["EVALUATION_PARTIAL", "EVALUATION_COMPLETE"])),
  stopReasons: Schema.optionalKey(integrityReasons),
  fixtureResults: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        fixtureId: identifier,
        terminalStatus: Schema.Literals([
          "COMPLETED",
          "BLOCKED",
          "FAILED",
          "CANCELLED",
          "INTERRUPTED",
          "NOT_STARTED",
          "UNKNOWN",
        ]),
        oracle: Schema.Literals(["PASS", "FAIL", "INVALID"]),
        falseCompletion: Schema.NullOr(Schema.Boolean),
        taskContractAdherence: Schema.NullOr(Schema.Boolean),
        usageState: Schema.Literals(["KNOWN", "UNKNOWN"]),
        latencyMs: count,
        integrity: Schema.NullOr(integrity),
      }),
    ).check(Schema.isMaxLength(64)),
  ),
  correctness: Schema.Struct({
    executed: count,
    oraclePass: count,
    oracleFail: count,
    invalid: count,
    falseCompletion: count,
  }),
  contract: Schema.Struct({
    scopeViolations: count,
    forbiddenMutationAttempts: count,
    strictReceiptRejections: count,
    handoffRejections: count,
    reviewRejections: count,
  }),
  tools: Schema.Struct({
    calls: count,
    invalidCalls: count,
    retries: count,
    runtimeRead: count,
    runtimeEdit: count,
    runtimeWrite: count,
    lsp: count,
  }),
  reliability: Schema.Struct({
    providerErrors: count,
    authErrors: count,
    transportErrors: nullableCount,
    timeouts: count,
    repairCount: count,
    reviewerRevisionCount: count,
  }),
  efficiency: Schema.Struct({
    workerInvocations: count,
    modelTurns: count,
    tokens: nullableCount,
    knownTokens: count,
    latencyMs: count,
    contextBytes: count,
    costUsd: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
});
export type WeavraFitnessSummary = typeof WeavraFitnessSummary.Type;
export const WeavraFitnessHistory = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  corpusRevision: identifier,
  corpusDigest: digest,
  fixtures: Schema.Array(
    Schema.Struct({
      id: identifier,
      category: identifier,
      language: identifier,
      digest,
      expectedTerminal: Schema.Array(
        Schema.Literals(["COMPLETED", "BLOCKED", "FAILED", "CANCELLED"]),
      ).check(Schema.isMaxLength(4)),
      budget: Schema.Struct({
        maxWorkerCalls: count,
        maxTotalTokens: count,
        workerTimeoutMs: count,
      }),
    }),
  ).check(Schema.isMaxLength(64)),
  runs: Schema.Array(
    Schema.Struct({
      ...WeavraFitnessSummary.fields,
      corpusRevision: identifier,
      corpusDigest: digest,
      startedAt: count,
      completedAt: nullableCount,
      resultDigest: digest,
    }),
  ).check(Schema.isMaxLength(32)),
});
export type WeavraFitnessHistory = typeof WeavraFitnessHistory.Type;
export const WeavraFitnessComparison = Schema.Struct({
  compatibility: Schema.Struct({
    corpus: Schema.Boolean,
    budget: Schema.Boolean,
    harness: Schema.Boolean,
    configuration: Schema.Boolean,
    fixtures: Schema.Boolean,
    kind: Schema.Boolean,
  }),
  comparable: Schema.Boolean,
  left: WeavraFitnessSummary,
  right: WeavraFitnessSummary,
});
export type WeavraFitnessComparison = typeof WeavraFitnessComparison.Type;
export const WeavraFitnessInput = Schema.Union([
  Schema.Struct({ projectId: ProjectId, command: Schema.Literal("list") }),
  Schema.Struct({ projectId: ProjectId, command: Schema.Literal("compare"), left: id, right: id }),
]);
export type WeavraFitnessInput = typeof WeavraFitnessInput.Type;
export const WeavraFitnessResponse = Schema.Union([
  Schema.Struct({ command: Schema.Literal("list"), data: WeavraFitnessHistory }),
  Schema.Struct({ command: Schema.Literal("compare"), data: WeavraFitnessComparison }),
]);
export type WeavraFitnessResponse = typeof WeavraFitnessResponse.Type;
export class WeavraFitnessError extends Schema.TaggedError<WeavraFitnessError>()(
  "WeavraFitnessError",
  {
    code: Schema.Literals(["UNAVAILABLE", "INVALID_PAYLOAD", "PROJECT_CHANGED"]),
  },
) {}
