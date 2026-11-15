// A fake type checker for bench tests: spins the CPU for FAKE_CHECK_MS, prints FAKE_CHECK_OUTPUT,
// exits FAKE_CHECK_EXIT. Settings come from test profiles' env.set.

const env = process.env;
const end = performance.now() + Number(env.FAKE_CHECK_MS ?? "50");
let x = 0;
while (performance.now() < end) x += Math.sqrt(x + 1);
if (env.FAKE_CHECK_OUTPUT) process.stdout.write(`${env.FAKE_CHECK_OUTPUT}\n`);
if (env.FAKE_CHECK_CRASH) process.stderr.write("panic: fake checker broke\n");
process.exitCode = Number(env.FAKE_CHECK_EXIT ?? "0") + (x < 0 ? 1 : 0);
