// The per-user configuration directory: the machine id of published results and the host's noise
// calibration live here, never in a bundle directory.

import { homedir, platform } from "node:os";
import { join } from "node:path";

export function configDir(): string {
  if (process.env.PARALLAX_CONFIG_DIR) return process.env.PARALLAX_CONFIG_DIR;
  if (platform() === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "parallax");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "parallax");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "parallax");
}
