import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId } from "./baseSchemas.ts";

export const WEAVRA_MAX_REQUEST_BYTES = 4096;
export const WEAVRA_MAX_RESPONSE_BYTES = 65536;
export const WEAVRA_READ_COMMANDS = [
  "hello",
  "capabilities",
  "status",
  "current-run",
  "graph",
  "evidence-summary",
  "config-summary",
  "snapshot",
] as const;
const identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/));
const counter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const status = Schema.Literals([
  "CREATED",
  "RUNNING",
  "WAITING_APPROVAL",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
  "COMPLETED",
]);
const step = Schema.Struct({
  stepId: Schema.Literals(["implement", "self-check", "review", "test", "complete"]),
  attempt: counter,
});
const identity = {
  protocolVersion: Schema.Literal(1),
  runId: Schema.NullOr(identifier),
  stateRevision: Schema.NullOr(counter),
  projectRevision: Schema.NullOr(counter),
  eventId: Schema.NullOr(identifier),
  timestamp: counter,
};
export const WeavraHostRequest = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  id: identifier,
  type: Schema.Literals(WEAVRA_READ_COMMANDS),
  runId: Schema.optionalKey(identifier),
  clientName: Schema.optionalKey(identifier),
  capabilities: Schema.optionalKey(
    Schema.Array(Schema.Literal("snapshots-only")).check(Schema.isMaxLength(1)),
  ),
});
export type WeavraHostRequest = typeof WeavraHostRequest.Type;
export const WeavraCapabilities = Schema.Struct({
  readOnly: Schema.Literal(true),
  commands: Schema.Array(Schema.Literals(WEAVRA_READ_COMMANDS)),
  events: Schema.Literal("observations-only"),
  reconnect: Schema.Literal("fresh-canonical-snapshot-no-replay"),
  authority: Schema.Literal("Runtime/Kernel"),
  maxRequestBytes: Schema.Literal(4096),
  maxResponseBytes: Schema.Literal(65536),
  runtimeVersion: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/)),
  transport: Schema.Literals(["in-process", "stdio"]),
  observationMode: Schema.Literals(["runtime-events", "snapshots-only"]),
  readiness: Schema.Literals(["READY", "NOT_SETUP", "CONFIG_INVALID"]),
});
export const WeavraRunSummary = Schema.Struct({
  runId: identifier,
  status,
  phase: Schema.Literals(["PREFLIGHT", "IMPLEMENT", "SELF_CHECK", "REVIEW", "TEST", "COMPLETE"]),
  workflow: Schema.Literals(["QUICK", "STANDARD", "COMPLEX"]),
  risk: Schema.Literals(["R0", "R1", "R2", "R3"]),
  executionMode: Schema.NullOr(Schema.Literals(["READ_ONLY", "EDIT"])),
  codeRevision: counter,
  currentStep: Schema.NullOr(step),
  activeAgentCount: counter,
  taskContractDigest: Schema.NullOr(Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))),
  createdAt: counter,
  updatedAt: counter,
});
export const WeavraGraphSummary = Schema.Struct({
  runId: identifier,
  stateRevision: counter,
  status,
  nodes: Schema.Array(
    Schema.Struct({
      id: identifier,
      kind: Schema.Literals([
        "preflight",
        "agent",
        "verification",
        "review",
        "completion",
        "approval",
        "mutation",
      ]),
      status: Schema.Literals([
        "pending",
        "running",
        "passed",
        "failed",
        "blocked",
        "cancelled",
        "skipped",
        "waiting_approval",
        "revised",
        "unknown",
      ]),
      stepId: Schema.optionalKey(step.fields.stepId),
      attempt: Schema.optionalKey(counter),
      role: Schema.optionalKey(Schema.Literals(["Executor", "Developer", "Reviewer", "Lead"])),
      parentId: Schema.optionalKey(identifier),
    }),
  ),
  edges: Schema.Array(
    Schema.Struct({
      from: identifier,
      to: identifier,
      kind: Schema.Literals(["sequence", "pass", "revise", "next_attempt", "contains", "approved"]),
    }),
  ),
});
export const WeavraEvidenceSummary = Schema.Struct({
  runId: identifier,
  status,
  codeRevision: counter,
  legacyAcceptanceUnknown: Schema.Boolean,
  criteria: Schema.Struct({ total: counter, met: counter, notMet: counter, unknown: counter }),
  currentChecks: Schema.Struct({
    total: counter,
    passed: counter,
    failed: counter,
    unavailable: counter,
    skipped: counter,
  }),
  review: Schema.NullOr(
    Schema.Struct({
      result: Schema.Literals(["PASS", "REVISE", "BLOCK"]),
      independent: Schema.Boolean,
    }),
  ),
  workers: Schema.Struct({
    count: counter,
    reportedTokens: Schema.NullOr(counter),
    toolCalls: counter,
  }),
  reviewerContexts: Schema.Struct({ count: counter, bytes: counter }),
  failureCategory: Schema.NullOr(
    Schema.Literals([
      "PREFLIGHT",
      "POLICY",
      "PROVIDER",
      "TOOL",
      "BUDGET",
      "VERIFICATION",
      "REVIEW",
      "APPROVAL",
      "STORAGE",
      "CLEANUP",
      "CANCELLED",
      "UNKNOWN",
    ]),
  ),
});
const mode = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));
export const WeavraConfigSummary = Schema.Struct({
  source: Schema.Literal("project-config-not-frozen-run-config"),
  status: Schema.Literals(["configured", "missing", "unavailable"]),
  modes: Schema.optionalKey(
    Schema.Struct({
      workflow: mode,
      mutation: mode,
      verifierTrust: mode,
      verifierSandbox: mode,
      verificationRepair: mode,
      taskContext: mode,
      impact: mode,
      documentation: mode,
    }),
  ),
  allowedRootCount: Schema.optionalKey(counter),
  registeredCheckCount: Schema.optionalKey(counter),
  requiredCheckCount: Schema.optionalKey(counter),
  documentationEntryCount: Schema.optionalKey(counter),
  budgetConfigured: Schema.optionalKey(Schema.Boolean),
});
export const WeavraStatusSummary = Schema.Struct({
  source: Schema.Literal("durable-canonical-state"),
  ownerObserved: Schema.Literal(false),
  state: Schema.Literals(["available", "missing", "unavailable"]),
  writerPresent: Schema.NullOr(Schema.Boolean),
  run: Schema.NullOr(WeavraRunSummary),
});
export const WeavraSnapshotSummary = Schema.Struct({
  status: WeavraStatusSummary,
  graph: Schema.NullOr(WeavraGraphSummary),
  graphAvailable: Schema.Boolean,
  evidence: Schema.NullOr(WeavraEvidenceSummary),
  configuration: WeavraConfigSummary,
});
export const WeavraSnapshotEnvelope = Schema.Struct({ ...identity, data: WeavraSnapshotSummary });
export type WeavraSnapshotEnvelope = typeof WeavraSnapshotEnvelope.Type;
export const WeavraHostResponse = Schema.Union([
  Schema.Struct({
    ...identity,
    type: Schema.Literal("response"),
    id: identifier,
    command: Schema.Literal("hello"),
    success: Schema.Literal(true),
    data: WeavraCapabilities,
  }),
  Schema.Struct({
    ...identity,
    type: Schema.Literal("response"),
    id: identifier,
    command: Schema.Literal("snapshot"),
    success: Schema.Literal(true),
    data: WeavraSnapshotSummary,
  }),
  Schema.Struct({
    ...identity,
    type: Schema.Literal("response"),
    id: Schema.NullOr(identifier),
    command: Schema.NullOr(identifier),
    success: Schema.Literal(false),
    error: Schema.Struct({
      code: Schema.Literals([
        "INVALID_REQUEST",
        "UNSUPPORTED_VERSION",
        "UNSUPPORTED_COMMAND",
        "HANDSHAKE_REQUIRED",
        "RUN_NOT_FOUND",
        "STATE_UNAVAILABLE",
        "GRAPH_UNAVAILABLE",
        "RESPONSE_TOO_LARGE",
        "BUSY",
      ]),
    }),
  }),
]);
export type WeavraHostResponse = typeof WeavraHostResponse.Type;
export const WeavraHostEvent = Schema.Struct({
  ...identity,
  type: Schema.Literal("runtime_event"),
  runId: identifier,
  stateRevision: counter,
  eventId: identifier,
  event: Schema.Struct({
    type: Schema.Literals([
      "RunCreated",
      "RunStarted",
      "RunCompleted",
      "RunFailed",
      "RunBlocked",
      "RunCancelled",
      "RunInterrupted",
      "StepStarted",
      "StepCompleted",
      "StepFailed",
      "AgentStarted",
      "AgentCompleted",
      "AgentFailed",
      "AgentSessionCreated",
      "ReviewRequested",
      "ReviewPassed",
      "ReviewRevisionRequested",
      "ReviewBlocked",
      "VerificationStarted",
      "VerificationCompleted",
      "VerificationFailed",
      "VerificationRepairScheduled",
      "ApprovalRequested",
      "ApprovalResolved",
      "ApprovalConsumed",
    ]),
    sequence: counter,
    step: Schema.optionalKey(step),
    role: Schema.optionalKey(Schema.Literals(["Developer", "Reviewer", "Executor"])),
  }),
});
export type WeavraHostEvent = typeof WeavraHostEvent.Type;
export const WeavraConnectionStatus = Schema.Literals([
  "NOT_INSTALLED",
  "NOT_SETUP",
  "CONFIG_INVALID",
  "READY",
  "CONNECTING",
  "CONNECTED",
  "DISCONNECTED",
  "RECONNECTING",
  "PROTOCOL_MISMATCH",
  "ERROR",
]);
export const WeavraErrorCode = Schema.Literals([
  "NOT_INSTALLED",
  "INVALID_EXECUTABLE",
  "PROJECT_UNAVAILABLE",
  "PROJECT_CHANGED",
  "SPAWN_FAILED",
  "TRANSPORT_CLOSED",
  "REQUEST_TIMEOUT",
  "INVALID_PAYLOAD",
  "OVERSIZED_PAYLOAD",
  "PROTOCOL_MISMATCH",
  "INCOMPATIBLE_CAPABILITIES",
  "STATE_UNAVAILABLE",
  "REVISION_REGRESSION",
]);
export const WeavraObservation = Schema.Struct({
  status: WeavraConnectionStatus,
  snapshot: Schema.NullOr(WeavraSnapshotEnvelope),
  stale: Schema.Boolean,
  runtimeVersion: Schema.NullOr(Schema.String),
  observedAt: Schema.NullOr(counter),
  errorCode: Schema.NullOr(WeavraErrorCode),
});
export type WeavraObservation = typeof WeavraObservation.Type;
export const WeavraObserveInput = Schema.Struct({ projectId: ProjectId });
