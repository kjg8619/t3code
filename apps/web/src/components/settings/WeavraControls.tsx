import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentWeavraControlCommand,
  createEnvironmentWeavraControlStateAtoms,
} from "@t3tools/client-runtime/state/weavraControl";
import {
  type EnvironmentId,
  type ProjectId,
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
  const latest = useRef({ fresh, state });
  useLayoutEffect(() => {
    latest.current = { fresh, state };
  }, [fresh, state, latest]);
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
          current.state.stateRevision !== request.expectedStateRevision)
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
