import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentWeavraControlCommand,
  createEnvironmentWeavraControlStateAtoms,
} from "@t3tools/client-runtime/state/weavraControl";
import {
  type EnvironmentId,
  type ProjectId,
  type WeavraBrowserAssertion,
  type WeavraBrowserPreview,
  type WeavraBrowserState,
  WeavraControlMutation,
  type WeavraControlPreview,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsSection } from "./settingsLayout";

const observations = createEnvironmentWeavraControlStateAtoms(connectionAtomRuntime);
const command = createEnvironmentWeavraControlCommand(connectionAtomRuntime);
const decodeMutation = Schema.decodeUnknownSync(WeavraControlMutation, {
  onExcessProperty: "error",
});
type CommandState = {
  status: "idle" | "submitting" | "accepted" | "rejected" | "transport-error";
  message: string;
};
const idle: CommandState = {
  status: "idle",
  message: "Commands request Runtime actions. Only canonical snapshots establish outcomes.",
};

export function WeavraControls({
  environmentId,
  projectId,
  workspaceRoot,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  workspaceRoot: string;
}) {
  const observationResult = useAtomValue(
    observations.stateAtom(environmentId, projectId, workspaceRoot),
  );
  const view = Option.getOrUndefined(AsyncResult.value(observationResult));
  const environment = useEnvironment(environmentId);
  const invoke = useAtomCommand(command, { reportFailure: false, reportDefect: false });
  const [goal, setGoal] = useState("");
  const [recipeId, setRecipeId] = useState("");
  const [recipeInputs, setRecipeInputs] = useState("{}");
  const [criteria, setCriteria] = useState("");
  const [preview, setPreview] = useState<WeavraControlPreview | null>(null);
  const [preparedDraft, setPreparedDraft] = useState<string | null>(null);
  const [commandState, setCommandState] = useState<CommandState>(idle);
  const pending = useRef(false);
  const mounted = useRef(true);
  const [browserInspection, setBrowserInspection] = useState<{
    ownerId: string;
    projectRevision: number;
    stateRevision: number | null;
    runId: string | null;
    data: WeavraBrowserState;
  } | null>(null);
  const [candidateId, setCandidateId] = useState("");
  const [browserCheckId, setBrowserCheckId] = useState("");
  const [assertionType, setAssertionType] = useState<WeavraBrowserAssertion["type"]>("text_equals");
  const [expectedValue, setExpectedValue] = useState("");
  const [browserPreview, setBrowserPreview] = useState<WeavraBrowserPreview | null>(null);
  const [preparedBrowserDraft, setPreparedBrowserDraft] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const observation = view?.observation;
  const observedAt = observation?.observedAt ?? Number.POSITIVE_INFINITY;
  const state = observation?.state;
  const fresh =
    environment?.connection.phase === "connected" &&
    view?.support === "supported" &&
    observation?.status === "CONNECTED" &&
    !observation.stale &&
    !!state;
  const candidate = browserInspection?.data.candidates.find(
    (item) => item.candidateId === candidateId,
  );
  const browserDraftIdentity = JSON.stringify([
    candidate?.candidateId,
    candidate?.candidateDigest,
    browserCheckId,
    assertionType,
    expectedValue,
  ]);
  const browserInspectionCurrent =
    fresh &&
    browserInspection !== null &&
    browserInspection.ownerId === state?.ownerId &&
    browserInspection.projectRevision === state.projectRevision &&
    browserInspection.stateRevision === state.stateRevision &&
    browserInspection.runId === (state.snapshot.status.run?.runId ?? null);
  const browserPreviewCurrent =
    browserInspectionCurrent &&
    browserPreview !== null &&
    state?.browserPreview?.previewId === browserPreview.previewId &&
    state.browserPreview.previewDigest === browserPreview.previewDigest &&
    state.ownerId === browserPreview.ownerId &&
    state.projectRevision === browserPreview.projectRevision &&
    browserPreview.expiresAt > observedAt &&
    browserPreview.candidate.candidateId === candidate?.candidateId &&
    browserPreview.candidate.candidateDigest === candidate?.candidateDigest &&
    preparedBrowserDraft === browserDraftIdentity;
  const latest = useRef({ fresh, state, browserPreviewCurrent, browserDraftIdentity });
  useLayoutEffect(() => {
    latest.current = { fresh, state, browserPreviewCurrent, browserDraftIdentity };
  }, [fresh, state, browserPreviewCurrent, browserDraftIdentity, latest]);
  const run = state?.snapshot.status.run;
  const submitting = commandState.status === "submitting";
  const draftIdentity = JSON.stringify([goal, recipeId, recipeInputs]);
  const previewCurrent =
    fresh &&
    preview !== null &&
    state?.preview?.previewId === preview.previewId &&
    state.preview.previewDigest === preview.previewDigest &&
    state.ownerId === preview.ownerId &&
    state.projectRevision === preview.projectRevision &&
    preview.expiresAt > observedAt &&
    preparedDraft === draftIdentity &&
    criteria === preview.acceptanceCriteria.map((criterion) => criterion.statement).join("\n");
  const canPrepare =
    fresh &&
    !state?.busy &&
    state?.snapshot.status.writerPresent === false &&
    !["CREATED", "RUNNING", "WAITING_APPROVAL"].includes(run?.status ?? "") &&
    !submitting;
  const canCancel =
    fresh &&
    state?.busy &&
    !state.cancelling &&
    state.ownedRunId === run?.runId &&
    ["CREATED", "RUNNING", "WAITING_APPROVAL"].includes(run?.status ?? "") &&
    state.stateRevision !== null &&
    !submitting;
  const approval =
    fresh && state?.busy && state.ownedRunId === run?.runId && run?.status === "WAITING_APPROVAL"
      ? state.pendingApproval
      : null;
  const common = () => {
    const current = latest.current;
    if (!current.fresh || !current.state || pending.current) return null;
    return {
      protocolVersion: 1 as const,
      id: current.state.nextRequestId,
      ownerId: current.state.ownerId,
      expectedProjectRevision: current.state.projectRevision,
    };
  };
  const submit = async (request: WeavraControlMutation, confirmation?: string) => {
    if (pending.current || !latest.current.fresh || !mounted.current) return;
    pending.current = true;
    setCommandState({
      status: "submitting",
      message: confirmation
        ? "Waiting for explicit confirmation."
        : "Submitting command to Runtime.",
    });
    try {
      if (confirmation && !(await requestConfirmDialog(confirmation))) {
        if (mounted.current) setCommandState(idle);
        return;
      }
      const current = latest.current;
      if (!mounted.current) return;
      if (
        !current.fresh ||
        current.state?.ownerId !== request.ownerId ||
        current.state.nextRequestId !== request.id ||
        current.state.projectRevision !== request.expectedProjectRevision ||
        ("expectedStateRevision" in request &&
          current.state.stateRevision !== request.expectedStateRevision) ||
        (request.type === "browser.confirm" &&
          (!current.browserPreviewCurrent ||
            current.browserDraftIdentity !== browserDraftIdentity ||
            current.state.browserPreview?.previewId !== request.previewId ||
            current.state.browserPreview.previewDigest !== request.previewDigest))
      ) {
        setCommandState({
          status: "rejected",
          message: "The Runtime view changed. Review fresh state before submitting again.",
        });
        return;
      }
      const result = await invoke({ environmentId, input: { projectId, request } });
      if (!mounted.current) return;
      if (!AsyncResult.isSuccess(result)) {
        setCommandState({
          status: "transport-error",
          message:
            "Transport error: command outcome is unknown. Wait for fresh Runtime state. No automatic retry was sent.",
        });
        return;
      }
      const response = result.value;
      if (!response.success) {
        setCommandState({
          status: "rejected",
          message: `Runtime rejected the command: ${response.error.code}. Review fresh state before trying again.`,
        });
        return;
      }
      if (response.data.kind === "prepared") {
        setPreview(response.data.preview);
        setPreparedDraft(draftIdentity);
        setBrowserPreview(null);
        setPreparedBrowserDraft(null);
        setCriteria(
          response.data.preview.acceptanceCriteria
            .map((criterion) => criterion.statement)
            .join("\n"),
        );
        setCommandState({
          status: "accepted",
          message:
            "Plan prepared by Runtime. No workflow has started; review and explicitly confirm this preview.",
        });
      } else if (response.data.kind === "browser-state") {
        setBrowserInspection({
          ownerId: response.ownerId,
          projectRevision: response.projectRevision ?? 0,
          stateRevision: response.stateRevision,
          runId: response.runId,
          data: response.data.state,
        });
        setBrowserPreview(null);
        setPreparedBrowserDraft(null);
        setCommandState({
          status: "accepted",
          message:
            "Recorded browser candidates and evidence loaded from Runtime. Historical captures are not a live page check.",
        });
      } else if (response.data.kind === "browser-prepared") {
        setBrowserPreview(response.data.preview);
        setPreparedBrowserDraft(browserDraftIdentity);
        setPreview(null);
        setPreparedDraft(null);
        setCommandState({
          status: "accepted",
          message:
            "Browser registration preview prepared by Runtime. Review the expectation and explicitly confirm; nothing is registered yet.",
        });
      } else if (response.data.kind === "browser-registered") {
        setBrowserPreview(null);
        setPreparedBrowserDraft(null);
        setBrowserInspection(null);
        setCommandState({
          status: "accepted",
          message:
            "Runtime acknowledged registration. Refresh browser evidence to read the registry. Registration is not PASS or COMPLETE; each verification requires a new isolated capture.",
        });
      } else {
        setCommandState({
          status: "accepted",
          message:
            request.type === "workflow.cancel"
              ? "Cancellation accepted. Wait for canonical terminal state and writer release. Partial changes remain."
              : request.type === "approval.resolve"
                ? "Decision accepted for the pending request. Runtime still owns approval validation, consumption and completion."
                : "Start accepted. Waiting for canonical Run state; this acknowledgement does not establish success.",
        });
      }
    } catch {
      if (mounted.current)
        setCommandState({
          status: "transport-error",
          message:
            "Transport error: command outcome is unknown. Observe fresh Runtime state; do not assume the action failed.",
        });
    } finally {
      pending.current = false;
    }
  };
  const invalidateDraft = () => {
    setPreview(null);
    setPreparedDraft(null);
    setCriteria("");
    setCommandState(idle);
  };
  const prepare = () => {
    const fields = common();
    if (!fields || !canPrepare || !goal.trim()) return;
    try {
      const request = decodeMutation({
        ...fields,
        type: "workflow.prepare",
        goal: goal.trim(),
        ...(recipeId ? { recipeId, recipeInputs: JSON.parse(recipeInputs) as unknown } : {}),
        ...(preview
          ? {
              acceptanceStatements: criteria
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            }
          : {}),
      });
      void submit(request);
    } catch {
      setCommandState({
        status: "rejected",
        message:
          "Invalid goal, recipe JSON or acceptance criteria. Use at most 16 nonempty criteria of 500 characters each.",
      });
    }
  };
  const confirm = () => {
    const fields = common();
    if (!fields || !previewCurrent || !preview || state?.busy) return;
    void submit(
      {
        ...fields,
        type: "workflow.confirm",
        previewId: preview.previewId,
        previewDigest: preview.previewDigest,
      },
      `Start this exact ${preview.workflow} / ${preview.risk} / ${preview.executionMode} plan for ${workspaceRoot}?\nGoal: ${preview.goal}\nPlan confirmation is not R3 approval. No automatic commit, rollback or cleanup.`,
    );
  };
  const cancel = () => {
    const fields = common();
    if (!fields || !canCancel || !run || state?.stateRevision == null) return;
    void submit(
      {
        ...fields,
        type: "workflow.cancel",
        runId: run.runId,
        expectedStateRevision: state.stateRevision,
      },
      `Cancel Run ${run.runId}?\nRuntime must stop active workers and checks before releasing its writer. Partial workspace changes remain. No automatic rollback or cleanup.`,
    );
  };
  const resolveApproval = (decision: "approve" | "reject") => {
    const fields = common();
    if (!fields || !approval || approval.expiresAt <= observedAt || submitting) return;
    void submit(
      {
        ...fields,
        type: "approval.resolve",
        runId: approval.runId,
        expectedStateRevision: approval.stateRevision,
        approvalId: approval.approvalId,
        decision,
      },
      decision === "approve"
        ? `Approve ONE deletion of ${approval.path}?\nRun: ${approval.runId}\nApproval: ${approval.approvalId}\nFingerprint: ${approval.preconditionDigest}\nNo automatic rollback. This does not approve any other action or establish completion.`
        : undefined,
    );
  };
  const inspectBrowser = () => {
    const fields = common();
    if (fields) void submit({ ...fields, type: "browser.inspect" });
  };
  const prepareBrowser = () => {
    const fields = common();
    if (!fields || !canPrepare || !browserInspectionCurrent || !candidate) return;
    try {
      void submit(
        decodeMutation({
          ...fields,
          type: "browser.prepare",
          registration: {
            candidateId: candidate.candidateId,
            expectedCandidateDigest: candidate.candidateDigest,
            checkId: browserCheckId,
            origin: candidate.origin,
            documentIdentity: candidate.documentIdentity,
            target: candidate.observation.target,
            assertion:
              assertionType === "element_exists" || assertionType === "element_not_exists"
                ? { type: assertionType }
                : { type: assertionType, expected: expectedValue },
            freshness: { mode: "NEW_ISOLATED_CAPTURE", maxAgeMs: 15000 },
          },
        }),
      );
    } catch {
      setCommandState({
        status: "rejected",
        message:
          "Use a check name of 1–64 letters, digits, dots, hyphens or underscores, starting with a letter or digit, and a bounded supported expectation.",
      });
    }
  };
  const confirmBrowser = () => {
    const fields = common();
    if (!fields || !canPrepare || !browserPreviewCurrent || !browserPreview) return;
    void submit(
      {
        ...fields,
        type: "browser.confirm",
        previewId: browserPreview.previewId,
        previewDigest: browserPreview.previewDigest,
      },
      `Register this exact browser check for ${workspaceRoot}?\nCheck: ${browserPreview.check.checkId}\nDocument: ${browserPreview.check.documentIdentity}\nTarget: ${browserPreview.check.target.selector}\nAssertion: ${JSON.stringify(browserPreview.check.assertion)}\nRegistration digest: ${browserPreview.check.registrationDigest}\nThis records an expectation, not PASS. Runtime must capture a new isolated browser document for every SELF_CHECK and TEST. Browser failures never trigger automatic repair.`,
    );
  };
  return (
    <SettingsSection id="weavra-controls" title="Weavra · Workflow control">
      <SettingsGroup divided={false} className="space-y-5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Runtime-owned actions</h3>
          <Badge variant={fresh ? "info" : "outline"}>
            {fresh ? "CONTROL CONNECTED" : "CONTROL UNAVAILABLE"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {view?.support === "unsupported"
            ? "This environment does not advertise workflow control. Enable T3_WEAVRA_CONTROL=1 on the trusted server to opt in. Read-only observation remains available."
            : "Control requires orchestration:operate access and a fresh canonical snapshot. Risk, scope, checks, Task Contract, Policy, approval consumption and completion remain Runtime/Kernel-owned."}
        </p>
        {!fresh && (
          <p className="text-xs text-muted-foreground">
            Controls are disabled while disconnected, unsupported or stale. No action is queued for
            reconnect.{observation?.errorCode ? ` Connection error: ${observation.errorCode}.` : ""}
          </p>
        )}
        <div role="status" aria-live="polite" className="space-y-2 text-sm">
          <Badge
            variant={
              commandState.status === "rejected" || commandState.status === "transport-error"
                ? "warning"
                : "secondary"
            }
          >
            {commandState.status}
          </Badge>
          <p>{commandState.message}</p>
        </div>
        {state?.startFailure && (
          <p className="text-sm text-destructive">
            Runtime preflight did not create a Run. Inspect the trusted configuration and workspace;
            no automatic retry was performed.
          </p>
        )}
        {run && (
          <div className="space-y-2 rounded-md border border-border p-3 text-xs">
            <p>
              Canonical Run: <code className="break-all">{run.runId}</code>
            </p>
            <p>
              Durable status: <strong>{run.status}</strong> · Run revision:{" "}
              {state?.stateRevision ?? "UNKNOWN"} · Project revision:{" "}
              {state?.projectRevision ?? "UNKNOWN"}
            </p>
            <p>
              Owner operation:{" "}
              {state?.busy
                ? state.cancelling
                  ? "cancellation requested; cleanup pending"
                  : "active"
                : "idle"}{" "}
              · Writer present: {String(state?.snapshot.status.writerPresent ?? "UNKNOWN")}
            </p>
            <p>Partial workspace changes are never rolled back automatically.</p>
            {canCancel && (
              <Button size="sm" variant="outline" onClick={cancel}>
                Cancel workflow
              </Button>
            )}
          </div>
        )}
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            prepare();
          }}
        >
          <label className="block space-y-1 text-sm">
            <span>Workflow goal</span>
            <Textarea
              aria-label="Workflow goal"
              maxLength={2048}
              value={goal}
              onChange={(event) => {
                invalidateDraft();
                setGoal(event.target.value);
              }}
              disabled={submitting || !fresh || !!state?.busy}
              placeholder="Describe a supported task for this checkout"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Reviewed recipe (optional)</span>
            <select
              aria-label="Reviewed recipe"
              value={recipeId}
              disabled={submitting || !fresh || !!state?.busy}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              onChange={(event) => {
                invalidateDraft();
                setRecipeId(event.target.value);
                setRecipeInputs(
                  observation?.capabilities?.recipes.find(
                    (recipe) => recipe.id === event.target.value,
                  )?.inputTemplate ?? "{}",
                );
              }}
            >
              <option value="">No recipe</option>
              {observation?.capabilities?.recipes.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>
                  {recipe.title} · v{recipe.version}
                </option>
              ))}
            </select>
          </label>
          {recipeId && (
            <label className="block space-y-1 text-sm">
              <span>Recipe inputs (JSON data only)</span>
              <Textarea
                aria-label="Recipe inputs"
                value={recipeInputs}
                maxLength={16384}
                onChange={(event) => {
                  invalidateDraft();
                  setRecipeInputs(event.target.value);
                }}
                disabled={submitting || !fresh || !!state?.busy}
                className="font-mono text-xs"
              />
            </label>
          )}
          <Button size="sm" type="submit" disabled={!canPrepare || !goal.trim()}>
            {preview ? "Refresh Plan Preview" : "Prepare workflow"}
          </Button>
        </form>
        {preview && (
          <section
            aria-label="Runtime Plan Preview"
            className="space-y-4 rounded-md border border-border p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-medium">Runtime Plan Preview</h4>
              <Badge variant={previewCurrent ? "info" : "warning"}>
                {previewCurrent ? "CURRENT PREVIEW" : "REVIEW / REFRESH REQUIRED"}
              </Badge>
            </div>
            <p className="text-sm">{preview.goal}</p>
            <dl className="grid gap-3 text-xs sm:grid-cols-2">
              {[
                ["Workflow", preview.workflow],
                ["Risk", preview.risk],
                ["Execution mode", preview.executionMode],
                ["Allowed scope", preview.allowedPaths.join(", ") || "None"],
                [
                  "Recipe",
                  preview.recipe ? `${preview.recipe.id}@${preview.recipe.version}` : "None",
                ],
                ["Expires", new Date(preview.expiresAt).toLocaleString()],
                [
                  "Configuration",
                  Object.entries(preview.configuration)
                    .map(([key, value]) => `${key}: ${String(value)}`)
                    .join(" · "),
                ],
                ["Task Contract digest", preview.taskContractDigest],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="mt-1 break-all">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="text-xs">
              <h5 className="font-medium">Runtime-registered checks</h5>
              <ul className="mt-1 space-y-1">
                {preview.checks.map((check) => (
                  <li key={check.id}>
                    {check.id} · {check.kind} · {check.required ? "required" : "optional"}
                  </li>
                ))}
              </ul>
            </div>
            <label className="block space-y-1 text-sm">
              <span>Acceptance criteria · one line per criterion</span>
              <Textarea
                aria-label="Acceptance criteria"
                value={criteria}
                maxLength={16384}
                disabled={!fresh || submitting || !!state?.busy}
                onChange={(event) => setCriteria(event.target.value)}
              />
            </label>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {preview.acceptanceCriteria.map((criterion) => (
                <li key={criterion.id}>
                  {criterion.id} · checks: {criterion.checkIds.join(", ") || "none"} · independent
                  review: {criterion.reviewRequired ? "required" : "not required"}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Editing criteria requires a fresh Runtime preview. T3 never assigns criterion IDs,
              verification mappings or the frozen contract. Confirmation is not an approval token.
            </p>
            <Button
              size="sm"
              disabled={!previewCurrent || submitting || !!state?.busy}
              onClick={confirm}
            >
              Confirm and start
            </Button>
          </section>
        )}
        <section
          aria-label="Browser evidence and registration"
          className="space-y-4 border-t border-border pt-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium">Browser checks</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Observe → review expectation → register → independently verify
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!fresh || submitting}
              onClick={inspectBrowser}
            >
              Refresh browser evidence
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Local static documents only. Candidates are recorded observations, not checks or proof
            of current page state. Runtime owns registration, fresh private HOME/profile/CDP-pipe
            captures and Kernel completion. Browser isolation is not an OS sandbox. No personal
            browser session, scripts or interactive actions are accepted.
          </p>
          {browserInspection && (
            <>
              <Badge variant={browserInspectionCurrent ? "outline" : "warning"}>
                {browserInspectionCurrent
                  ? "RECORDED RUNTIME INSPECTION"
                  : "STALE INSPECTION · REFRESH REQUIRED"}
              </Badge>
              {browserInspection.data.candidates.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No saved target candidates. Use the Runtime browser observation command with
                  explicit candidate saving.
                </p>
              )}
              <div className="space-y-3">
                {browserInspection.data.candidates.map((item) => (
                  <article
                    key={item.candidateId}
                    className="space-y-3 rounded-md border border-border bg-muted/20 p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <code className="text-xs">
                        {item.observation.target.selector}
                        {item.observation.target.attribute
                          ? ` · ${item.observation.target.attribute}`
                          : ""}
                      </code>
                      <Badge variant="warning">CANDIDATE_ONLY</Badge>
                    </div>
                    <dl className="grid gap-2 text-xs sm:grid-cols-2">
                      {[
                        ["Origin", item.origin],
                        ["Document", item.documentIdentity],
                        ["Captured", new Date(item.capturedAt).toLocaleString()],
                        [
                          "Observed value",
                          item.observation.exists
                            ? (item.observation.value ?? "(attribute absent)")
                            : "(element absent)",
                        ],
                        ["Candidate", item.candidateId],
                        ["Candidate digest", item.candidateDigest],
                        ["Document revision", item.pageRevision],
                        ["Reader revision", item.source.readerRevision],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="mt-1 whitespace-pre-wrap break-all">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canPrepare || !browserInspectionCurrent}
                      onClick={() => {
                        setCandidateId(item.candidateId);
                        setAssertionType(
                          item.observation.target.attribute ? "attribute_equals" : "text_equals",
                        );
                        setExpectedValue(item.observation.value ?? "");
                        setBrowserPreview(null);
                        setPreparedBrowserDraft(null);
                      }}
                    >
                      {candidateId === item.candidateId
                        ? "Selected for review"
                        : "Review this candidate"}
                    </Button>
                  </article>
                ))}
              </div>
              {browserInspection.data.omittedCandidates > 0 && (
                <p className="text-xs text-muted-foreground">
                  {browserInspection.data.omittedCandidates} additional candidates omitted from this
                  bounded view.
                </p>
              )}
              {candidate && (
                <form
                  aria-label="Browser expectation editor"
                  className="space-y-3 rounded-md border border-border p-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    prepareBrowser();
                  }}
                >
                  <p className="text-xs text-muted-foreground">
                    The observed value is only a starting point. Review and edit the expected
                    behavior before requesting a Runtime preview.
                  </p>
                  <label className="block space-y-1 text-sm">
                    <span>Browser check name</span>
                    <input
                      aria-label="Browser check name"
                      value={browserCheckId}
                      maxLength={64}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      disabled={!canPrepare || !browserInspectionCurrent}
                      onChange={(event) => setBrowserCheckId(event.target.value)}
                      placeholder="status-ready"
                    />
                  </label>
                  <label className="block space-y-1 text-sm">
                    <span>Browser assertion</span>
                    <select
                      aria-label="Browser assertion"
                      value={assertionType}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      disabled={!canPrepare || !browserInspectionCurrent}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (
                          value === "text_equals" ||
                          value === "text_contains" ||
                          value === "element_exists" ||
                          value === "element_not_exists" ||
                          value === "attribute_equals"
                        )
                          setAssertionType(value);
                      }}
                    >
                      {(candidate.observation.target.attribute
                        ? ["attribute_equals"]
                        : ["text_equals", "text_contains", "element_exists", "element_not_exists"]
                      ).map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </label>
                  {assertionType !== "element_exists" && assertionType !== "element_not_exists" && (
                    <label className="block space-y-1 text-sm">
                      <span>Expected value · review and edit</span>
                      <Textarea
                        aria-label="Browser expected value"
                        value={expectedValue}
                        maxLength={1024}
                        disabled={!canPrepare || !browserInspectionCurrent}
                        onChange={(event) => setExpectedValue(event.target.value)}
                      />
                    </label>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Fixed target: {candidate.observation.target.selector} · fresh capture every
                    verification · maximum evidence age 15 seconds.
                  </p>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      !canPrepare ||
                      !browserInspectionCurrent ||
                      !browserCheckId ||
                      (assertionType === "text_contains" && !expectedValue)
                    }
                  >
                    Prepare browser registration
                  </Button>
                </form>
              )}
              {browserPreview && (
                <section
                  aria-label="Runtime browser registration preview"
                  className="space-y-3 rounded-md border border-border p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-medium">Runtime browser registration preview</h4>
                    <Badge variant={browserPreviewCurrent ? "info" : "warning"}>
                      {browserPreviewCurrent
                        ? "REVIEW BEFORE REGISTERING"
                        : "REFRESH PREVIEW REQUIRED"}
                    </Badge>
                  </div>
                  <dl className="grid gap-2 text-xs sm:grid-cols-2">
                    {[
                      ["Check", browserPreview.check.checkId],
                      ["Document", browserPreview.check.documentIdentity],
                      ["Target", JSON.stringify(browserPreview.check.target)],
                      ["Expectation", JSON.stringify(browserPreview.check.assertion)],
                      ["Registration digest", browserPreview.check.registrationDigest],
                      ["Preview digest", browserPreview.previewDigest],
                      ["Expires", new Date(browserPreview.expiresAt).toLocaleString()],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="mt-1 whitespace-pre-wrap break-all">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="text-xs text-muted-foreground">
                    Confirming registers only this expectation. It does not capture the page,
                    produce PASS, start a workflow or authorize automatic repair.
                  </p>
                  <Button
                    size="sm"
                    disabled={!canPrepare || !browserPreviewCurrent}
                    onClick={confirmBrowser}
                  >
                    Confirm browser registration
                  </Button>
                </section>
              )}
              <div className="space-y-2 text-xs">
                <h4 className="font-medium">Runtime registry · recorded view</h4>
                {browserInspection.data.checks.length === 0 && (
                  <p className="text-muted-foreground">
                    No registered browser checks in this view.
                  </p>
                )}
                {browserInspection.data.checks.map(({ check, required }) => (
                  <div
                    key={check.checkId}
                    className="space-y-1 rounded-md border border-border p-3"
                  >
                    <p>
                      {check.checkId} · {required ? "required" : "optional"} ·{" "}
                      <strong>REGISTERED, NOT VERIFIED</strong>
                    </p>
                    <p className="break-all">
                      {check.documentIdentity} · {check.target.selector}
                    </p>
                    <p className="whitespace-pre-wrap break-all">
                      {JSON.stringify(check.assertion)}
                    </p>
                    <p className="break-all text-muted-foreground">{check.registrationDigest}</p>
                  </div>
                ))}
                {browserInspection.data.omittedChecks > 0 && (
                  <p className="text-muted-foreground">
                    {browserInspection.data.omittedChecks} additional checks omitted.
                  </p>
                )}
              </div>
              <div className="space-y-2 text-xs">
                <h4 className="font-medium">Latest durable Run · recorded browser evidence</h4>
                <p className="text-muted-foreground">
                  A recorded PASS applies only to its capture, Run, step and revision. It is not a
                  live page status. Missing or unavailable evidence never falls back to an older
                  passing Run.
                </p>
                {browserInspection.data.evidence.length === 0 && (
                  <p className="text-muted-foreground">
                    No browser verification evidence in the latest Run.
                  </p>
                )}
                {browserInspection.data.evidence.map((entry) => (
                  <div
                    key={`${entry.runId}:${entry.checkId}:${entry.revision}:${entry.step?.stepId}:${entry.step?.attempt ?? "unknown"}`}
                    className="space-y-1 rounded-md border border-border p-3"
                  >
                    <p>
                      {entry.checkId} · {entry.step?.stepId ?? "unknown step"} ·{" "}
                      <strong>{entry.status}</strong>
                    </p>
                    <p className="break-all">
                      Run {entry.runId} · revision {entry.revision}
                    </p>
                    {entry.browser ? (
                      <>
                        <p>
                          Captured {new Date(entry.browser.capturedAt).toLocaleString()} · cleanup{" "}
                          {entry.browser.cleanup}
                        </p>
                        <p className="break-all">{entry.browser.documentIdentity}</p>
                        <p className="break-all text-muted-foreground">
                          Registration {entry.browser.registrationDigest}
                        </p>
                        <p className="break-all text-muted-foreground">
                          Document {entry.browser.documentDigest}
                        </p>
                      </>
                    ) : (
                      <p className="text-muted-foreground">
                        No accepted browser capture metadata for this result.
                      </p>
                    )}
                  </div>
                ))}
                {browserInspection.data.omittedEvidence > 0 && (
                  <p className="text-muted-foreground">
                    {browserInspection.data.omittedEvidence} additional browser results omitted.
                  </p>
                )}
              </div>
            </>
          )}
        </section>
        {approval && (
          <section
            aria-label="Pending R3 approval"
            className="space-y-3 rounded-md border border-warning/50 p-4 text-sm"
          >
            <h4 className="font-medium">Pending R3 approval · one file deletion</h4>
            <p>{approval.explanation}</p>
            <dl className="grid gap-2 text-xs sm:grid-cols-2">
              {[
                ["Target", approval.path],
                ["Run", approval.runId],
                ["Approval", approval.approvalId],
                ["Operation / role", `${approval.operation} / ${approval.role}`],
                ["Step", `${approval.step.stepId}@${approval.step.attempt}`],
                [
                  "Run / project revision",
                  `${approval.stateRevision} / ${approval.projectRevision}`,
                ],
                ["Bytes", String(approval.bytes)],
                ["Fingerprint", approval.preconditionDigest],
                ["Expires", new Date(approval.expiresAt).toLocaleString()],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="break-all">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">
              Deny is the default. No session-wide grant, scope expansion or automatic rollback.
              Approval alone never means PASS or COMPLETE.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={submitting || approval.expiresAt <= observedAt}
                onClick={() => resolveApproval("reject")}
              >
                Reject
              </Button>
              <Button
                size="sm"
                disabled={submitting || approval.expiresAt <= observedAt}
                onClick={() => resolveApproval("approve")}
              >
                Approve once
              </Button>
            </div>
          </section>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
