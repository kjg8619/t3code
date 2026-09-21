import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  type WeavraBrowserCandidateSummary,
  type WeavraBrowserPreview,
  type WeavraBrowserRegistrationRequest,
  WeavraBrowserState,
  type WeavraBrowserVerificationEvidence,
  WeavraControlCapabilities,
  WeavraControlApproval,
  WeavraControlInput,
  WeavraControlObserveInput,
  WeavraControlRequest,
  WeavraControlResponse,
  WeavraControlState,
  type WeavraRegisteredBrowserCheck,
} from "./weavraControl.ts";

const decodeRpc = Schema.decodeUnknownSync(WeavraControlInput);
const decodeObserve = Schema.decodeUnknownSync(WeavraControlObserveInput);
const decodeWire = Schema.decodeUnknownSync(WeavraControlRequest, { onExcessProperty: "error" });
const decodeApproval = Schema.decodeUnknownSync(WeavraControlApproval);
const request = {
  protocolVersion: 1,
  id: "owner:1",
  ownerId: "owner",
  expectedProjectRevision: 0,
  type: "workflow.prepare",
  goal: "Fix app bug",
};

const browserDigest = `sha256:${"a".repeat(64)}`;
const registration = {
  candidateId: "12345678-1234-1234-1234-123456789abc",
  expectedCandidateDigest: browserDigest,
  checkId: "page-ready",
  origin: "http://127.0.0.1:4173",
  documentIdentity: "http://127.0.0.1:4173/index.html",
  target: { selector: "#ready" },
  assertion: { type: "text_equals", expected: "Ready" },
  freshness: { mode: "NEW_ISOLATED_CAPTURE", maxAgeMs: 15000 },
} as const satisfies WeavraBrowserRegistrationRequest;
const browserMutation = {
  protocolVersion: 1,
  id: "owner:2",
  ownerId: "owner",
  expectedProjectRevision: 0,
} as const;
const browserPrepare = { ...browserMutation, type: "browser.prepare", registration } as const;
const browserCheck = {
  version: 1,
  checkId: registration.checkId,
  projectId: browserDigest,
  origin: registration.origin,
  documentIdentity: registration.documentIdentity,
  target: registration.target,
  assertion: registration.assertion,
  freshness: registration.freshness,
  registrationDigest: browserDigest,
} as const satisfies WeavraRegisteredBrowserCheck;
const browserCandidate = {
  schemaVersion: 2,
  kind: "BROWSER_OBSERVATION_CANDIDATE",
  candidateId: registration.candidateId,
  projectId: browserDigest,
  authority: "CANDIDATE_ONLY",
  scope: "LOCAL_STATIC_DOCUMENT",
  origin: registration.origin,
  documentIdentity: registration.documentIdentity,
  capturedAt: 100,
  pageRevision: browserDigest,
  source: {
    implementationRevision: browserDigest,
    readerRevision: "b".repeat(40),
    readerDigest: browserDigest,
    executableIdentityDigest: browserDigest,
    browserVersion: "Chromium 140",
  },
  freshness: { mode: "CAPTURE_ONLY", startedAt: 90, finishedAt: 100 },
  observationDigest: browserDigest,
  observationType: "target",
  observation: { target: registration.target, exists: true, value: "Ready" },
  candidateDigest: browserDigest,
  cleanup: "CONFIRMED",
} as const satisfies WeavraBrowserCandidateSummary;
const browserPreview = {
  previewId: "preview",
  previewDigest: browserDigest,
  ownerId: "owner",
  projectRevision: 0,
  expiresAt: 300000,
  candidate: browserCandidate,
  check: browserCheck,
  isolation: "PRIVATE_HOME_PROFILE_CDP_PIPE_NOT_OS_SANDBOX",
} as const satisfies WeavraBrowserPreview;
const browserEvidence = {
  version: 1,
  registrationDigest: browserDigest,
  projectId: browserDigest,
  origin: registration.origin,
  documentIdentity: registration.documentIdentity,
  documentDigest: browserDigest,
  observationType: "target",
  target: registration.target,
  assertion: registration.assertion,
  freshness: registration.freshness,
  captureId: registration.candidateId,
  capturedAt: 200,
  implementationRevision: browserDigest,
  executableIdentityDigest: browserDigest,
  browserVersion: "Chromium 140",
  observationDigest: browserDigest,
  isolation: "PRIVATE_HOME_PROFILE_CDP_PIPE",
  cleanup: "CONFIRMED",
  result: "PASS",
  browserEvidenceDigest: browserDigest,
} as const satisfies WeavraBrowserVerificationEvidence;
const browserState = {
  projectId: browserDigest,
  candidates: [browserCandidate],
  omittedCandidates: 1,
  checks: [{ check: browserCheck, required: true }],
  omittedChecks: 0,
  evidence: [
    {
      runId: "run",
      checkId: browserCheck.checkId,
      revision: 1,
      step: { stepId: "test", attempt: 1 },
      status: "PASS",
      diffDigest: "c".repeat(64),
      browser: browserEvidence,
    },
  ],
  omittedEvidence: 0,
} as const satisfies WeavraBrowserState;

describe("Weavra control has a closed Runtime authority boundary", () => {
  it("accepts only the bounded typed preparation input", () => {
    expect(decodeRpc({ projectId: "project", request })).toEqual({ projectId: "project", request });
    expect(decodeWire({ protocolVersion: 1, id: "hello", type: "control.hello" })).toEqual({
      protocolVersion: 1,
      id: "hello",
      type: "control.hello",
    });
  });
  it("rejects authority injection at the default RPC decoder, before fields can be stripped", () => {
    for (const field of [
      "risk",
      "allowedPaths",
      "checks",
      "taskContract",
      "policy",
      "pass",
      "complete",
    ]) {
      expect(() =>
        decodeRpc({ projectId: "project", request: { ...request, [field]: "injected" } }),
      ).toThrow();
    }
    expect(() =>
      decodeRpc({ projectId: "project", request, cwd: "/different-checkout" }),
    ).toThrow();
    expect(() =>
      decodeObserve({
        projectId: "project",
        executable: "/evil",
      }),
    ).toThrow();
  });
  it("has no write, edit, tool, shell, PASS or COMPLETE command", () => {
    for (const type of [
      "write",
      "edit",
      "tool",
      "shell",
      "pass",
      "complete",
      "set-policy",
      "task-contract",
    ]) {
      expect(() => decodeRpc({ projectId: "project", request: { ...request, type } })).toThrow();
    }
  });
  it("requires owner and expected revisions for every mutation", () => {
    const { ownerId: _owner, ...missingOwner } = request;
    const { expectedProjectRevision: _revision, ...missingRevision } = request;
    expect(() => decodeWire(missingOwner)).toThrow();
    expect(() => decodeWire(missingRevision)).toThrow();
    expect(() => decodeWire({ ...request, expectedProjectRevision: -1 })).toThrow();
    expect(() =>
      decodeWire({ ...request, expectedProjectRevision: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow();
    expect(() =>
      decodeWire({
        protocolVersion: 1,
        id: "owner:2",
        ownerId: "owner",
        expectedProjectRevision: 0,
        type: "workflow.cancel",
        runId: "run",
      }),
    ).toThrow();
  });
  it("rejects malformed recipe and criterion input without granting preferences", () => {
    expect(() => decodeWire({ ...request, recipeInputs: [] })).toThrow();
    expect(() => decodeWire({ ...request, recipeInputs: { field: 1 } })).toThrow();
    expect(() => decodeWire({ ...request, acceptanceStatements: [] })).toThrow();
    expect(() => decodeWire({ ...request, acceptanceStatements: [" "] })).toThrow();
    expect(() => decodeWire({ ...request, workflow: "QUICK", executionMode: "EDIT" })).toThrow();
  });
  it("bounds goals, criteria and recipe strings and validates protocol version", () => {
    expect(() => decodeWire({ ...request, goal: "x".repeat(2049) })).toThrow();
    expect(() => decodeWire({ ...request, acceptanceStatements: ["x".repeat(501)] })).toThrow();
    expect(() =>
      decodeWire({ ...request, acceptanceStatements: Array(17).fill("criterion") }),
    ).toThrow();
    expect(() =>
      decodeWire({ ...request, recipeInputs: { expected: "x".repeat(2049) } }),
    ).toThrow();
    expect(() => decodeWire({ ...request, protocolVersion: 2 })).toThrow();
  });
  it("approves or rejects only a Runtime issued pending identity", () => {
    const approval = {
      protocolVersion: 1,
      id: "owner:2",
      ownerId: "owner",
      expectedProjectRevision: 9,
      type: "approval.resolve",
      runId: "run",
      expectedStateRevision: 7,
      approvalId: "action",
      decision: "reject",
    };
    expect(decodeWire(approval)).toEqual(approval);
    expect(() => decodeWire({ ...approval, decision: "approve-session" })).toThrow();
    expect(() => decodeWire({ ...approval, path: "other-file", approved: true })).toThrow();
  });
  it("bounds the complete UTF-8 request, not just each field or JavaScript string length", () => {
    const oversized = {
      ...request,
      recipeInputs: Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [`field_${index}`, "한".repeat(2048)]),
      ),
    };
    expect(JSON.stringify(oversized).length).toBeLessThan(32768);
    expect(() => decodeRpc({ projectId: "project", request: oversized })).toThrow();
  });
  it("accepts the native Runtime deletion fingerprint without a contract-digest prefix", () => {
    const approval = {
      approvalId: "approval",
      runId: "run",
      stateRevision: 7,
      projectRevision: 9,
      risk: "R3",
      operation: "delete-file",
      role: "Developer",
      step: { stepId: "implement", attempt: 1 },
      path: "src/app.js",
      bytes: 9,
      preconditionDigest: "b".repeat(64),
      expiresAt: 10000,
      explanation: "Delete one tracked text file.",
    };
    expect(decodeApproval(approval).preconditionDigest).toBe(approval.preconditionDigest);
    expect(() =>
      decodeApproval({ ...approval, preconditionDigest: `sha256:${approval.preconditionDigest}` }),
    ).toThrow();
  });
  it("does not allow raw private diagnostics in a typed control rejection", () => {
    const response = {
      protocolVersion: 1,
      type: "control_response",
      id: "owner:2",
      command: "workflow.confirm",
      ownerId: "owner",
      runId: null,
      stateRevision: null,
      projectRevision: null,
      eventId: null,
      timestamp: 1,
      success: false,
      error: { code: "STALE_PROJECT" },
    };
    const decode = Schema.decodeUnknownSync(WeavraControlResponse, { onExcessProperty: "error" });
    expect(decode(response)).toEqual(response);
    expect(() =>
      decode({ ...response, error: { ...response.error, reason: "PRIVATE_CREDENTIAL_MARKER" } }),
    ).toThrow();
  });
  it("accepts browser inspection, registration preparation and Runtime preview confirmation", () => {
    for (const browserRequest of [
      { ...browserMutation, type: "browser.inspect" },
      browserPrepare,
      {
        ...browserMutation,
        type: "browser.confirm",
        previewId: browserPreview.previewId,
        previewDigest: browserPreview.previewDigest,
      },
    ]) {
      expect(decodeRpc({ projectId: "project", request: browserRequest })).toEqual({
        projectId: "project",
        request: browserRequest,
      });
      const { ownerId: _owner, ...missingOwner } = browserRequest;
      const { expectedProjectRevision: _revision, ...missingRevision } = browserRequest;
      expect(() => decodeWire(missingOwner)).toThrow();
      expect(() => decodeWire(missingRevision)).toThrow();
    }
  });
  it("rejects injected browser authority, executable paths and evaluation at every input level", () => {
    for (const field of ["authority", "executable", "eval", "registrationDigest", "result"]) {
      for (const injected of [
        { ...browserPrepare, [field]: "injected" },
        { ...browserPrepare, registration: { ...registration, [field]: "injected" } },
        {
          ...browserPrepare,
          registration: {
            ...registration,
            target: { ...registration.target, [field]: "injected" },
          },
        },
        {
          ...browserPrepare,
          registration: {
            ...registration,
            assertion: { ...registration.assertion, [field]: "injected" },
          },
        },
        {
          ...browserPrepare,
          registration: {
            ...registration,
            freshness: { ...registration.freshness, [field]: "injected" },
          },
        },
      ]) {
        expect(() => decodeRpc({ projectId: "project", request: injected })).toThrow();
      }
    }
    expect(() =>
      decodeRpc({
        projectId: "project",
        request: {
          ...browserMutation,
          type: "browser.confirm",
          previewId: browserPreview.previewId,
          previewDigest: browserPreview.previewDigest,
          registration,
        },
      }),
    ).toThrow();
  });
  it("bounds typed browser selectors, attributes, expected values and freshness", () => {
    const attributeRegistration = {
      ...registration,
      target: { selector: "#ready", attribute: "aria-label" },
      assertion: { type: "attribute_equals", expected: "x".repeat(1024) },
      freshness: { mode: "NEW_ISOLATED_CAPTURE", maxAgeMs: 1 },
    };
    expect(
      decodeRpc({
        projectId: "project",
        request: { ...browserPrepare, registration: attributeRegistration },
      }).request,
    ).toEqual({
      ...browserPrepare,
      registration: attributeRegistration,
    });
    for (const invalid of [
      { ...registration, target: { selector: "body" } },
      { ...registration, target: { selector: `#${"x".repeat(65)}` } },
      { ...registration, target: { selector: "#ready", attribute: "onclick" } },
      { ...registration, assertion: { type: "text_equals", expected: "x".repeat(1025) } },
      { ...registration, assertion: { type: "element_exists", expected: "Ready" } },
      { ...registration, freshness: { mode: "NEW_ISOLATED_CAPTURE", maxAgeMs: 0 } },
      { ...registration, freshness: { mode: "NEW_ISOLATED_CAPTURE", maxAgeMs: 15001 } },
      { ...registration, freshness: { mode: "NEW_ISOLATED_CAPTURE", maxAgeMs: 1.5 } },
    ]) {
      expect(() =>
        decodeRpc({
          projectId: "project",
          request: { ...browserPrepare, registration: invalid },
        }),
      ).toThrow();
    }
  });
  it("decodes bounded browser results without exposing document text or private executable data", () => {
    const decode = Schema.decodeUnknownSync(WeavraControlResponse, { onExcessProperty: "error" });
    const response = {
      protocolVersion: 1,
      type: "control_response",
      id: "owner:2",
      command: "browser.inspect",
      ownerId: "owner",
      runId: null,
      stateRevision: null,
      projectRevision: 0,
      eventId: null,
      timestamp: 200,
      success: true,
    };
    for (const data of [
      { kind: "browser-state", state: browserState },
      { kind: "browser-prepared", preview: browserPreview },
      { kind: "browser-registered", check: browserCheck },
    ]) {
      expect(decode({ ...response, data })).toEqual({ ...response, data });
    }
    const decodeState = Schema.decodeUnknownSync(WeavraBrowserState, {
      onExcessProperty: "error",
    });
    expect(
      decodeState({
        ...browserState,
        evidence: [
          { ...browserState.evidence[0], step: null, status: "UNAVAILABLE", browser: null },
        ],
      }).evidence[0]?.browser,
    ).toBeNull();
    for (const field of ["candidates", "checks", "evidence"] as const) {
      expect(() =>
        decodeState({
          ...browserState,
          [field]: Array(3).fill(browserState[field][0]),
        }),
      ).toThrow();
    }
    for (const candidate of [
      { ...browserCandidate, authority: "Runtime/Kernel" },
      {
        ...browserCandidate,
        source: { ...browserCandidate.source, executable: "/private/chrome" },
      },
      {
        ...browserCandidate,
        observation: { ...browserCandidate.observation, text: "private document" },
      },
      {
        ...browserCandidate,
        observation: { ...browserCandidate.observation, value: "x".repeat(1025) },
      },
    ]) {
      expect(() => decodeState({ ...browserState, candidates: [candidate] })).toThrow();
    }
  });
  it("requires the browser preview slot and the coordinated nine-command capability tuple", () => {
    const decodeState = Schema.decodeUnknownSync(WeavraControlState);
    const state = {
      ownerId: "owner",
      nextRequestId: "owner:3",
      projectRevision: 0,
      stateRevision: null,
      ownedRunId: null,
      busy: false,
      cancelling: false,
      startFailure: null,
      preview: null,
      browserPreview: null,
      pendingApproval: null,
      snapshot: {
        status: {
          source: "durable-canonical-state",
          ownerObserved: false,
          state: "missing",
          writerPresent: false,
          run: null,
        },
        graph: null,
        graphAvailable: false,
        evidence: null,
        configuration: { source: "project-config-not-frozen-run-config", status: "missing" },
      },
    };
    expect(decodeState(state)).toEqual(state);
    expect(decodeState({ ...state, browserPreview }).browserPreview).toEqual(browserPreview);
    const { browserPreview: _preview, ...legacyState } = state;
    expect(() => decodeState(legacyState)).toThrow();
    const capabilities = {
      authority: "Runtime/Kernel",
      control: "workflow-control-v1",
      ownerId: "owner",
      commands: [
        "control.hello",
        "control.snapshot",
        "workflow.prepare",
        "workflow.confirm",
        "workflow.cancel",
        "approval.resolve",
        "browser.inspect",
        "browser.prepare",
        "browser.confirm",
      ],
      maxRequestBytes: 32768,
      maxResponseBytes: 65536,
      resultLimit: 64,
      previewTtlMs: 300000,
      runtimeVersion: "1.0.0",
      readiness: "READY",
      recipes: [],
    };
    const decodeCapabilities = Schema.decodeUnknownSync(WeavraControlCapabilities);
    expect(decodeCapabilities(capabilities)).toEqual(capabilities);
    expect(() =>
      decodeCapabilities({
        ...capabilities,
        commands: capabilities.commands.slice(0, 6),
      }),
    ).toThrow();
  });
});
