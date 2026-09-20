import {
  WEAVRA_CONTROL_MAX_REQUEST_BYTES,
  WEAVRA_CONTROL_MAX_RESPONSE_BYTES,
  WeavraControlRequest,
  WeavraControlResponse,
  WeavraControlTransportError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const decodeResponse = Schema.decodeUnknownEffect(WeavraControlResponse, {
  onExcessProperty: "error",
});
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeVersion = Schema.decodeUnknownEffect(Schema.Struct({ protocolVersion: Schema.Finite }));
const isControlError = Schema.is(WeavraControlTransportError);
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(WeavraControlRequest), {
  onExcessProperty: "error",
});

/** The supplied service scope owns this child, never an RPC, browser or observation subscription. */
export const openControlTransport = Effect.fn("weavra.openControlTransport")(function* (
  executable: string,
  cwd: string,
  env: Record<string, string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner
    .spawn(
      ChildProcess.make(executable, ["bridge", "--stdio", "--project-trusted", "--control"], {
        cwd,
        env,
        extendEnv: false,
        stdin: { stream: "pipe", endOnDone: false },
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: Duration.seconds(60),
      }),
    )
    .pipe(Effect.mapError(() => new WeavraControlTransportError({ code: "SPAWN_FAILED" })));
  yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
  const failed = yield* Deferred.make<never, WeavraControlTransportError>();
  const mutex = yield* Semaphore.make(1);
  let pending:
    | {
        id: string;
        command: string;
        line: string;
        result: Deferred.Deferred<WeavraControlResponse>;
      }
    | undefined;
  const buffer = Buffer.allocUnsafe(WEAVRA_CONTROL_MAX_RESPONSE_BYTES);
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
          if (length + bytes >= buffer.length)
            return yield* new WeavraControlTransportError({ code: "OVERSIZED_PAYLOAD" });
          buffer.set(chunk.subarray(offset, stop), length);
          length += bytes;
          if (newline >= 0) {
            const text = yield* Effect.try({
              try: () => utf8.decode(buffer.subarray(0, length)),
              catch: () => new WeavraControlTransportError({ code: "INVALID_PAYLOAD" }),
            });
            const raw = yield* decodeJson(text).pipe(
              Effect.mapError(() => new WeavraControlTransportError({ code: "INVALID_PAYLOAD" })),
            );
            const version = yield* decodeVersion(raw).pipe(
              Effect.mapError(() => new WeavraControlTransportError({ code: "INVALID_PAYLOAD" })),
            );
            if (version.protocolVersion !== 1)
              return yield* new WeavraControlTransportError({ code: "PROTOCOL_MISMATCH" });
            const response = yield* decodeResponse(raw).pipe(
              Effect.mapError(() => new WeavraControlTransportError({ code: "INVALID_PAYLOAD" })),
            );
            length = 0;
            if (!pending || response.id !== pending.id || response.command !== pending.command)
              return yield* new WeavraControlTransportError({ code: "INVALID_PAYLOAD" });
            const result = pending.result;
            pending = undefined;
            yield* Deferred.succeed(result, response);
          }
          offset = stop + 1;
        }
      }),
    ),
    Effect.mapError((error) =>
      isControlError(error) ? error : new WeavraControlTransportError({ code: "TRANSPORT_CLOSED" }),
    ),
    Effect.andThen(Effect.fail(new WeavraControlTransportError({ code: "TRANSPORT_CLOSED" }))),
  );
  yield* reader.pipe(
    Effect.catch((error) => Deferred.fail(failed, error)),
    Effect.forkScoped,
  );
  yield* child.exitCode.pipe(
    Effect.matchEffect({
      onFailure: () =>
        Deferred.fail(failed, new WeavraControlTransportError({ code: "TRANSPORT_CLOSED" })),
      onSuccess: () =>
        Deferred.fail(failed, new WeavraControlTransportError({ code: "TRANSPORT_CLOSED" })),
    }),
    Effect.forkScoped,
  );
  const exchange = Effect.fn("weavra.controlExchange")(function* (request: WeavraControlRequest) {
    const encoded = yield* encodeRequest(request).pipe(
      Effect.mapError(() => new WeavraControlTransportError({ code: "INVALID_PAYLOAD" })),
    );
    const line = `${encoded}\n`;
    if (Buffer.byteLength(line) > WEAVRA_CONTROL_MAX_REQUEST_BYTES)
      return yield* new WeavraControlTransportError({ code: "OVERSIZED_PAYLOAD" });
    return yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        if (pending && (pending.id !== request.id || pending.line !== line))
          return yield* new WeavraControlTransportError({ code: "REQUEST_TIMEOUT" });
        const result = pending?.result ?? (yield* Deferred.make<WeavraControlResponse>());
        if (!pending) {
          pending = { id: request.id, command: request.type, line, result };
          yield* Stream.run(Stream.make(Buffer.from(line)), child.stdin).pipe(
            Effect.mapError(() => new WeavraControlTransportError({ code: "TRANSPORT_CLOSED" })),
          );
        }
        // A timeout does not forget an in-flight command. Its eventual response remains correlated;
        // a matching retry waits on the same receipt rather than writing another mutation.
        return yield* Effect.raceFirst(Deferred.await(result), Deferred.await(failed)).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(10),
            orElse: () => Effect.fail(new WeavraControlTransportError({ code: "REQUEST_TIMEOUT" })),
          }),
        );
      }),
    );
  });
  return { exchange, closed: Deferred.await(failed) };
});
export type ControlTransport = Effect.Success<ReturnType<typeof openControlTransport>>;
