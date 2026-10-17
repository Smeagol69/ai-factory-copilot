import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { runtimeContext } from './project.mjs';

// Reuse the pinned servers; stdout belongs exclusively to the MCP protocol.
export async function launchServer(entry, args = []) {
  const context = await runtimeContext();
  const child = spawn(process.execPath, [resolve(context.runtime, entry), ...args], {
    cwd: context.root, env: context.subscriptionEnvironment(), stdio: 'inherit', windowsHide: true,
  });
  const stop = signal => child.kill(signal);
  const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    await new Promise((done, fail) => { child.once('error', fail); child.once('exit', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0); done();
    }); });
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  }
}
