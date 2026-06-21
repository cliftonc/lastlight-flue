import { spawn } from 'node:child_process';
import {
  createSandboxSessionEnv,
  SandboxOperationUnsupportedError,
  type FileStat,
  type SandboxApi,
  type SandboxFactory,
  type SessionEnv,
} from '@flue/runtime';

// Phase 0 · Spike 2 — custom Docker `SandboxFactory`.
//
// Flue sandboxes are bring-your-own: e2b/daytona/modal are blueprints, not
// packages — only the SandboxFactory → SandboxApi interface is built in. This is
// a first-class Docker adapter: a container per run (workspace mounted, env baked
// at `docker run`), with `exec` + file ops driven through `docker exec`.
//
// ⚠ EGRESS IS DEFERRED this phase: containers run with full network and no SSRF
// floor (known, temporary, recorded — see spec/09, 00 risk #1). Do NOT run
// untrusted input through this until egress is hardened.
//
// Contract notes (spec/flue-reference §0, docs/api/sandbox-api.md, verified against
// installed @flue/runtime 1.0.0-beta.2):
//   - The ADAPTER is a pure mapper: it must NOT create or tear down the container.
//     Lifetime is the caller's — `DockerContainer.create()` / `.remove()` below.
//   - `createSessionEnv({ id })` is called once per `init()`; it wraps the API via
//     `createSandboxSessionEnv(api, baseCwd)` rooted at the provider base cwd.
//   - Docker is a shell-native provider, so filesystem ops are implemented through
//     `docker exec` (allowed for shell-native adapters).

const WORKSPACE = '/workspace';
// node:22-bookworm ships node + npm + git (the slim variant omits git, which the
// clone proof needs). Real build images will layer the project toolchain on top.
const DEFAULT_IMAGE = 'node:22-bookworm';
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;

/** Single-quote a string for safe interpolation into a `sh -c` command. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface DockerRunResult {
  stdout: string;
  stderr: string;
  stdoutBuf: Buffer;
  exitCode: number;
}

/** Run the host `docker` CLI with array args (no host shell → no host injection). */
function runDocker(
  args: string[],
  opts: { input?: Buffer; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<DockerRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, opts.timeoutMs)
        : undefined;

    const onAbort = () => child.kill('SIGKILL');
    if (opts.signal) {
      if (opts.signal.aborted) child.kill('SIGKILL');
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };

    child.stdout.on('data', (d: Buffer) => outChunks.push(d));
    child.stderr.on('data', (d: Buffer) => errChunks.push(d));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdoutBuf = Buffer.concat(outChunks);
      const stderr = Buffer.concat(errChunks).toString('utf8');
      resolve({
        stdout: stdoutBuf.toString('utf8'),
        stderr: timedOut ? `${stderr}\n[docker: killed after ${opts.timeoutMs}ms]` : stderr,
        stdoutBuf,
        exitCode: timedOut ? 124 : (code ?? 1),
      });
    });

    if (opts.input) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export interface DockerContainerOptions {
  /** Container image. Default `node:22-bookworm-slim` (ships node, npm, git). */
  image?: string;
  /** Host directory bind-mounted at `/workspace`. Omit for an internal workspace. */
  workspaceHostDir?: string;
  /** Env baked at `docker run` (per Q0.1: long-lived run env reaches the sandbox here). */
  env?: Record<string, string>;
  /** Optional explicit container name. */
  name?: string;
}

/**
 * Caller-owned container lifetime handle. NOT part of the SandboxApi adapter —
 * the application creates one per run and removes it when the run finishes.
 */
export class DockerContainer {
  private constructor(
    readonly id: string,
    readonly image: string,
  ) {}

  static async create(opts: DockerContainerOptions = {}): Promise<DockerContainer> {
    const image = opts.image ?? DEFAULT_IMAGE;
    const args = ['run', '-d', '--workdir', WORKSPACE];
    if (opts.name) args.push('--name', opts.name);
    if (opts.workspaceHostDir) args.push('-v', `${opts.workspaceHostDir}:${WORKSPACE}`);
    for (const [k, val] of Object.entries(opts.env ?? {})) args.push('-e', `${k}=${val}`);
    // Keep the container alive; the agent/workflow drives work via `docker exec`.
    args.push(image, 'sleep', 'infinity');

    const res = await runDocker(args, { timeoutMs: 120_000 });
    if (res.exitCode !== 0) {
      throw new Error(`docker run failed (${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`);
    }
    const id = res.stdout.trim();
    // Ensure the workspace exists even without a bind mount.
    await runDocker(['exec', id, 'mkdir', '-p', WORKSPACE], { timeoutMs: 30_000 });
    return new DockerContainer(id, image);
  }

  /** Tear the container down. Idempotent. The CALLER invokes this — never the adapter. */
  async remove(): Promise<void> {
    await runDocker(['rm', '-f', this.id], { timeoutMs: 60_000 });
  }
}

/** `SandboxApi` implementation that drives every operation through `docker exec`. */
class DockerSandboxApi implements SandboxApi {
  constructor(private readonly container: DockerContainer) {}

  /** Run a shell command inside the container via `docker exec ... sh -lc`. */
  private async sh(
    command: string,
    opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<DockerRunResult> {
    const args = ['exec'];
    if (opts.cwd) args.push('--workdir', opts.cwd);
    for (const [k, val] of Object.entries(opts.env ?? {})) args.push('-e', `${k}=${val}`);
    args.push(this.container.id, 'sh', '-lc', command);
    return runDocker(args, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      signal: opts.signal,
    });
  }

  async exec(
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const res = await this.sh(command, options);
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
  }

  async readFile(path: string): Promise<string> {
    const res = await this.sh(`cat ${shq(path)}`);
    if (res.exitCode !== 0) throw new Error(`readFile ${path}: ${res.stderr.trim()}`);
    return res.stdout;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const res = await this.sh(`cat ${shq(path)}`);
    if (res.exitCode !== 0) throw new Error(`readFileBuffer ${path}: ${res.stderr.trim()}`);
    return new Uint8Array(res.stdoutBuf);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    // Pipe bytes to `cat > path` via stdin so binary content is preserved.
    const args = ['exec', '-i', this.container.id, 'sh', '-lc', `cat > ${shq(path)}`];
    const res = await runDocker(args, { input: buf, timeoutMs: 60_000 });
    if (res.exitCode !== 0) throw new Error(`writeFile ${path}: ${res.stderr.trim()}`);
  }

  async stat(path: string): Promise<FileStat> {
    // %F = file type, %s = size bytes, %Y = mtime epoch seconds.
    const res = await this.sh(`stat -c '%F|%s|%Y' ${shq(path)}`);
    if (res.exitCode !== 0) throw new Error(`stat ${path}: ${res.stderr.trim()}`);
    const [kind, sizeStr, mtimeStr] = res.stdout.trim().split('|');
    const isDirectory = kind === 'directory';
    const isFile = kind === 'regular file' || kind === 'regular empty file';
    const stat: FileStat = {
      isFile,
      isDirectory,
      isSymbolicLink: kind === 'symbolic link',
    };
    if (sizeStr) stat.size = Number(sizeStr);
    if (mtimeStr) stat.mtime = new Date(Number(mtimeStr) * 1000);
    return stat;
  }

  async readdir(path: string): Promise<string[]> {
    const res = await this.sh(`ls -1A ${shq(path)}`);
    if (res.exitCode !== 0) throw new Error(`readdir ${path}: ${res.stderr.trim()}`);
    return res.stdout.split('\n').filter((line) => line.length > 0);
  }

  async exists(path: string): Promise<boolean> {
    const res = await this.sh(`test -e ${shq(path)}`);
    return res.exitCode === 0;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const flag = options?.recursive ? '-p ' : '';
    const res = await this.sh(`mkdir ${flag}${shq(path)}`);
    if (res.exitCode !== 0) throw new Error(`mkdir ${path}: ${res.stderr.trim()}`);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    // `rm` honors both flags exactly; nothing to reject. (SandboxOperationUnsupportedError
    // is imported for parity with the contract — used if a future op can't be honored.)
    void SandboxOperationUnsupportedError;
    const flags = [options?.recursive ? 'r' : '', options?.force ? 'f' : ''].join('');
    const res = await this.sh(`rm ${flags ? `-${flags} ` : ''}${shq(path)}`);
    if (res.exitCode !== 0) throw new Error(`rm ${path}: ${res.stderr.trim()}`);
  }
}

/**
 * Build a Flue `SandboxFactory` from a caller-created `DockerContainer`.
 * Mirrors the e2b blueprint shape: the caller owns `DockerContainer.create()` /
 * `.remove()`; this factory only adapts it to the SandboxApi contract.
 */
export function docker(container: DockerContainer): SandboxFactory {
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const api = new DockerSandboxApi(container);
      return createSandboxSessionEnv(api, WORKSPACE);
    },
  };
}

/** Exported for direct contract testing (Spike 2 acceptance). */
export { DockerSandboxApi };
