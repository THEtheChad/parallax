// Starting and stopping a command together with the processes it starts (a launcher and its worker).
//
//   POSIX    the command leads its own process group (detached); a kill goes to the whole group
//   Windows  there are no process groups, and `detached` would give the command its own console
//            window, so the command stays attached and hidden; a kill is `taskkill /T`, which follows
//            parent links (a worker whose launcher already exited is out of its reach)

import { spawnSync, type SpawnOptions } from "node:child_process";

const windows = process.platform === "win32";

export const treeSpawnOptions = (): Pick<SpawnOptions, "detached" | "windowsHide"> => ({ detached: !windows, windowsHide: true });

// Kills the process and its descendants. Returns false when there was nothing to kill.
export function killTree(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL"): boolean {
  if (pid === undefined) return false;
  if (windows) {
    const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return r.status === 0;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}
