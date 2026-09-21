import type * as React from "react";
import type { ReactElement } from "react";
import {
  EnvironmentId,
  ProjectId,
  type WeavraBrowserCandidateSummary,
  type WeavraBrowserPreview,
  type WeavraBrowserState,
  type WeavraControlObservation,
  type WeavraControlPreview,
  type WeavraControlResponse,
  type WeavraControlState,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const data = vi.hoisted(() => ({
  observation: null as WeavraControlObservation | null,
  phase: "connected",
  support: "supported",
  invoke: vi.fn(),
  confirm: vi.fn(),
  cleanups: [] as Array<() => void>,
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useMemo: hooks.useMemo,
  useCallback: hooks.useCallback,
  useLayoutEffect: (effect: () => void) => effect(),
  useEffect: (effect: () => () => void) => {
    if (data.cleanups.length === 0) data.cleanups.push(effect());
  },
}));
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success({ support: data.support, observation: data.observation }),
}));
vi.mock("@t3tools/client-runtime/state/weavraControl", () => ({
  createEnvironmentWeavraControlStateAtoms: () => ({ stateAtom: () => "observation" }),
  createEnvironmentWeavraControlCommand: () => "command",
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: data.phase } }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => data.invoke }));
vi.mock("../../confirmDialog", () => ({
  requestConfirmDialog: (...args: unknown[]) => data.confirm(...args),
}));
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("./SettingsGroup", () => ({ SettingsGroup: "div" }));
vi.mock("./settingsLayout", () => ({ SettingsSection: "section" }));
import { WeavraControls } from "./WeavraControls";

const environmentId = EnvironmentId.make("local-control");
const projectId = ProjectId.make("control-project");
const digest = `sha256:${"a".repeat(64)}`;
const preview: WeavraControlPreview = {
  previewId: "preview-1",
  previewDigest: digest,
  ownerId: "owner",
  projectRevision: 0,
  expiresAt: 9999999999999,
  goal: "Fix app bug",
  workflow: "STANDARD",
  executionMode: "EDIT",
  risk: "R1",
  allowedPaths: ["src"],
  checks: [{ id: "unit checks", kind: "test", required: true }],
  acceptanceCriteria: [
    {
      id: "AC-1",
      statement: "App produces the corrected result",
      checkIds: ["unit checks"],
      reviewRequired: true,
    },
  ],
  taskContractDigest: digest,
  recipe: null,
  configuration: {
    mutationMode: "strict",
    verifierTrustMode: "strict",
    verifierSandboxMode: "disabled",
    contextPackMode: "bounded",
    verificationRepairMode: "disabled",
    lspEnabled: false,
  },
};
function state(): WeavraControlState {
  return {
    ownerId: "owner",
    nextRequestId: "owner:1",
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
}
function update(patch: Partial<WeavraControlState>) {
  data.observation = { ...data.observation!, state: { ...data.observation!.state!, ...patch } };
}
function response(
  value: Extract<WeavraControlResponse, { success: true }>["data"],
): WeavraControlResponse {
  return {
    protocolVersion: 1,
    type: "control_response",
    id: "owner:1",
    command: "workflow.prepare",
    ownerId: "owner",
    runId: null,
    stateRevision: null,
    projectRevision: 0,
    eventId: null,
    timestamp: 1,
    success: true,
    data: value,
  };
}
function accepted(command: "workflow.confirm" | "workflow.cancel" | "approval.resolve") {
  data.invoke.mockResolvedValue(
    AsyncResult.success(
      response({
        kind: "accepted",
        requestId: "owner:2",
        command,
        runId: command === "workflow.confirm" ? null : "run-1",
      }),
    ),
  );
}
function render() {
  hooks.beginRender();
  return WeavraControls({
    environmentId,
    projectId,
    workspaceRoot: "/trusted/project",
  }) as ReactElement<Record<string, unknown>>;
}
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (node && typeof node === "object" && "props" in node)
    return text((node as ReactElement<Record<string, unknown>>).props.children);
  return "";
}
function control(tree: ReactElement<Record<string, unknown>>, label: string) {
  const element = visitElements(
    tree,
    (node) =>
      node.props["aria-label"] === label || (node.type === "button" && text(node) === label),
  );
  if (!element) throw new Error(`Missing control: ${label}`);
  return element;
}
function change(label: string, value: string) {
  (control(render(), label).props.onChange as (event: { target: { value: string } }) => void)({
    target: { value },
  });
}
async function flush() {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}
async function click(label: string) {
  const button = control(render(), label);
  expect(button.props.disabled).not.toBe(true);
  (button.props.onClick as () => void)();
  await flush();
}
async function prepare() {
  change("Workflow goal", preview.goal);
  const form = visitElements(render(), (node) => node.type === "form")!;
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
  await flush();
  update({ preview, nextRequestId: "owner:2" });
}
function running(waiting = false) {
  const base = state();
  update({
    busy: true,
    projectRevision: 9,
    stateRevision: 7,
    ownedRunId: "run-1",
    nextRequestId: "owner:2",
    snapshot: {
      ...base.snapshot,
      status: {
        ...base.snapshot.status,
        state: "available",
        writerPresent: true,
        run: {
          runId: "run-1",
          status: waiting ? "WAITING_APPROVAL" : "RUNNING",
          phase: "IMPLEMENT",
          workflow: "STANDARD",
          risk: waiting ? "R3" : "R1",
          executionMode: "EDIT",
          codeRevision: 0,
          currentStep: { stepId: "implement", attempt: 0 },
          activeAgentCount: 1,
          taskContractDigest: digest,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    },
    pendingApproval: waiting
      ? {
          approvalId: "approval-1",
          runId: "run-1",
          stateRevision: 7,
          projectRevision: 9,
          risk: "R3",
          operation: "delete-file",
          role: "Developer",
          step: { stepId: "implement", attempt: 0 },
          path: "src/old.js",
          bytes: 4,
          preconditionDigest: "b".repeat(64),
          expiresAt: 9999999999999,
          explanation: "Delete exactly this tracked file",
        }
      : null,
  });
}

beforeEach(() => {
  hooks.reset();
  data.phase = "connected";
  data.support = "supported";
  data.cleanups = [];
  data.observation = {
    status: "CONNECTED",
    stale: false,
    state: state(),
    observedAt: 1,
    errorCode: null,
    capabilities: {
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
      runtimeVersion: "0.85.1",
      readiness: "READY",
      recipes: [
        {
          id: "bug-fix",
          version: 1,
          title: "Bug fix",
          inputTemplate: '{"expected":"correct result"}',
        },
      ],
    },
  };
  data.invoke
    .mockReset()
    .mockResolvedValue(AsyncResult.success(response({ kind: "prepared", preview })));
  data.confirm.mockReset().mockResolvedValue(true);
});

describe("Weavra workflow control interactions", () => {
  it("prepares goal and optional recipe as data, then presents Runtime-owned plan and editable criteria", async () => {
    change("Reviewed recipe", "bug-fix");
    expect(control(render(), "Recipe inputs").props.value).toBe('{"expected":"correct result"}');
    await prepare();
    expect(data.invoke.mock.calls[0]?.[0]).toMatchObject({
      environmentId,
      input: {
        projectId,
        request: {
          type: "workflow.prepare",
          goal: preview.goal,
          recipeId: "bug-fix",
          recipeInputs: { expected: "correct result" },
        },
      },
    });
    const plan = control(render(), "Runtime Plan Preview");
    expect(text(plan)).toContain("STANDARD");
    expect(text(plan)).toContain("strict");
    expect(text(plan)).toContain("unit checks");
    expect(control(render(), "Confirm and start").props.disabled).toBe(false);
    change("Acceptance criteria", "A revised observable outcome");
    expect(control(render(), "Confirm and start").props.disabled).toBe(true);
    const form = visitElements(render(), (node) => node.type === "form")!;
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({
      preventDefault() {},
    });
    await flush();
    expect(data.invoke.mock.calls[1]?.[0].input.request).toMatchObject({
      acceptanceStatements: ["A revised observable outcome"],
    });
    expect(data.invoke.mock.calls[1]?.[0].input.request).not.toHaveProperty("taskContract");
  });
  it("does not carry old acceptance criteria into a changed goal", async () => {
    await prepare();
    change("Workflow goal", "Fix a different bug");
    expect(
      visitElements(render(), (node) => node.props["aria-label"] === "Runtime Plan Preview"),
    ).toBeNull();
    const form = visitElements(render(), (node) => node.type === "form")!;
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({
      preventDefault() {},
    });
    await flush();
    expect(data.invoke.mock.calls[1]?.[0].input.request).not.toHaveProperty("acceptanceStatements");
  });
  it("requires explicit confirmation and does not invent a Run from start acknowledgement", async () => {
    await prepare();
    accepted("workflow.confirm");
    await click("Confirm and start");
    expect(data.confirm).toHaveBeenCalledOnce();
    expect(data.confirm.mock.calls[0]?.[0]).toContain("/trusted/project");
    expect(data.invoke.mock.calls[1]?.[0].input.request).toMatchObject({
      type: "workflow.confirm",
      previewId: preview.previewId,
      previewDigest: digest,
    });
    expect(text(render())).toContain("Start accepted");
    expect(text(render())).not.toContain("Canonical Run:");
  });
  it("invalidates preview after canonical revision, owner or Runtime preview changes", async () => {
    await prepare();
    data.observation = { ...data.observation!, observedAt: preview.expiresAt };
    expect(control(render(), "Confirm and start").props.disabled).toBe(true);
    data.observation = { ...data.observation!, observedAt: 1 };
    update({ projectRevision: 1 });
    expect(control(render(), "Confirm and start").props.disabled).toBe(true);
    update({ projectRevision: 0, ownerId: "replacement" });
    expect(control(render(), "Confirm and start").props.disabled).toBe(true);
    update({ ownerId: "owner", preview: null });
    expect(control(render(), "Confirm and start").props.disabled).toBe(true);
    expect(data.invoke).toHaveBeenCalledOnce();
  });
  it("shows cancellation warning and waits for the confirmation dialog before sending", async () => {
    running();
    accepted("workflow.cancel");
    let decide!: (value: boolean) => void;
    data.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          decide = resolve;
        }),
    );
    await click("Cancel workflow");
    expect(data.invoke).not.toHaveBeenCalled();
    expect(data.confirm.mock.calls[0]?.[0]).toContain("Partial workspace changes remain");
    expect(text(render())).toContain("submitting");
    decide(true);
    await flush();
    expect(data.invoke).toHaveBeenCalledOnce();
    expect(text(render())).toContain("Cancellation accepted");
    expect(text(render())).toContain("RUNNING");
    expect(text(render())).toContain("Writer present:  true");
    expect(text(render())).not.toContain("CANCELLED");
  });
  it("cancels no Run when confirmation is declined or its revision becomes stale", async () => {
    running();
    data.confirm.mockResolvedValue(false);
    await click("Cancel workflow");
    expect(data.invoke).not.toHaveBeenCalled();
    let decide!: (value: boolean) => void;
    data.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          decide = resolve;
        }),
    );
    await click("Cancel workflow");
    update({ stateRevision: 8 });
    render();
    decide(true);
    await flush();
    expect(data.invoke).not.toHaveBeenCalled();
    expect(text(render())).toContain("Runtime view changed");
  });
  it("renders only the pending one-file grant and rejects without optimistic authority", async () => {
    running(true);
    accepted("approval.resolve");
    const card = control(render(), "Pending R3 approval");
    expect(text(card)).toContain("src/old.js");
    expect(text(card)).toContain("approval-1");
    expect(text(card)).toContain("b".repeat(64));
    await click("Reject");
    expect(data.confirm).not.toHaveBeenCalled();
    expect(data.invoke.mock.calls[0]?.[0].input.request).toMatchObject({
      type: "approval.resolve",
      approvalId: "approval-1",
      runId: "run-1",
      decision: "reject",
      expectedStateRevision: 7,
    });
    expect(text(render())).toContain("WAITING_APPROVAL");
    expect(text(render())).not.toContain("BLOCKED");
    update({ pendingApproval: null });
    expect(
      visitElements(render(), (node) => node.props["aria-label"] === "Pending R3 approval"),
    ).toBeNull();
  });
  it("requires explicit bounded approval and prevents duplicate submissions while pending", async () => {
    running(true);
    let finish!: (value: unknown) => void;
    data.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const button = control(render(), "Approve once");
    (button.props.onClick as () => void)();
    (button.props.onClick as () => void)();
    await flush();
    expect(data.confirm).toHaveBeenCalledOnce();
    expect(data.confirm.mock.calls[0]?.[0]).toContain("ONE deletion");
    expect(data.invoke).toHaveBeenCalledOnce();
    expect(text(render())).toContain("submitting");
    expect(control(render(), "Reject").props.disabled).toBe(true);
    finish(
      AsyncResult.success(
        response({
          kind: "accepted",
          requestId: "owner:2",
          command: "approval.resolve",
          runId: "run-1",
        }),
      ),
    );
    await flush();
    expect(text(render())).toContain("WAITING_APPROVAL");
    expect(text(render())).not.toContain("COMPLETED");
  });
  it("shows transport uncertainty without converting the Run into failure or retrying", async () => {
    running();
    data.invoke.mockRejectedValue(new Error("PRIVATE_TRANSPORT_MARKER"));
    await click("Cancel workflow");
    expect(text(render())).toContain("Transport error");
    expect(text(render())).toContain("RUNNING");
    expect(text(render())).not.toContain("PRIVATE_TRANSPORT_MARKER");
    data.phase = "disconnected";
    render();
    data.phase = "connected";
    render();
    await flush();
    expect(data.invoke).toHaveBeenCalledOnce();
  });
  it("disables disconnected, stale and unsupported actions instead of queuing them", async () => {
    await prepare();
    data.phase = "disconnected";
    expect(control(render(), "Confirm and start").props.disabled).toBe(true);
    data.phase = "connected";
    data.observation = { ...data.observation!, stale: true };
    expect(control(render(), "Confirm and start").props.disabled).toBe(true);
    data.observation = { ...data.observation!, stale: false };
    data.support = "unsupported";
    expect(control(render(), "Confirm and start").props.disabled).toBe(true);
    expect(data.invoke).toHaveBeenCalledOnce();
  });
});

const browserCandidate: WeavraBrowserCandidateSummary = {
  schemaVersion: 2,
  kind: "BROWSER_OBSERVATION_CANDIDATE",
  candidateId: "00000000-0000-4000-8000-000000000001",
  projectId: digest,
  authority: "CANDIDATE_ONLY",
  scope: "LOCAL_STATIC_DOCUMENT",
  origin: "http://127.0.0.1:3880",
  documentIdentity: "http://127.0.0.1:3880/status",
  capturedAt: 100,
  pageRevision: digest,
  source: {
    implementationRevision: digest,
    readerRevision: "a".repeat(40),
    readerDigest: digest,
    executableIdentityDigest: digest,
    browserVersion: "Chromium fixture",
  },
  freshness: { mode: "CAPTURE_ONLY", startedAt: 90, finishedAt: 100 },
  observationDigest: digest,
  observationType: "target",
  observation: { target: { selector: "#status" }, exists: true, value: "Ready" },
  candidateDigest: digest,
  cleanup: "CONFIRMED",
};
const browserPreview: WeavraBrowserPreview = {
  previewId: "browser-preview",
  previewDigest: digest,
  ownerId: "owner",
  projectRevision: 0,
  expiresAt: 9999999999999,
  candidate: browserCandidate,
  check: {
    version: 1,
    checkId: "status-ready",
    projectId: digest,
    origin: browserCandidate.origin,
    documentIdentity: browserCandidate.documentIdentity,
    target: browserCandidate.observation.target,
    assertion: { type: "text_equals", expected: "Reviewed Ready" },
    freshness: { mode: "NEW_ISOLATED_CAPTURE", maxAgeMs: 15000 },
    registrationDigest: digest,
  },
  isolation: "PRIVATE_HOME_PROFILE_CDP_PIPE_NOT_OS_SANDBOX",
};
async function inspectBrowser(evidence: WeavraBrowserState["evidence"] = []) {
  data.invoke.mockResolvedValue(
    AsyncResult.success(
      response({
        kind: "browser-state",
        state: {
          projectId: digest,
          candidates: [browserCandidate],
          omittedCandidates: 0,
          checks: [],
          omittedChecks: 0,
          evidence,
          omittedEvidence: 0,
        },
      }),
    ),
  );
  await click("Refresh browser evidence");
  update({ nextRequestId: "owner:2" });
}
async function prepareBrowser() {
  await inspectBrowser();
  await click("Review this candidate");
  change("Browser check name", "status-ready");
  change("Browser expected value", "Reviewed Ready");
  data.invoke.mockResolvedValue(
    AsyncResult.success(response({ kind: "browser-prepared", preview: browserPreview })),
  );
  const form = control(render(), "Browser expectation editor");
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
  await flush();
  update({ browserPreview, nextRequestId: "owner:3" });
}

describe("Weavra browser registration authority", () => {
  it("keeps candidate metadata read-only and sends the edited expectation only for Runtime preparation", async () => {
    await prepareBrowser();
    const tree = render();
    expect(text(tree)).toContain("CANDIDATE_ONLY");
    expect(text(tree)).toContain(browserCandidate.documentIdentity);
    expect(text(tree)).toContain(browserCandidate.candidateDigest);
    expect(control(tree, "Browser expected value").props.value).toBe("Reviewed Ready");
    const registration = data.invoke.mock.calls[1]?.[0].input.request.registration;
    expect(registration).toEqual({
      candidateId: browserCandidate.candidateId,
      expectedCandidateDigest: browserCandidate.candidateDigest,
      checkId: "status-ready",
      origin: browserCandidate.origin,
      documentIdentity: browserCandidate.documentIdentity,
      target: { selector: "#status" },
      assertion: { type: "text_equals", expected: "Reviewed Ready" },
      freshness: { mode: "NEW_ISOLATED_CAPTURE", maxAgeMs: 15000 },
    });
    expect(data.confirm).not.toHaveBeenCalled();
    expect(control(tree, "Confirm browser registration").props.disabled).toBe(false);
  });
  it("invalidates the reviewed preview when the expectation changes", async () => {
    await prepareBrowser();
    change("Browser expected value", "Different expectation");
    expect(control(render(), "Confirm browser registration").props.disabled).toBe(true);
    expect(data.invoke).toHaveBeenCalledTimes(2);
  });
  it("does not register when explicit confirmation is declined", async () => {
    await prepareBrowser();
    data.confirm.mockResolvedValue(false);
    await click("Confirm browser registration");
    expect(data.invoke).toHaveBeenCalledTimes(2);
  });
  it("sends exactly the Runtime preview once and does not turn registration acknowledgement into evidence", async () => {
    await prepareBrowser();
    let decide!: (value: boolean) => void;
    data.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          decide = resolve;
        }),
    );
    data.invoke.mockResolvedValue(
      AsyncResult.success(response({ kind: "browser-registered", check: browserPreview.check })),
    );
    const button = control(render(), "Confirm browser registration");
    (button.props.onClick as () => void)();
    (button.props.onClick as () => void)();
    await flush();
    expect(data.confirm).toHaveBeenCalledOnce();
    expect(data.invoke).toHaveBeenCalledTimes(2);
    decide(true);
    await flush();
    expect(data.invoke).toHaveBeenCalledTimes(3);
    expect(data.invoke.mock.calls[2]?.[0].input.request).toEqual({
      protocolVersion: 1,
      id: "owner:3",
      ownerId: "owner",
      expectedProjectRevision: 0,
      type: "browser.confirm",
      previewId: browserPreview.previewId,
      previewDigest: browserPreview.previewDigest,
    });
    expect(
      visitElements(
        render(),
        (node) => node.props["aria-label"] === "Runtime browser registration preview",
      ),
    ).toBeNull();
    expect(data.observation?.state?.snapshot.evidence).toBeNull();
    expect(data.observation?.state?.snapshot.status.run).toBeNull();
  });
  it("rechecks the edited expectation after the asynchronous confirmation dialog", async () => {
    await prepareBrowser();
    let decide!: (value: boolean) => void;
    data.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          decide = resolve;
        }),
    );
    await click("Confirm browser registration");
    change("Browser expected value", "Changed during review");
    render();
    decide(true);
    await flush();
    expect(data.invoke).toHaveBeenCalledTimes(2);
  });
  it("rejects replacement Runtime previews during confirmation even with unchanged request sequence", async () => {
    await prepareBrowser();
    let decide!: (value: boolean) => void;
    data.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          decide = resolve;
        }),
    );
    await click("Confirm browser registration");
    update({ browserPreview: { ...browserPreview, previewId: "replacement-preview" } });
    render();
    decide(true);
    await flush();
    expect(data.invoke).toHaveBeenCalledTimes(2);
  });
  it("disables historical browser state after owner replacement or disconnection without replay", async () => {
    await prepareBrowser();
    update({ ownerId: "new-owner", browserPreview: null });
    expect(control(render(), "Confirm browser registration").props.disabled).toBe(true);
    data.phase = "disconnected";
    expect(control(render(), "Refresh browser evidence").props.disabled).toBe(true);
    data.phase = "connected";
    render();
    await flush();
    expect(data.invoke).toHaveBeenCalledTimes(2);
  });
  it("renders unavailable latest evidence without fabricating a capture or falling back to a passing candidate", async () => {
    await inspectBrowser([
      {
        runId: "latest-run",
        checkId: "status-ready",
        revision: 0,
        step: { stepId: "test", attempt: 1 },
        status: "UNAVAILABLE",
        diffDigest: digest,
        browser: null,
      },
    ]);
    const tree = render();
    expect(text(tree)).toContain("UNAVAILABLE");
    expect(text(tree)).toContain("latest-run");
    expect(text(tree)).toContain("CANDIDATE_ONLY");
    expect(
      visitElements(tree, (node) => node.type === "strong" && text(node) === "PASS"),
    ).toBeNull();
    expect(data.invoke).toHaveBeenCalledOnce();
  });
});
