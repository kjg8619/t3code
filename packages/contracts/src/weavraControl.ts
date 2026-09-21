import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";
import {
  WeavraConnectionStatus,
  WeavraErrorCode,
  WeavraRunSummary,
  WeavraSnapshotEnvelope,
  WeavraSnapshotSummary,
} from "./weavra.ts";

export const WEAVRA_CONTROL_MAX_REQUEST_BYTES = 32768;
export const WEAVRA_CONTROL_MAX_RESPONSE_BYTES = 65536;
export const WEAVRA_CONTROL_COMMANDS = [
  "control.hello",
  "control.snapshot",
  "workflow.prepare",
  "workflow.confirm",
  "workflow.cancel",
  "approval.resolve",
  "browser.inspect",
  "browser.prepare",
  "browser.confirm",
] as const;

const identifier = WeavraRunSummary.fields.runId;
const counter = WeavraRunSummary.fields.codeRevision;
const digest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/));
const boundedText = Schema.String.check(Schema.isMaxLength(WEAVRA_CONTROL_MAX_RESPONSE_BYTES));
const goal = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2048),
  Schema.isPattern(/\S/),
);
const envelope = { protocolVersion: Schema.Literal(1), id: identifier };
const mutation = { ...envelope, ownerId: identifier, expectedProjectRevision: counter };

const browserIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
);
const browserCaptureId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
);
const browserUrl = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
const browserVersion = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const browserValue = Schema.String.check(Schema.isMaxLength(1024));

export const WeavraBrowserTarget = Schema.Struct({
  selector: Schema.String.check(
    Schema.isPattern(/^#[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    Schema.isMaxLength(65),
  ),
  attribute: Schema.optionalKey(
    Schema.Literals([
      "role",
      "title",
      "aria-label",
      "aria-disabled",
      "aria-checked",
      "aria-expanded",
      "aria-selected",
    ]),
  ),
});
export type WeavraBrowserTarget = typeof WeavraBrowserTarget.Type;

export const WeavraBrowserAssertion = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["text_equals", "text_contains"]),
    expected: browserValue,
  }),
  Schema.Struct({ type: Schema.Literals(["element_exists", "element_not_exists"]) }),
  Schema.Struct({ type: Schema.Literal("attribute_equals"), expected: browserValue }),
]);
export type WeavraBrowserAssertion = typeof WeavraBrowserAssertion.Type;

export const WeavraBrowserFreshnessPolicy = Schema.Struct({
  mode: Schema.Literal("NEW_ISOLATED_CAPTURE"),
  maxAgeMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 15000 })),
});
export type WeavraBrowserFreshnessPolicy = typeof WeavraBrowserFreshnessPolicy.Type;

export const WeavraBrowserRegistrationRequest = Schema.Struct({
  candidateId: browserCaptureId,
  expectedCandidateDigest: digest,
  checkId: browserIdentifier,
  origin: browserUrl,
  documentIdentity: browserUrl,
  target: WeavraBrowserTarget,
  assertion: WeavraBrowserAssertion,
  freshness: WeavraBrowserFreshnessPolicy,
});
export type WeavraBrowserRegistrationRequest = typeof WeavraBrowserRegistrationRequest.Type;

export const WeavraRegisteredBrowserCheck = Schema.Struct({
  version: Schema.Literal(1),
  checkId: browserIdentifier,
  projectId: digest,
  origin: browserUrl,
  documentIdentity: browserUrl,
  target: WeavraBrowserTarget,
  assertion: WeavraBrowserAssertion,
  freshness: WeavraBrowserFreshnessPolicy,
  registrationDigest: digest,
});
export type WeavraRegisteredBrowserCheck = typeof WeavraRegisteredBrowserCheck.Type;

export const WeavraBrowserCandidateSummary = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  kind: Schema.Literal("BROWSER_OBSERVATION_CANDIDATE"),
  candidateId: browserCaptureId,
  projectId: digest,
  authority: Schema.Literal("CANDIDATE_ONLY"),
  scope: Schema.Literal("LOCAL_STATIC_DOCUMENT"),
  origin: browserUrl,
  documentIdentity: browserUrl,
  capturedAt: counter,
  pageRevision: digest,
  source: Schema.Struct({
    implementationRevision: digest,
    readerRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
    readerDigest: digest,
    executableIdentityDigest: digest,
    browserVersion,
  }),
  freshness: Schema.Struct({
    mode: Schema.Literal("CAPTURE_ONLY"),
    startedAt: counter,
    finishedAt: counter,
  }),
  observationDigest: digest,
  observationType: Schema.Literal("target"),
  observation: Schema.Struct({
    target: WeavraBrowserTarget,
    exists: Schema.Boolean,
    value: Schema.NullOr(browserValue),
  }),
  candidateDigest: digest,
  cleanup: Schema.Literal("CONFIRMED"),
});
export type WeavraBrowserCandidateSummary = typeof WeavraBrowserCandidateSummary.Type;

export const WeavraBrowserVerificationEvidence = Schema.Struct({
  version: Schema.Literal(1),
  registrationDigest: digest,
  projectId: digest,
  origin: browserUrl,
  documentIdentity: browserUrl,
  documentDigest: digest,
  observationType: Schema.Literal("target"),
  target: WeavraBrowserTarget,
  assertion: WeavraBrowserAssertion,
  freshness: WeavraBrowserFreshnessPolicy,
  captureId: browserCaptureId,
  capturedAt: counter,
  implementationRevision: digest,
  executableIdentityDigest: digest,
  browserVersion,
  observationDigest: digest,
  isolation: Schema.Literal("PRIVATE_HOME_PROFILE_CDP_PIPE"),
  cleanup: Schema.Literal("CONFIRMED"),
  result: Schema.Literals(["PASS", "FAIL"]),
  browserEvidenceDigest: digest,
});
export type WeavraBrowserVerificationEvidence = typeof WeavraBrowserVerificationEvidence.Type;

export const WeavraBrowserPreview = Schema.Struct({
  previewId: identifier,
  previewDigest: digest,
  ownerId: identifier,
  projectRevision: counter,
  expiresAt: counter,
  candidate: WeavraBrowserCandidateSummary,
  check: WeavraRegisteredBrowserCheck,
  isolation: Schema.Literal("PRIVATE_HOME_PROFILE_CDP_PIPE_NOT_OS_SANDBOX"),
});
export type WeavraBrowserPreview = typeof WeavraBrowserPreview.Type;

export const WeavraBrowserState = Schema.Struct({
  projectId: digest,
  candidates: Schema.Array(WeavraBrowserCandidateSummary).check(Schema.isMaxLength(2)),
  omittedCandidates: counter,
  checks: Schema.Array(
    Schema.Struct({ check: WeavraRegisteredBrowserCheck, required: Schema.Boolean }),
  ).check(Schema.isMaxLength(2)),
  omittedChecks: counter,
  evidence: Schema.Array(
    Schema.Struct({
      runId: identifier,
      checkId: browserIdentifier,
      revision: counter,
      step: Schema.NullOr(
        Schema.Struct({
          stepId: Schema.Literals(["implement", "self-check", "review", "test", "complete"]),
          attempt: counter.check(Schema.isGreaterThanOrEqualTo(1)),
        }),
      ),
      status: Schema.Literals(["PASS", "FAIL", "SKIPPED", "UNAVAILABLE"]),
      diffDigest: boundedText,
      browser: Schema.NullOr(WeavraBrowserVerificationEvidence),
    }),
  ).check(Schema.isMaxLength(2)),
  omittedEvidence: counter,
});
export type WeavraBrowserState = typeof WeavraBrowserState.Type;

export const WeavraControlMutation = Schema.Union([
  Schema.Struct({ ...mutation, type: Schema.Literal("browser.inspect") }),
  Schema.Struct({
    ...mutation,
    type: Schema.Literal("browser.prepare"),
    registration: WeavraBrowserRegistrationRequest,
  }),
  Schema.Struct({
    ...mutation,
    type: Schema.Literal("browser.confirm"),
    previewId: identifier,
    previewDigest: digest,
  }),
  Schema.Struct({
    ...mutation,
    type: Schema.Literal("workflow.prepare"),
    goal,
    recipeId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,64}$/))),
    recipeInputs: Schema.optionalKey(
      Schema.Record(
        Schema.String.check(Schema.isPattern(/^[a-z0-9_]+$/)),
        Schema.String.check(Schema.isMaxLength(2048)),
      ).check(Schema.isMaxProperties(16)),
    ),
    acceptanceStatements: Schema.optionalKey(
      Schema.Array(
        Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isPattern(/\S/)),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
    ),
  }),
  Schema.Struct({
    ...mutation,
    type: Schema.Literal("workflow.confirm"),
    previewId: identifier,
    previewDigest: digest,
  }),
  Schema.Struct({
    ...mutation,
    type: Schema.Literal("workflow.cancel"),
    runId: identifier,
    expectedStateRevision: counter,
  }),
  Schema.Struct({
    ...mutation,
    type: Schema.Literal("approval.resolve"),
    runId: identifier,
    expectedStateRevision: counter,
    approvalId: identifier,
    decision: Schema.Literals(["approve", "reject"]),
  }),
]);
export type WeavraControlMutation = typeof WeavraControlMutation.Type;

export const WeavraControlRequest = Schema.Union([
  Schema.Struct({ ...envelope, type: Schema.Literal("control.hello") }),
  Schema.Struct({ ...envelope, type: Schema.Literal("control.snapshot") }),
  WeavraControlMutation,
]);
export type WeavraControlRequest = typeof WeavraControlRequest.Type;

export const WeavraControlErrorCode = Schema.Literals([
  "INVALID_REQUEST",
  "UNSUPPORTED_VERSION",
  "UNSUPPORTED_COMMAND",
  "HANDSHAKE_REQUIRED",
  "CONTROL_UNAVAILABLE",
  "OWNER_CHANGED",
  "PROJECT_CHANGED",
  "STATE_UNAVAILABLE",
  "STALE_PROJECT",
  "STALE_RUN",
  "CONFIG_CHANGED",
  "ACTIVE_RUN",
  "WRITER_PRESENT",
  "PLAN_NOT_FOUND",
  "PLAN_EXPIRED",
  "PLAN_CHANGED",
  "PLAN_CONSUMED",
  "INVALID_GOAL",
  "UNSUPPORTED_WORKFLOW",
  "INVALID_RECIPE",
  "INVALID_CRITERIA",
  "POLICY_DENIED",
  "RUN_NOT_FOUND",
  "RUN_NOT_OWNED",
  "TERMINAL_RUN",
  "APPROVAL_NOT_PENDING",
  "APPROVAL_EXPIRED",
  "REQUEST_ID_REUSED",
  "REQUEST_EXPIRED",
  "REQUEST_OUT_OF_ORDER",
  "REQUEST_TOO_LARGE",
  "RESPONSE_TOO_LARGE",
  "BUSY",
  "START_FAILED",
  "BROWSER_UNAVAILABLE",
  "CANDIDATE_CHANGED",
  "INVALID_BROWSER_CHECK",
  "CHECK_EXISTS",
]);
export type WeavraControlErrorCode = typeof WeavraControlErrorCode.Type;

export const WeavraControlPreview = Schema.Struct({
  previewId: identifier,
  previewDigest: digest,
  ownerId: identifier,
  projectRevision: counter,
  expiresAt: counter,
  goal,
  workflow: Schema.Literals(["QUICK", "STANDARD"]),
  executionMode: Schema.Literals(["EDIT", "READ_ONLY"]),
  risk: WeavraRunSummary.fields.risk,
  allowedPaths: Schema.Array(boundedText).check(
    Schema.isMaxLength(WEAVRA_CONTROL_MAX_RESPONSE_BYTES),
  ),
  checks: Schema.Array(
    Schema.Struct({ id: boundedText, kind: boundedText, required: Schema.Boolean }),
  ).check(Schema.isMaxLength(WEAVRA_CONTROL_MAX_RESPONSE_BYTES)),
  acceptanceCriteria: Schema.Array(
    Schema.Struct({
      id: identifier,
      statement: boundedText,
      checkIds: Schema.Array(boundedText).check(
        Schema.isMaxLength(WEAVRA_CONTROL_MAX_RESPONSE_BYTES),
      ),
      reviewRequired: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(WEAVRA_CONTROL_MAX_RESPONSE_BYTES)),
  taskContractDigest: digest,
  recipe: Schema.NullOr(Schema.Struct({ id: identifier, version: counter, digest })),
  configuration: Schema.Struct({
    mutationMode: Schema.Literals(["compatible", "strict"]),
    verifierTrustMode: Schema.Literals(["compatible", "strict"]),
    verifierSandboxMode: Schema.Literals(["disabled", "required"]),
    contextPackMode: Schema.Literals(["disabled", "bounded"]),
    verificationRepairMode: Schema.Literals(["disabled", "self-check-once"]),
    lspEnabled: Schema.Boolean,
  }),
});
export type WeavraControlPreview = typeof WeavraControlPreview.Type;

export const WeavraControlApproval = Schema.Struct({
  approvalId: identifier,
  runId: identifier,
  stateRevision: counter,
  projectRevision: counter,
  risk: Schema.Literal("R3"),
  operation: Schema.Literal("delete-file"),
  role: Schema.Literal("Developer"),
  step: Schema.Struct({ stepId: Schema.Literal("implement"), attempt: counter }),
  path: boundedText,
  bytes: counter,
  // Runtime workerDigest is raw SHA-256 hex, unlike prefixed contract digests.
  preconditionDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  expiresAt: counter,
  explanation: boundedText,
});
export type WeavraControlApproval = typeof WeavraControlApproval.Type;

export const WeavraControlState = Schema.Struct({
  ownerId: identifier,
  nextRequestId: identifier,
  projectRevision: counter,
  stateRevision: Schema.NullOr(counter),
  ownedRunId: Schema.NullOr(identifier),
  busy: Schema.Boolean,
  cancelling: Schema.Boolean,
  startFailure: Schema.NullOr(Schema.Literal("START_FAILED")),
  preview: Schema.NullOr(WeavraControlPreview),
  browserPreview: Schema.NullOr(WeavraBrowserPreview),
  pendingApproval: Schema.NullOr(WeavraControlApproval),
  snapshot: WeavraSnapshotSummary,
});
export type WeavraControlState = typeof WeavraControlState.Type;

export const WeavraControlCapabilities = Schema.Struct({
  authority: Schema.Literal("Runtime/Kernel"),
  control: Schema.Literal("workflow-control-v1"),
  ownerId: identifier,
  commands: Schema.Tuple([
    Schema.Literal(WEAVRA_CONTROL_COMMANDS[0]),
    Schema.Literal(WEAVRA_CONTROL_COMMANDS[1]),
    Schema.Literal(WEAVRA_CONTROL_COMMANDS[2]),
    Schema.Literal(WEAVRA_CONTROL_COMMANDS[3]),
    Schema.Literal(WEAVRA_CONTROL_COMMANDS[4]),
    Schema.Literal(WEAVRA_CONTROL_COMMANDS[5]),
    Schema.Literal(WEAVRA_CONTROL_COMMANDS[6]),
    Schema.Literal(WEAVRA_CONTROL_COMMANDS[7]),
    Schema.Literal(WEAVRA_CONTROL_COMMANDS[8]),
  ]),
  maxRequestBytes: counter,
  maxResponseBytes: counter,
  resultLimit: counter,
  previewTtlMs: counter,
  runtimeVersion: boundedText,
  readiness: Schema.Literals(["READY", "NOT_SETUP", "CONFIG_INVALID"]),
  recipes: Schema.Array(
    Schema.Struct({
      id: identifier,
      version: counter,
      title: boundedText,
      inputTemplate: boundedText,
    }),
  ).check(Schema.isMaxLength(WEAVRA_CONTROL_MAX_RESPONSE_BYTES)),
});
export type WeavraControlCapabilities = typeof WeavraControlCapabilities.Type;

const controlData = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("capabilities"), capabilities: WeavraControlCapabilities }),
  Schema.Struct({ kind: Schema.Literal("snapshot"), state: WeavraControlState }),
  Schema.Struct({ kind: Schema.Literal("prepared"), preview: WeavraControlPreview }),
  Schema.Struct({ kind: Schema.Literal("browser-state"), state: WeavraBrowserState }),
  Schema.Struct({ kind: Schema.Literal("browser-prepared"), preview: WeavraBrowserPreview }),
  Schema.Struct({
    kind: Schema.Literal("browser-registered"),
    check: WeavraRegisteredBrowserCheck,
  }),
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    requestId: identifier,
    command: Schema.Literals(["workflow.confirm", "workflow.cancel", "approval.resolve"]),
    runId: Schema.NullOr(identifier),
  }),
]);
const responseEnvelope = {
  protocolVersion: WeavraSnapshotEnvelope.fields.protocolVersion,
  runId: WeavraSnapshotEnvelope.fields.runId,
  stateRevision: WeavraSnapshotEnvelope.fields.stateRevision,
  projectRevision: WeavraSnapshotEnvelope.fields.projectRevision,
  eventId: WeavraSnapshotEnvelope.fields.eventId,
  timestamp: WeavraSnapshotEnvelope.fields.timestamp,
  type: Schema.Literal("control_response"),
  id: Schema.NullOr(identifier),
  command: Schema.NullOr(boundedText),
  ownerId: identifier,
};
export const WeavraControlResponse = Schema.Union([
  Schema.Struct({ ...responseEnvelope, success: Schema.Literal(true), data: controlData }),
  Schema.Struct({
    ...responseEnvelope,
    success: Schema.Literal(false),
    error: Schema.Struct({ code: WeavraControlErrorCode }),
  }),
]);
export type WeavraControlResponse = typeof WeavraControlResponse.Type;

// Effect 4 does not apply parseOptions annotations. Check raw RPC input before
// the ordinary Struct decoder can strip unknown authority-bearing fields.
function closedRpcInput<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
  const decode = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" });
  return Schema.Unknown.check(Schema.makeFilter((value) => Option.isSome(decode(value)))).pipe(
    Schema.decodeTo(schema),
  );
}

const requestEncoder = new TextEncoder();
export const WeavraControlInput = Schema.Struct({
  projectId: ProjectId,
  request: WeavraControlMutation,
})
  .check(
    Schema.makeFilter(
      (input) =>
        requestEncoder.encode(JSON.stringify(input.request)).byteLength + 1 <=
        WEAVRA_CONTROL_MAX_REQUEST_BYTES,
    ),
  )
  .pipe(closedRpcInput);
export type WeavraControlInput = typeof WeavraControlInput.Type;

export const WeavraControlObserveInput = Schema.Struct({ projectId: ProjectId }).pipe(
  closedRpcInput,
);
export type WeavraControlObserveInput = typeof WeavraControlObserveInput.Type;

export const WeavraControlObservation = Schema.Struct({
  status: WeavraConnectionStatus,
  state: Schema.NullOr(WeavraControlState),
  capabilities: Schema.NullOr(WeavraControlCapabilities),
  stale: Schema.Boolean,
  observedAt: Schema.NullOr(counter),
  errorCode: Schema.NullOr(WeavraErrorCode),
});
export type WeavraControlObservation = typeof WeavraControlObservation.Type;

export class WeavraControlTransportError extends Schema.TaggedError<WeavraControlTransportError>()(
  "WeavraControlTransportError",
  { code: WeavraErrorCode },
) {}
