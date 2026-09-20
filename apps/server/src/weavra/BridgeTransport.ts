import {
  WEAVRA_MAX_REQUEST_BYTES,
  WEAVRA_MAX_RESPONSE_BYTES,
  WEAVRA_READ_COMMANDS,
  WeavraErrorCode,
  WeavraHostRequest,
  WeavraHostResponse,
  type WeavraObservation,
  type WeavraSnapshotEnvelope,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class BridgeFailure extends Schema.TaggedError<BridgeFailure>()("WeavraBridgeFailure", {
  code: WeavraErrorCode,
}) {}

const decodeResponse = Schema.decodeUnknownEffect(WeavraHostResponse, {
  onExcessProperty: "error",
});
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeVersion = Schema.decodeUnknownEffect(Schema.Struct({ protocolVersion: Schema.Finite }));
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(WeavraHostRequest));
const isBridgeFailure = Schema.is(BridgeFailure);

/** Runs one owned observer child. Scope closure never targets a Runtime owner or its worker. */
export const observeBridge = Effect.fn("weavra.observeBridge")(function* (
  executable: string,
  cwd: string,
  env: Record<string, string>,
  previous: WeavraSnapshotEnvelope | null,
  publish: (update: Partial<WeavraObservation>) => Effect.Effect<void>,
  validateProject: Effect.Effect<void, BridgeFailure> = Effect.void,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner
    .spawn(
      ChildProcess.make(executable, ["bridge", "--stdio", "--project-trusted"], {
        cwd,
        env,
        extendEnv: false,
        stdin: { stream: "pipe", endOnDone: false },
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: Duration.seconds(2),
      }),
    )
    .pipe(Effect.mapError(() => new BridgeFailure({ code: "SPAWN_FAILED" })));
  // Drain without accumulating, tracing, or forwarding arbitrary private diagnostics.
  yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
  let pending:
    | { id: string; command: "hello" | "snapshot"; result: Deferred.Deferred<WeavraHostResponse> }
    | undefined;
  let sequence = 0;
  let canonical = previous;
  const request = Effect.fn("weavra.request")(function* (command: "hello" | "snapshot") {
    const id = `t3-${++sequence}`;
    const result = yield* Deferred.make<WeavraHostResponse>();
    const encoded = yield* encodeRequest({
      protocolVersion: 1,
      id,
      type: command,
      ...(command === "hello"
        ? { clientName: "t3code", capabilities: ["snapshots-only"] as const }
        : {}),
    }).pipe(Effect.mapError(() => new BridgeFailure({ code: "INVALID_PAYLOAD" })));
    const line = `${encoded}\n`;
    if (Buffer.byteLength(line) > WEAVRA_MAX_REQUEST_BYTES)
      return yield* new BridgeFailure({ code: "OVERSIZED_PAYLOAD" });
    pending = { id, command, result };
    return yield* Stream.run(Stream.make(Buffer.from(line)), child.stdin).pipe(
      Effect.mapError(() => new BridgeFailure({ code: "TRANSPORT_CLOSED" })),
      Effect.andThen(Deferred.await(result)),
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () => Effect.fail(new BridgeFailure({ code: "REQUEST_TIMEOUT" })),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          pending = undefined;
        }),
      ),
    );
  });
  const buffer = Buffer.allocUnsafe(WEAVRA_MAX_RESPONSE_BYTES);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let length = 0;
  const reader = child.stdout.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset);
          const stop = newline < 0 ? chunk.length : newline;
          const bytes = stop - offset;
          // Protocol's limit includes LF, and an unfinished line cannot grow unbounded.
          if (length + bytes >= buffer.length)
            return yield* new BridgeFailure({ code: "OVERSIZED_PAYLOAD" });
          buffer.set(chunk.subarray(offset, stop), length);
          length += bytes;
          if (newline >= 0) {
            const text = yield* Effect.try({
              try: () => utf8.decode(buffer.subarray(0, length)),
              catch: () => new BridgeFailure({ code: "INVALID_PAYLOAD" }),
            });
            const raw = yield* decodeJson(text).pipe(
              Effect.mapError(() => new BridgeFailure({ code: "INVALID_PAYLOAD" })),
            );
            const version = yield* decodeVersion(raw).pipe(
              Effect.mapError(() => new BridgeFailure({ code: "INVALID_PAYLOAD" })),
            );
            if (version.protocolVersion !== 1)
              return yield* new BridgeFailure({ code: "PROTOCOL_MISMATCH" });
            const response = yield* decodeResponse(raw).pipe(
              Effect.mapError(() => new BridgeFailure({ code: "INVALID_PAYLOAD" })),
            );
            length = 0;
            if (!pending || response.id !== pending.id || response.command !== pending.command)
              return yield* new BridgeFailure({ code: "INVALID_PAYLOAD" });
            const result = pending.result;
            pending = undefined;
            yield* Deferred.succeed(result, response);
          }
          offset = stop + 1;
        }
      }),
    ),
    Effect.mapError((error) =>
      isBridgeFailure(error) ? error : new BridgeFailure({ code: "TRANSPORT_CLOSED" }),
    ),
    Effect.andThen(Effect.fail(new BridgeFailure({ code: "TRANSPORT_CLOSED" }))),
  );
  const loop = Effect.gen(function* () {
    const hello = yield* request("hello");
    if (!hello.success)
      return yield* new BridgeFailure({
        code:
          hello.error.code === "UNSUPPORTED_VERSION"
            ? "PROTOCOL_MISMATCH"
            : "INCOMPATIBLE_CAPABILITIES",
      });
    if (
      hello.command !== "hello" ||
      hello.data.transport !== "stdio" ||
      hello.data.observationMode !== "snapshots-only" ||
      hello.data.commands.length !== WEAVRA_READ_COMMANDS.length ||
      WEAVRA_READ_COMMANDS.some((command) => !hello.data.commands.includes(command))
    )
      return yield* new BridgeFailure({ code: "INCOMPATIBLE_CAPABILITIES" });
    yield* publish({
      runtimeVersion: hello.data.runtimeVersion,
      status: hello.data.readiness,
      stale: true,
      errorCode: null,
    });
    if (hello.data.readiness !== "READY") return;
    while (true) {
      yield* validateProject;
      const response = yield* request("snapshot");
      yield* validateProject;
      if (!response.success) return yield* new BridgeFailure({ code: "STATE_UNAVAILABLE" });
      if (response.command !== "snapshot")
        return yield* new BridgeFailure({ code: "INVALID_PAYLOAD" });
      const { protocolVersion, runId, stateRevision, projectRevision, eventId, timestamp, data } =
        response;
      const run = data.status.run;
      if (
        runId !== (run?.runId ?? null) ||
        (data.graph !== null &&
          (data.graph.runId !== runId ||
            data.graph.stateRevision !== stateRevision ||
            data.graph.status !== run?.status)) ||
        (data.evidence !== null &&
          (data.evidence.runId !== runId ||
            data.evidence.status !== run?.status ||
            data.evidence.codeRevision !== run?.codeRevision)) ||
        data.graphAvailable !== (data.graph !== null) ||
        data.status.state === "unavailable"
      )
        return yield* new BridgeFailure({ code: "INVALID_PAYLOAD" });
      if (
        canonical &&
        ((canonical.projectRevision !== null &&
          (projectRevision === null || projectRevision < canonical.projectRevision)) ||
          (canonical.runId === runId &&
            canonical.stateRevision !== null &&
            (stateRevision === null || stateRevision < canonical.stateRevision)))
      )
        return yield* new BridgeFailure({ code: "REVISION_REGRESSION" });
      canonical = {
        protocolVersion,
        runId,
        stateRevision,
        projectRevision,
        eventId,
        timestamp,
        data,
      };
      yield* publish({
        status: "CONNECTED",
        snapshot: canonical,
        stale: false,
        observedAt: yield* Clock.currentTimeMillis,
        errorCode: null,
      });
      yield* Effect.sleep(Duration.seconds(2));
    }
  });
  yield* Effect.raceFirst(
    Effect.raceFirst(loop, reader),
    child.exitCode.pipe(
      Effect.mapError(() => new BridgeFailure({ code: "TRANSPORT_CLOSED" })),
      Effect.andThen(Effect.fail(new BridgeFailure({ code: "TRANSPORT_CLOSED" }))),
    ),
  );
});
