import { describe, it, expect, vi } from 'vitest';
import {
  otelConfigFromEnv,
  setupOtel,
  startOtel,
  __resetOtelForTests,
  type OtelConfig,
  type InstrumentationFactory,
  type ObserveFn,
} from './otel.ts';

// ── OTel wiring tests (Phase 7 · slice 3) ────────────────────────────────────
// OFFLINE by default: NO real OTLP connection / exporter / NodeSDK is ever
// started here. The env→config parser is pure; the wiring branch is exercised
// with a FAKE `observe` + a FAKE adapter factory so we assert registration
// (or its absence) WITHOUT constructing a real OpenTelemetry instrumentation.

const EMPTY: NodeJS.ProcessEnv = {};

describe('otelConfigFromEnv — env → adapter-option mapping', () => {
  it('defaults to disabled/inert with reference defaults when unset', () => {
    const c = otelConfigFromEnv(EMPTY);
    expect(c).toEqual<OtelConfig>({
      enabled: false,
      serviceName: 'lastlight',
      includeContent: false,
      strict: false,
      forwardToSandbox: true, // reference default ON
      collectorHosts: [],
    });
  });

  it('LASTLIGHT_OTEL_ENABLED gates `enabled` (truthy forms)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(otelConfigFromEnv({ LASTLIGHT_OTEL_ENABLED: v }).enabled).toBe(true);
    }
    for (const v of ['0', 'false', 'no', 'off', '']) {
      expect(otelConfigFromEnv({ LASTLIGHT_OTEL_ENABLED: v }).enabled).toBe(false);
    }
  });

  it('maps SERVICE_NAME (and OTEL_SERVICE_NAME fallback)', () => {
    expect(otelConfigFromEnv({ LASTLIGHT_OTEL_SERVICE_NAME: 'svc-a' }).serviceName).toBe('svc-a');
    // LASTLIGHT_* wins over the generic OTEL_SERVICE_NAME.
    expect(
      otelConfigFromEnv({
        LASTLIGHT_OTEL_SERVICE_NAME: 'svc-a',
        OTEL_SERVICE_NAME: 'svc-b',
      }).serviceName,
    ).toBe('svc-a');
    // Falls back to OTEL_SERVICE_NAME when LASTLIGHT_* absent.
    expect(otelConfigFromEnv({ OTEL_SERVICE_NAME: 'svc-b' }).serviceName).toBe('svc-b');
  });

  it('maps INCLUDE_CONTENT (privacy gate) and STRICT', () => {
    const c = otelConfigFromEnv({
      LASTLIGHT_OTEL_INCLUDE_CONTENT: 'true',
      LASTLIGHT_OTEL_STRICT: '1',
    });
    expect(c.includeContent).toBe(true);
    expect(c.strict).toBe(true);
  });

  it('FORWARD_TO_SANDBOX defaults true, only explicit falsy disables', () => {
    expect(otelConfigFromEnv(EMPTY).forwardToSandbox).toBe(true);
    expect(otelConfigFromEnv({ LASTLIGHT_OTEL_FORWARD_TO_SANDBOX: 'false' }).forwardToSandbox).toBe(false);
    expect(otelConfigFromEnv({ LASTLIGHT_OTEL_FORWARD_TO_SANDBOX: 'off' }).forwardToSandbox).toBe(false);
    expect(otelConfigFromEnv({ LASTLIGHT_OTEL_FORWARD_TO_SANDBOX: 'true' }).forwardToSandbox).toBe(true);
  });

  it('parses COLLECTOR_HOSTS (comma/space separated, deduped, trimmed)', () => {
    expect(
      otelConfigFromEnv({ LASTLIGHT_OTEL_COLLECTOR_HOSTS: 'a.example.com, b.example.com a.example.com' })
        .collectorHosts,
    ).toEqual(['a.example.com', 'b.example.com']);
    expect(otelConfigFromEnv({ LASTLIGHT_OTEL_COLLECTOR_HOSTS: '' }).collectorHosts).toEqual([]);
  });
});

/** A fake adapter factory + observe pair recording calls, no real OTel. */
function fakeWiring() {
  const factoryCalls: Array<{ content?: false | { enabled: boolean } }> = [];
  const subscriber = (_e: unknown, _c: unknown) => {};
  const factory: InstrumentationFactory = (opts) => {
    factoryCalls.push(opts);
    return { observe: subscriber };
  };
  const observed: Array<unknown> = [];
  const unsub = vi.fn();
  const observe: ObserveFn = (s) => {
    observed.push(s);
    return unsub;
  };
  return { factory, observe, factoryCalls, observed, subscriber, unsub };
}

describe('setupOtel — enabled/disabled wiring branch (FAKE observe, no exporter)', () => {
  it('disabled → does NOT construct the adapter nor subscribe (inert)', () => {
    const w = fakeWiring();
    const res = setupOtel(otelConfigFromEnv(EMPTY), {
      observe: w.observe,
      createInstrumentation: w.factory,
    });
    expect(res).toEqual({ registered: false, reason: 'disabled' });
    expect(w.factoryCalls).toHaveLength(0);
    expect(w.observed).toHaveLength(0); // NO real OTLP / subscription started
  });

  it('enabled → constructs the adapter and registers `instr.observe` via observe()', () => {
    const w = fakeWiring();
    const res = setupOtel({ ...otelConfigFromEnv(EMPTY), enabled: true }, {
      observe: w.observe,
      createInstrumentation: w.factory,
    });
    expect(res.registered).toBe(true);
    expect(res.reason).toBe('registered');
    expect(w.factoryCalls).toHaveLength(1);
    // The subscriber registered is exactly the adapter's `.observe`.
    expect(w.observed).toEqual([w.subscriber]);
    expect(typeof res.unsubscribe).toBe('function');
  });

  it('INCLUDE_CONTENT=false → content policy `false` (privacy default; no content in spans)', () => {
    const w = fakeWiring();
    setupOtel({ ...otelConfigFromEnv(EMPTY), enabled: true, includeContent: false }, {
      observe: w.observe,
      createInstrumentation: w.factory,
    });
    expect(w.factoryCalls[0]?.content).toBe(false);
  });

  it('INCLUDE_CONTENT=true → content policy `{ enabled: true }`', () => {
    const w = fakeWiring();
    setupOtel({ ...otelConfigFromEnv(EMPTY), enabled: true, includeContent: true }, {
      observe: w.observe,
      createInstrumentation: w.factory,
    });
    expect(w.factoryCalls[0]?.content).toEqual({ enabled: true });
  });

  it('bad config under NON-strict → warns, does NOT throw, returns reason=error', () => {
    const warn = vi.fn();
    const boom: InstrumentationFactory = () => {
      throw new Error('exporter init blew up');
    };
    const res = setupOtel({ ...otelConfigFromEnv(EMPTY), enabled: true, strict: false }, {
      observe: () => () => {},
      createInstrumentation: boom,
      warn,
    });
    expect(res).toEqual({ registered: false, reason: 'error' });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('exporter init blew up');
  });

  it('bad config under STRICT → throws (fail-hard, reference behaviour)', () => {
    const boom: InstrumentationFactory = () => {
      throw new Error('strict boom');
    };
    expect(() =>
      setupOtel({ ...otelConfigFromEnv(EMPTY), enabled: true, strict: true }, {
        observe: () => () => {},
        createInstrumentation: boom,
      }),
    ).toThrow('strict boom');
  });

  it('does not leak collector hosts into the warning text', () => {
    const warn = vi.fn();
    const boom: InstrumentationFactory = () => {
      throw new Error('plain failure');
    };
    setupOtel(
      {
        ...otelConfigFromEnv(EMPTY),
        enabled: true,
        collectorHosts: ['secret-collector.internal'],
      },
      { observe: () => () => {}, createInstrumentation: boom, warn },
    );
    expect(warn.mock.calls[0]?.[0]).not.toContain('secret-collector.internal');
  });
});

describe('startOtel — boot hook is VITEST-inert + run-once', () => {
  it('is INERT under VITEST even when enabled (never subscribes / exports)', () => {
    __resetOtelForTests();
    // VITEST is set in this process; even with ENABLED the hook must no-op.
    const res = startOtel({ VITEST: 'true', LASTLIGHT_OTEL_ENABLED: 'true' } as NodeJS.ProcessEnv);
    expect(res.registered).toBe(false);
    expect(res.reason).toBe('disabled');
  });

  it('respects LASTLIGHT_SKIP_OTEL even when VITEST is unset', () => {
    __resetOtelForTests();
    const res = startOtel({
      LASTLIGHT_SKIP_OTEL: '1',
      LASTLIGHT_OTEL_ENABLED: 'true',
    } as NodeJS.ProcessEnv);
    expect(res.registered).toBe(false);
  });

  it('run-once: a second call no-ops (guard prevents double-register)', () => {
    __resetOtelForTests();
    expect(startOtel({ LASTLIGHT_SKIP_OTEL: '1' } as NodeJS.ProcessEnv).reason).toBe('disabled');
    // Second call hits the run-once guard regardless of env.
    const second = startOtel({ LASTLIGHT_OTEL_ENABLED: 'true' } as NodeJS.ProcessEnv);
    expect(second.registered).toBe(false);
  });
});
