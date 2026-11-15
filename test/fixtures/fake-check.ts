// A fake type checker for bench tests: spins the CPU for FAKE_CHECK_MS, prints FAKE_CHECK_OUTPUT,
// exits FAKE_CHECK_EXIT. Settings come from test profiles' env.set.
//   FAKE_CHECK_LAUNCHER=1  start a worker that does the work, and exit as soon as it reports done
//                          without waiting for it (like the tsc-rs fork's launcher)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const env = process.env;
const code = Number(env.FAKE_CHECK_EXIT ?? "0");

if (env.FAKE_CHECK_LAUNCHER === "1") {
  const worker = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...env, FAKE_CHECK_LAUNCHER: "worker" },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  worker.on("message", () => process.exit(code));
} else {
  const end = performance.now() + Number(env.FAKE_CHECK_MS ?? "50");
  let x = 0;
  while (performance.now() < end) x += Math.sqrt(x + 1);
  if (env.FAKE_CHECK_OUTPUT) process.stdout.write(`${env.FAKE_CHECK_OUTPUT}\n`);
  if (env.FAKE_CHECK_CRASH) process.stderr.write("panic: fake checker broke\n");
  if (env.FAKE_CHECK_LAUNCHER === "worker") {
    // Report done, then linger: still alive when the launcher exits, as a worker tearing down is.
    process.send!("done");
    process.channel?.unref();
    setTimeout(() => process.exit(0), 150);
  } else process.exitCode = code + (x < 0 ? 1 : 0);
}
