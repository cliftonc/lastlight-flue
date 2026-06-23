import { observe } from '@flue/runtime';
import { createOpenTelemetryInstrumentation } from '@flue/opentelemetry';

// ── Last Light on Flue · OpenTelemetry observability wiring (Phase 7 · slice 3)
//
// Wires `@flue/opentelemetry` (the OTel tracing adapter) onto Flue's built-in
// `observe(...)` live-event stream, fed by the ported `LASTLIGHT_OTEL_*` env
// (mirrors ~/work/lastlight/src/{config,telemetry}.ts → `OtelConfig`). Registers
// ONLY when LASTLIGHT_OTEL_ENABLED is truthy; otherwise COMPLETELY INERT — no
// adapter constructed, no `observe` subscription, no exporter, no error.
//
// ── VERIFIED API (installed packages, 2026-06-23 — flue-reference §0/§10) ─────
// `@flue/opentelemetry@1.0.0-beta.3` exports `createOpenTelemetryInstrumentation(
//   { tracer?, meter?, logger?, content?: false | GenAIContentPolicy,
//     resolveRootContext?, diagnostic? }
// )` → `{ key, observe, interceptor, dispose }`. Its `.observe` is a
// `(event, ctx) => void` subscriber.
//
// `@flue/runtime@1.0.0-beta.2` exports `observe(subscriber): () => void` — adds a
// plain `(event, ctx) => void` subscriber to the live-event Set; returns an
// unsubscribe fn. So registration is `observe(instr.observe)` and the adapter
// emits spans for run / operation / model-turn / tool / task / compaction events.
//
// ⚠ BETA DRIFT (recorded, non-blocking — see flue-reference §10):
//  • The bundled beta.2 docs describe `createOpenTelemetryObserver()` + an
//    `exportContent(event)` callback; the INSTALLED beta.3 package instead
//    exports `createOpenTelemetryInstrumentation()` with a `content` policy and a
//    richer `{ observe, interceptor, key, dispose }` shape. We wire the INSTALLED
//    surface (`createOpenTelemetryInstrumentation` + `content`).
//  • beta.3 also exposes an `interceptor` (cross-execution trace-context
//    propagation) that beta.2's `observe()` registry has NO hook for. We register
//    `instr.observe` only; core span emission works, but distributed
//    trace-context parenting across executions is reduced under this pin. The
//    `dispose`/unsubscribe is returned for symmetry (tests + shutdown).
//
// SDK/EXPORTER: the adapter does NOT configure an OpenTelemetry SDK or OTLP
// exporter (its docs are explicit). Span DELIVERY requires an operator-provided
// NodeSDK + OTLP exporter initialized at deploy via the standard
// `OTEL_EXPORTER_OTLP_*` env. We deliberately do NOT start a NodeSDK here (no
// live export in tests; no exporter dependency pulled in) — this slice wires the
// adapter→`observe` registration and the env→option mapping only.

/**
 * Resolved OTel config — the env→adapter-option mapping. Mirrors the reference
 * `OtelConfig` (~/work/lastlight/src/config.ts) faithfully; only `enabled`,
 * `serviceName`, `includeContent`, `strict`, and `collectorHosts` have an
 * analogue in the adapter / SDK path (see `forwardToSandbox` note below).
 */
export interface OtelConfig {
  /** LASTLIGHT_OTEL_ENABLED — the master gate. When false, wiring is inert. */
  enabled: boolean;
  /** LASTLIGHT_OTEL_SERVICE_NAME — OTLP `service.name` resource attr (default `lastlight`). */
  serviceName: string;
  /** LASTLIGHT_OTEL_INCLUDE_CONTENT — privacy gate: include prompt/response
   *  content (`GenAIContentPolicy.enabled`) in spans. Default false. */
  includeContent: boolean;
  /** LASTLIGHT_OTEL_STRICT — fail-hard on a misconfig/init error instead of warn. */
  strict: boolean;
  /** LASTLIGHT_OTEL_FORWARD_TO_SANDBOX — reference-only sandbox OTEL forwarding;
   *  no adapter analogue (the adapter traces the host process). Carried for
   *  parity + the sandbox-env forwarder, NOT passed to the adapter. */
  forwardToSandbox: boolean;
  /** LASTLIGHT_OTEL_COLLECTOR_HOSTS — collector hostnames (for the egress
   *  allowlist / sandbox routing). The real OTLP ENDPOINT is supplied to the
   *  SDK via the standard `OTEL_EXPORTER_OTLP_*` env, NOT this list — so this is
   *  carried for parity + egress, not mapped to an adapter option. */
  collectorHosts: string[];
}

/** Truthy-env parse matching the reference (`true`/`1`/`yes`/`on`, case-insensitive). */
function envTruthy(raw: string | undefined): boolean {
  if (!raw) return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/** Split a comma/whitespace-separated host list, trimming + dropping empties. */
function parseHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const h = part.trim();
    if (h) out.push(h);
  }
  return Array.from(new Set(out));
}

/**
 * Build the resolved {@link OtelConfig} from `LASTLIGHT_OTEL_*` env. Pure (env
 * injectable) so the mapping is unit-testable without touching `process.env`.
 * Defaults match the reference: disabled, `serviceName=lastlight`,
 * content/strict off, forwardToSandbox ON (reference default), no collectors.
 * `OTEL_SERVICE_NAME` is honored as a fallback for the service name.
 */
export function otelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OtelConfig {
  const serviceName =
    env.LASTLIGHT_OTEL_SERVICE_NAME?.trim() ||
    env.OTEL_SERVICE_NAME?.trim() ||
    'lastlight';
  // forwardToSandbox defaults TRUE (reference): only an explicit falsy disables.
  const forwardRaw = env.LASTLIGHT_OTEL_FORWARD_TO_SANDBOX?.trim();
  const forwardToSandbox =
    forwardRaw === undefined || forwardRaw === ''
      ? true
      : !/^(0|false|no|off)$/i.test(forwardRaw);
  return {
    enabled: envTruthy(env.LASTLIGHT_OTEL_ENABLED),
    serviceName,
    includeContent: envTruthy(env.LASTLIGHT_OTEL_INCLUDE_CONTENT),
    strict: envTruthy(env.LASTLIGHT_OTEL_STRICT),
    forwardToSandbox,
    collectorHosts: parseHosts(env.LASTLIGHT_OTEL_COLLECTOR_HOSTS),
  };
}

/** The shape of `@flue/runtime`'s `observe` — injectable so the wiring branch is
 *  unit-testable with a fake (the real one mutates a process-global Set). */
export type ObserveFn = (subscriber: (event: unknown, ctx: unknown) => void) => () => void;

/** The shape of the adapter factory — injectable so tests assert it is (not)
 *  invoked WITHOUT constructing a real OTel instrumentation. Returns an object
 *  whose `.observe` is the subscriber passed to {@link ObserveFn}. */
export type InstrumentationFactory = (options: {
  content?: false | { enabled: boolean };
}) => { observe: (event: unknown, ctx: unknown) => void };

/** Dependencies of {@link setupOtel} — injected so the wiring is testable
 *  offline with a FAKE `observe` + factory (no real exporter, no real Set). */
export interface OtelDeps {
  observe?: ObserveFn;
  createInstrumentation?: InstrumentationFactory;
  /** Warning sink — defaults to `console.warn`. Injected so tests assert on it. */
  warn?: (msg: string) => void;
}

/** Outcome of {@link setupOtel} — `registered` true only when an adapter was
 *  actually subscribed. `unsubscribe` tears it down (shutdown / tests). */
export interface OtelSetupResult {
  registered: boolean;
  reason: 'disabled' | 'registered' | 'error';
  unsubscribe?: () => void;
}

/**
 * Register the `@flue/opentelemetry` adapter onto Flue's `observe(...)` stream
 * IF (and only if) `config.enabled`. Pure of side effects when disabled. On a
 * construction/registration error: NON-FATAL — warns and returns
 * `{ registered:false, reason:'error' }`, UNLESS `config.strict` (then it
 * rethrows, fail-hard, matching the reference's strict mode).
 *
 * INCLUDE_CONTENT → the adapter's `content` policy: `{ enabled: true }` opts
 * prompt/response content into spans; otherwise `content: false` (the privacy
 * default — identifiers/durations/usage only, no content).
 */
export function setupOtel(
  config: OtelConfig,
  deps: OtelDeps = {},
): OtelSetupResult {
  if (!config.enabled) return { registered: false, reason: 'disabled' };
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const observeFn = deps.observe ?? (observe as unknown as ObserveFn);
  const factory =
    deps.createInstrumentation ??
    (createOpenTelemetryInstrumentation as unknown as InstrumentationFactory);
  try {
    // INCLUDE_CONTENT privacy gate → the adapter content policy.
    const content: false | { enabled: boolean } = config.includeContent
      ? { enabled: true }
      : false;
    const instrumentation = factory({ content });
    const unsubscribe = observeFn(instrumentation.observe);
    return { registered: true, reason: 'registered', unsubscribe };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (config.strict) throw err;
    // Non-fatal: a bad OTel config must NEVER crash the server. (No headers/
    // tokens are interpolated here — only the error message.)
    warn(`[otel] adapter registration failed; continuing without telemetry: ${msg}`);
    return { registered: false, reason: 'error' };
  }
}

let otelStarted = false;

/**
 * Boot-time entry, wired in `src/app.ts` module scope alongside the boot-recovery
 * + cron hooks. RUN-ONCE (module-level guard so a re-import can't double-register),
 * NON-FATAL (a bad config logs a warning, never throws past strict-off), and
 * SKIPPED under VITEST / `LASTLIGHT_SKIP_OTEL` so tests/imports NEVER start an
 * exporter or subscribe to the live stream. Returns the setup result (or a
 * `disabled` sentinel when skipped) for symmetry; callers ignore it.
 */
export function startOtel(env: NodeJS.ProcessEnv = process.env): OtelSetupResult {
  if (otelStarted) return { registered: false, reason: 'disabled' };
  otelStarted = true;
  // Inert under tests / explicit skip: never subscribe or export in-process.
  if (env.VITEST || env.LASTLIGHT_SKIP_OTEL === '1') {
    return { registered: false, reason: 'disabled' };
  }
  const config = otelConfigFromEnv(env);
  try {
    return setupOtel(config);
  } catch (err) {
    // Strict-mode rethrow from setupOtel still must not crash the server boot:
    // the boot hook is non-fatal by contract (like boot-recovery). Log + skip.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[otel] strict init failed (non-fatal at boot): ${msg}`);
    return { registered: false, reason: 'error' };
  }
}

/** Test-only: reset the run-once guard so a test can re-exercise `startOtel`. */
export function __resetOtelForTests(): void {
  otelStarted = false;
}
