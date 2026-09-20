import { createEnvironmentWeavraFitnessCommand } from "@t3tools/client-runtime/state/weavraFitness";
import type {
  EnvironmentId,
  ProjectId,
  WeavraFitnessComparison,
  WeavraFitnessHistory,
  WeavraFitnessInput,
  WeavraFitnessSummary,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef, useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsSection } from "./settingsLayout";

const command = createEnvironmentWeavraFitnessCommand(connectionAtomRuntime);
const value = (number: number | null) => (number === null ? "UNKNOWN" : number.toLocaleString());
const groups = ["correctness", "contract", "tools", "reliability", "efficiency"] as const;

function Evidence({ run }: { run: WeavraFitnessSummary }) {
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p>
        Calibration: <span className="font-mono">{run.calibration ?? "UNKNOWN"}</span>
      </p>
      <p>
        Evaluation: <span className="font-mono">{run.evaluation ?? "UNKNOWN"}</span>
      </p>
      <p>
        Stop reasons:{" "}
        <span className="font-mono">
          {run.stopReasons === undefined ? "UNKNOWN" : run.stopReasons.join(", ") || "none"}
        </span>
      </p>
      {run.fixtureResults === undefined ? (
        <p>Fixture outcomes UNKNOWN (historical record)</p>
      ) : (
        <details>
          <summary className="cursor-pointer">Fixture outcomes</summary>
          <div className="mt-2 overflow-x-auto">
            <table
              className="w-full text-left text-xs"
              aria-label={`Fixture outcomes for ${run.id}`}
            >
              <thead className="text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-4">
                    Fixture
                  </th>
                  <th scope="col" className="pr-4">
                    Terminal
                  </th>
                  <th scope="col" className="pr-4">
                    Oracle
                  </th>
                  <th scope="col" className="pr-4">
                    False complete
                  </th>
                  <th scope="col" className="pr-4">
                    Task contract adherence
                  </th>
                  <th scope="col" className="pr-4">
                    Usage
                  </th>
                  <th scope="col" className="pr-4">
                    Integrity / reasons
                  </th>
                  <th scope="col">Latency (ms)</th>
                </tr>
              </thead>
              <tbody>
                {run.fixtureResults.map((fixture) => (
                  <tr key={fixture.fixtureId} className="border-t border-border/40 font-mono">
                    <th scope="row" className="py-2 pr-4 font-normal">
                      {fixture.fixtureId}
                    </th>
                    <td className="pr-4">{fixture.terminalStatus}</td>
                    <td className="pr-4">{fixture.oracle}</td>
                    <td className="pr-4">
                      {fixture.falseCompletion === null
                        ? "UNKNOWN"
                        : String(fixture.falseCompletion)}
                    </td>
                    <td className="pr-4">
                      {fixture.taskContractAdherence === null
                        ? "UNKNOWN"
                        : String(fixture.taskContractAdherence)}
                    </td>
                    <td className="pr-4">{fixture.usageState}</td>
                    <td className="pr-4">
                      {fixture.integrity === null
                        ? "UNKNOWN"
                        : `${fixture.integrity.state} / ${fixture.integrity.reasons.join(", ") || "none"}`}
                    </td>
                    <td>{value(fixture.latencyMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

function Target({ run }: { run: WeavraFitnessSummary }) {
  return (
    <div className="min-w-0 space-y-2">
      <p className="break-all font-mono text-xs">
        {run.target.provider} / {run.target.model}
      </p>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{run.kind}</Badge>
        <Badge variant="secondary">{run.status}</Badge>
      </div>
      <Evidence run={run} />
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Exact target identity</summary>
        <dl className="mt-2 space-y-2">
          {Object.entries(run.target).map(([key, text]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd className="break-all font-mono">{text}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

export function WeavraFitness({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const environment = useEnvironment(environmentId);
  const connected = environment?.connection.phase === "connected";
  const invoke = useAtomCommand(command, { reportFailure: false, reportDefect: false });
  const [history, setHistory] = useState<WeavraFitnessHistory | null>(null);
  const [comparison, setComparison] = useState<WeavraFitnessComparison | null>(null);
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    "Read existing records only. No evaluation or model call can be started here.",
  );
  const lifecycle = useRef({ connected: false, active: false });
  const pending = useRef(false);
  useEffect(() => {
    const current = { connected, active: true };
    lifecycle.current = current;
    return () => {
      current.active = false;
    };
  }, [connected]);
  const read = async (input: WeavraFitnessInput) => {
    if (!connected || pending.current) return;
    const current = lifecycle.current;
    pending.current = true;
    setBusy(true);
    try {
      const result = await invoke({ environmentId, input });
      if (!current.active || !current.connected) return;
      if (!AsyncResult.isSuccess(result)) {
        setMessage(
          "Fitness history unavailable or incompatible. No repair, evaluation, or automatic retry was performed.",
        );
        return;
      }
      if (result.value.command === "list") {
        setHistory(result.value.data);
        setComparison(null);
        setLeft("");
        setRight("");
        setMessage(
          `Read ${result.value.data.runs.length} historical records. Runtime status and oracle result are separate.`,
        );
      } else {
        setComparison(result.value.data);
        setMessage("Raw recorded dimensions. No score, winner, or routing recommendation.");
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <SettingsSection id="weavra-fitness" title="Provider fitness · Read-only">
      <SettingsGroup divided={false} className="space-y-5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">Contract evidence, not a leaderboard</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              One provider / model / endpoint / harness per record.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={!connected || busy}
            onClick={() => {
              void read({ projectId, command: "list" });
            }}
          >
            Read history
          </Button>
        </div>
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {!connected
            ? "Disconnected. Displayed records are historical; refresh after reconnecting."
            : message}
        </p>
        {history && (
          <>
            <div className="border-l-2 border-border pl-3 text-xs">
              <p className="font-mono">
                Current corpus: {history.corpusRevision} · {history.fixtures.length} fixtures
              </p>
              <p className="mt-1 break-all font-mono text-muted-foreground">
                {history.corpusDigest}
              </p>
            </div>
            {history.runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Fitness records for this project. Use the opt-in CLI separately to collect
                evidence.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs" aria-label="Provider fitness history">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th scope="col" className="py-2 pr-4">
                          Target / record
                        </th>
                        <th scope="col" className="pr-4">
                          Collection
                        </th>
                        <th scope="col" className="pr-4">
                          Oracle P / F / invalid
                        </th>
                        <th scope="col">False complete</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.runs.map((run) => (
                        <tr key={run.id} className="border-t border-border/40">
                          <th scope="row" className="py-3 pr-4 font-normal">
                            <p className="font-mono">
                              {run.target.provider} / {run.target.model}
                            </p>
                            <p className="mt-1 font-mono text-muted-foreground">{run.id}</p>
                            <p className="mt-1 text-muted-foreground">
                              {new Date(run.startedAt).toLocaleString()} · {run.kind} ·{" "}
                              {run.corpusRevision}
                            </p>
                          </th>
                          <td className="space-y-2 pr-4">
                            <p>{run.status}</p>
                            <Evidence run={run} />
                          </td>
                          <td className="pr-4 font-mono">
                            {run.correctness.oraclePass} / {run.correctness.oracleFail} /{" "}
                            {run.correctness.invalid}
                          </td>
                          <td className="font-mono">{run.correctness.falseCompletion}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap items-end gap-3 border-t border-border/50 pt-4">
                  {(["A", "B"] as const).map((side) => (
                    <label
                      key={side}
                      className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground"
                    >
                      <span>Record {side}</span>
                      <select
                        aria-label={`Fitness record ${side}`}
                        className="block w-full rounded-md border border-input bg-background p-2 text-foreground"
                        value={side === "A" ? left : right}
                        onChange={(event) => {
                          (side === "A" ? setLeft : setRight)(event.target.value);
                          setComparison(null);
                        }}
                      >
                        <option value="">Select a record</option>
                        {history.runs.map((run) => (
                          <option key={run.id} value={run.id}>
                            {run.target.provider}/{run.target.model} · {run.id.slice(0, 8)} ·{" "}
                            {run.kind}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!connected || busy || !left || !right || left === right}
                    onClick={() => {
                      void read({ projectId, command: "compare", left, right });
                    }}
                  >
                    Compare records
                  </Button>
                </div>
              </>
            )}
          </>
        )}
        {comparison && (
          <div className="space-y-4 border-t border-border/50 pt-4">
            <div className="flex flex-wrap gap-2">
              <Badge variant={comparison.comparable ? "outline" : "warning"}>
                {comparison.comparable ? "MATCHED CONDITIONS" : "NOT COMPARABLE"}
              </Badge>
              {Object.entries(comparison.compatibility)
                .filter(([, compatible]) => !compatible)
                .map(([key]) => (
                  <Badge key={key} variant="outline">
                    {key} differs
                  </Badge>
                ))}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Target run={comparison.left} />
              <Target run={comparison.right} />
            </div>
            <table
              className="w-full text-left text-xs"
              aria-label="Raw provider fitness comparison"
            >
              <thead className="text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2">
                    Dimension
                  </th>
                  <th scope="col">A</th>
                  <th scope="col">B</th>
                </tr>
              </thead>
              <tbody>
                {groups.flatMap((group) =>
                  Object.entries(comparison.left[group]).map(([key, number]) => (
                    <tr key={`${group}.${key}`} className="border-t border-border/40">
                      <th scope="row" className="py-2 font-normal">
                        <span className="text-muted-foreground">{group} / </span>
                        {key}
                      </th>
                      <td className="font-mono">{value(number)}</td>
                      <td className="font-mono">
                        {value(
                          Object.entries(comparison.right[group]).find(
                            ([name]) => name === key,
                          )?.[1] ?? null,
                        )}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          UNKNOWN is not zero. Controlled review/repair and faux probes are not natural model error
          rates. Cost, HTTP attempts, and upstream backend identity may be unknown. No prompts,
          reasoning, credentials, or tool transcripts are transported.
        </p>
      </SettingsGroup>
    </SettingsSection>
  );
}
