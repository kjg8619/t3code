import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentWeavraStateAtoms } from "@t3tools/client-runtime/state/weavra";
import type { EnvironmentId, ProjectId, WeavraObservation } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironment } from "../../state/environments";
import { Badge } from "../ui/badge";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsSection } from "./settingsLayout";
import { WeavraControls } from "./WeavraControls";

const observations = createEnvironmentWeavraStateAtoms(connectionAtomRuntime);
const explanations: Record<WeavraObservation["status"], string> = {
  NOT_INSTALLED:
    "No Weavra executable is configured or available on this environment. Configure T3_WEAVRA_EXECUTABLE on the server, then restart T3.",
  NOT_SETUP:
    "Weavra is installed but its private home is not set up. Run weavra setup on that environment, then reopen this view.",
  CONFIG_INVALID:
    "Local Weavra launch checks failed. Run weavra doctor on that environment; this view does not repair configuration.",
  READY:
    "Local launch checks passed. Provider authentication and network readiness are not verified. Waiting for a canonical snapshot.",
  CONNECTING: "Connecting the read-only observer. No workflow is being started.",
  CONNECTED:
    "Canonical snapshots are observed through the local bridge. A connected bridge is not proof of a live Runtime owner.",
  DISCONNECTED:
    "The bridge or environment disconnected. The last snapshot is stale; the stored Run status has not changed.",
  RECONNECTING:
    "Reconnecting and requesting a fresh canonical snapshot. Cached data remains stale until that read succeeds.",
  PROTOCOL_MISMATCH:
    "This Weavra bridge is incompatible with the supported read-only protocol. No commands will be sent beyond negotiation.",
  ERROR:
    "The observer could not read a valid canonical snapshot. Cached data is stale; no Runtime recovery or repair was attempted.",
};
const unknown = (value: string | number | boolean | null | undefined) =>
  value == null ? "UNKNOWN" : String(value);

export function WeavraSettings({
  environmentId,
  projectId,
  workspaceRoot,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  workspaceRoot: string;
}) {
  const result = useAtomValue(observations.stateAtom(environmentId, projectId, workspaceRoot));
  const environment = useEnvironment(environmentId);
  const view = Option.getOrUndefined(AsyncResult.value(result));
  const connected = environment?.connection.phase === "connected";
  const observation = view?.observation;
  const snapshot = observation?.snapshot;
  const run = snapshot?.data.status.run;
  const graph = snapshot?.data.graph;
  const evidence = snapshot?.data.evidence;
  const stale = !connected || observation?.stale !== false;
  const status = !connected ? "DISCONNECTED" : (observation?.status ?? "CONNECTING");
  return (
    <>
      <WeavraControls
        key={JSON.stringify([environmentId, projectId, workspaceRoot])}
        environmentId={environmentId}
        projectId={projectId}
        workspaceRoot={workspaceRoot}
      />
      <SettingsSection id="weavra-overview" title="Weavra · Read-only">
        <SettingsGroup divided={false} className="space-y-5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Runtime overview</h3>
            <div className="flex flex-wrap gap-2">
              <Badge variant={status === "CONNECTED" ? "info" : "outline"}>{status}</Badge>
              <Badge variant={stale ? "warning" : "secondary"}>
                {snapshot ? (stale ? "STALE SNAPSHOT" : "CANONICAL SNAPSHOT") : "NO SNAPSHOT"}
              </Badge>
            </div>
          </div>
          <div role="status" aria-live="polite" className="space-y-1 text-sm text-muted-foreground">
            <p>
              {view?.support === "unsupported"
                ? "This environment does not advertise the Weavra read-only integration. No Weavra RPC was sent."
                : explanations[status]}
            </p>
            <p>
              Runtime owner: UNKNOWN. Connection loss never cancels, fails, completes, or resumes a
              Run.
            </p>
            {observation?.errorCode && (
              <p>
                Observation error: <code>{observation.errorCode}</code>
              </p>
            )}
          </div>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            {[
              ["Environment", environment?.label],
              [
                "Last canonical observation",
                observation?.observedAt ? new Date(observation.observedAt).toLocaleString() : null,
              ],
              ["Runtime version", observation?.runtimeVersion],
              ["Bridge protocol", snapshot?.protocolVersion],
              ["Run", run?.runId],
              ["Durable status", run?.status],
              ["Phase", run?.phase],
              ["Workflow / risk", run ? `${run.workflow} / ${run.risk}` : null],
              ["Execution mode", run?.executionMode],
              [
                "Current step",
                run?.currentStep ? `${run.currentStep.stepId} #${run.currentStep.attempt}` : null,
              ],
              ["Active agents (stored)", run?.activeAgentCount],
              [
                "Run / project revision",
                snapshot
                  ? `${unknown(snapshot.stateRevision)} / ${unknown(snapshot.projectRevision)}`
                  : null,
              ],
              ["Code revision", run?.codeRevision],
              ["Event high-water mark", snapshot?.eventId],
              ["Task Contract digest", run?.taskContractDigest],
              ["Writer lock present (not liveness)", snapshot?.data.status.writerPresent],
            ].map(([label, value]) => (
              <div key={String(label)} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 break-all font-mono text-xs">{unknown(value)}</dd>
              </div>
            ))}
          </dl>
          {snapshot && !run && (
            <p className="text-sm text-muted-foreground">
              No current Weavra Run for this checkout.
            </p>
          )}
          <div className="space-y-3 border-t border-border/50 pt-4">
            <h3 className="text-sm font-medium">Runtime graph</h3>
            <p className="text-xs text-muted-foreground">
              Runtime-projected nodes and relationships. Edges are not executable controls; node
              colors do not establish completion.
            </p>
            {graph ? (
              <>
                <div className="overflow-x-auto">
                  <table
                    className="w-full text-left text-xs"
                    aria-label="Weavra Runtime graph nodes"
                  >
                    <thead className="text-muted-foreground">
                      <tr>
                        <th scope="col" className="py-2 pr-3">
                          Node
                        </th>
                        <th scope="col" className="py-2 pr-3">
                          Kind / role
                        </th>
                        <th scope="col" className="py-2">
                          Stored state
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {graph.nodes.map((node) => (
                        <tr key={node.id} className="border-t border-border/40">
                          <th scope="row" className="py-2 pr-3 font-mono font-normal">
                            {node.id}
                          </th>
                          <td className="py-2 pr-3">
                            {node.kind}
                            {node.role ? ` / ${node.role}` : ""}
                          </td>
                          <td className="py-2">
                            <Badge variant="outline">{node.status}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul
                  aria-label="Weavra Runtime graph relationships"
                  className="space-y-1 text-xs text-muted-foreground"
                >
                  {graph.edges.map((edge) => (
                    <li key={`${edge.from}->${edge.to}:${edge.kind}`} className="break-all">
                      <code>{edge.from}</code> → <code>{edge.to}</code> · {edge.kind}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Graph unavailable. No graph is reconstructed from events or cached fragments.
              </p>
            )}
          </div>
          <div className="space-y-3 border-t border-border/50 pt-4">
            <h3 className="text-sm font-medium">Evidence summary</h3>
            {evidence ? (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                {[
                  [
                    "Acceptance criteria",
                    `${evidence.criteria.met} met · ${evidence.criteria.notMet} unmet · ${evidence.criteria.unknown} unknown / ${evidence.criteria.total}`,
                  ],
                  [
                    "Current-revision checks",
                    `${evidence.currentChecks.passed} passed · ${evidence.currentChecks.failed} failed · ${evidence.currentChecks.unavailable} unavailable · ${evidence.currentChecks.skipped} skipped / ${evidence.currentChecks.total}`,
                  ],
                  [
                    "Review",
                    evidence.review
                      ? `${evidence.review.result} · independent: ${evidence.review.independent}`
                      : "UNKNOWN",
                  ],
                  [
                    "Recorded workers / tool calls",
                    `${evidence.workers.count} / ${evidence.workers.toolCalls}`,
                  ],
                  ["Reported tokens", unknown(evidence.workers.reportedTokens)],
                  [
                    "Reviewer contexts",
                    `${evidence.reviewerContexts.count} / ${evidence.reviewerContexts.bytes} bytes`,
                  ],
                  ["Failure category", unknown(evidence.failureCategory)],
                  [
                    "Legacy acceptance",
                    evidence.legacyAcceptanceUnknown ? "UNKNOWN" : "Current contract",
                  ],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-1 text-xs">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                Evidence unavailable. No PASS or acceptance verdict is inferred.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Summary only. Prompts, reasoning, credentials, transcripts, source, documentation
              bodies, and raw tool output are not transported.
            </p>
          </div>
          <div className="space-y-2 border-t border-border/50 pt-4 text-xs">
            <h3 className="text-sm font-medium">Project configuration summary</h3>
            <p className="text-muted-foreground">
              Current project configuration, not the frozen configuration of this Run.
            </p>
            <p>
              Status: {unknown(snapshot?.data.configuration.status)} · Registered checks:{" "}
              {unknown(snapshot?.data.configuration.registeredCheckCount)} · Required checks:{" "}
              {unknown(snapshot?.data.configuration.requiredCheckCount)}
            </p>
            {snapshot?.data.configuration.modes && (
              <dl className="grid grid-cols-2 gap-2">
                {Object.entries(snapshot.data.configuration.modes).map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </SettingsGroup>
      </SettingsSection>
    </>
  );
}
