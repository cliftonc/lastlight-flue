import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DockerContainer, DockerSandboxApi, docker } from '../src/sandboxes/docker.ts';

// Phase 0 · Spike 2 acceptance — the custom Docker `SandboxFactory` clones + builds
// a repo in an isolated container and tears it down, exercising the real Flue
// `SandboxApi` contract. Free (no model calls), but needs a running Docker daemon,
// so it auto-skips when docker is unavailable (keeps `pnpm test` green in CI).
//
// Egress is DEFERRED this phase: the container has full network (clone reaches
// github.com). The off-allowlist/metadata checks belong to the egress-hardening phase.

const exec = promisify(execFile);

async function dockerAvailable(): Promise<boolean> {
  try {
    await exec('docker', ['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

async function containerExists(id: string): Promise<boolean> {
  try {
    await exec('docker', ['inspect', id]);
    return true;
  } catch {
    return false;
  }
}

// Top-level await (ESM) lets us decide skip synchronously for describe.skipIf.
const DOCKER_OK = await dockerAvailable();

describe.skipIf(!DOCKER_OK)('spike-2 Docker SandboxFactory', () => {
  let container: DockerContainer;
  let api: DockerSandboxApi;

  beforeAll(async () => {
    // Env baked at `docker run` (the Q0.1 path: long-lived run env reaches the sandbox).
    container = await DockerContainer.create({ env: { SPIKE: 'phase-0' } });
    api = new DockerSandboxApi(container);
  }, 180_000);

  afterAll(async () => {
    if (container) await container.remove();
  }, 60_000);

  it('starts an isolated container with an empty workspace and baked env', async () => {
    // Fresh, isolated filesystem — /workspace is empty (not the host).
    expect(await api.readdir('/workspace')).toEqual([]);
    // Debian userland inside the container, distinct from the macOS host.
    const uname = await api.exec('uname -s; cat /etc/os-release | head -1');
    expect(uname.exitCode).toBe(0);
    expect(uname.stdout).toContain('Linux');
    // Baked env is visible to commands.
    const env = await api.exec('echo "$SPIKE"');
    expect(env.stdout.trim()).toBe('phase-0');
  });

  it('clones a repo and runs a build command in the container', async () => {
    // CLONE — proves git + full network egress (deferred hardening).
    const clone = await api.exec(
      'git clone --depth 1 https://github.com/octocat/Hello-World.git repo',
      { timeoutMs: 120_000 },
    );
    expect(clone.exitCode, clone.stderr).toBe(0);
    expect(await api.exists('/workspace/repo/README')).toBe(true);

    // BUILD — an npm build script that produces an artifact, run in the container's
    // toolchain (offline; no install needed). Proves exec + a real build step.
    const build = await api.exec(
      `cd repo && npm init -y >/dev/null 2>&1 \
        && npm pkg set 'scripts.build=node -e "require(\\"fs\\").writeFileSync(\\"out.txt\\",\\"built:\\"+process.version)"' \
        && npm run build >/dev/null 2>&1 \
        && cat out.txt`,
      { timeoutMs: 120_000 },
    );
    expect(build.exitCode, build.stderr).toBe(0);
    expect(build.stdout).toContain('built:v22');

    // Read the build artifact back through the SandboxApi.
    const artifact = await api.readFile('/workspace/repo/out.txt');
    expect(artifact).toContain('built:v22');
  });

  it('implements the SandboxApi filesystem contract', async () => {
    // writeFile / readFile roundtrip (utf-8).
    await api.writeFile('/workspace/hello.txt', 'hello flue');
    expect(await api.readFile('/workspace/hello.txt')).toBe('hello flue');

    // readFileBuffer preserves raw bytes.
    const bytes = new Uint8Array([0, 1, 2, 255, 254]);
    await api.writeFile('/workspace/blob.bin', bytes);
    expect(Array.from(await api.readFileBuffer('/workspace/blob.bin'))).toEqual(Array.from(bytes));

    // stat distinguishes file vs directory and reports size.
    const fstat = await api.stat('/workspace/hello.txt');
    expect(fstat.isFile).toBe(true);
    expect(fstat.isDirectory).toBe(false);
    expect(fstat.size).toBe('hello flue'.length);

    // mkdir recursive + readdir + exists.
    await api.mkdir('/workspace/nested/deep', { recursive: true });
    const dstat = await api.stat('/workspace/nested');
    expect(dstat.isDirectory).toBe(true);
    expect(await api.readdir('/workspace')).toEqual(
      expect.arrayContaining(['hello.txt', 'blob.bin', 'nested']),
    );
    expect(await api.exists('/workspace/nope')).toBe(false);

    // rm recursive removes the tree.
    await api.rm('/workspace/nested', { recursive: true, force: true });
    expect(await api.exists('/workspace/nested')).toBe(false);
  });

  it('wraps into a Flue SessionEnv via the factory', async () => {
    const factory = docker(container);
    const env = await factory.createSessionEnv({ id: 'spike-2' });
    expect(env).toBeTruthy();
    expect(typeof factory.createSessionEnv).toBe('function');
  });

  it('is removed on teardown (caller-owned lifetime)', async () => {
    // Create a throwaway container and prove remove() actually deletes it.
    const throwaway = await DockerContainer.create();
    expect(await containerExists(throwaway.id)).toBe(true);
    await throwaway.remove();
    expect(await containerExists(throwaway.id)).toBe(false);
  }, 180_000);
});
