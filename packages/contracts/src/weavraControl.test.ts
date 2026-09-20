import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  WeavraControlApproval,
  WeavraControlInput,
  WeavraControlObserveInput,
  WeavraControlRequest,
  WeavraControlResponse,
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
});
