// `parallax suite run`: fetch each suite project and bench it with the suite's settings, so results
// from different machines measure the same thing; optionally publish every bundle.

import { join } from "node:path";
import { fetchProject, loadSuite, selectProjects } from "../suite/suite.ts";
import { bench, type BenchOptions } from "./bench.ts";
import { lspBench, type LspBenchOptions } from "./lspBench.ts";
import { publish } from "./publish.ts";

type Shared = Omit<BenchOptions & LspBenchOptions, "project" | "out" | "config" | "file" | "files" | "log">;

export interface SuiteRunOptions extends Shared {
  ref: string;
  cands: string[];
  // Bundles go to <out>/<project>-<bench|lsp-bench>.
  out: string;
  projects: string[];
  only?: "bench" | "lsp-bench";
  // Publish each bundle into this results collection.
  publishTo?: string;
  log: (msg: string) => void;
}

export interface SuiteRunOutcome {
  project: string;
  kind: "bench" | "lsp-bench";
  dir: string;
  clean: boolean;
  published?: string;
}

export async function suiteRun(opts: SuiteRunOptions): Promise<SuiteRunOutcome[]> {
  const { projects: names, only, publishTo, out, log, ...shared } = opts;
  const outcomes: SuiteRunOutcome[] = [];
  for (const p of selectProjects(loadSuite(), names)) {
    const dir = fetchProject(p, log);
    const done = (kind: SuiteRunOutcome["kind"], bundleDir: string, clean: boolean): void => {
      const o: SuiteRunOutcome = { project: p.name, kind, dir: bundleDir, clean };
      if (publishTo) o.published = publish({ bundleDir, out: publishTo, log }).file;
      outcomes.push(o);
    };
    if (p.bench && only !== "lsp-bench") {
      log(`\n== ${p.name}: bench (${p.bench.config})`);
      const r = await bench({ ...shared, project: dir, config: p.bench.config, out: join(out, `${p.name}-bench`), log });
      done("bench", r.dir, r.summary.clean);
    }
    if (p.lspBench && only !== "bench") {
      log(`\n== ${p.name}: lsp-bench`);
      const r = await lspBench({
        ...shared,
        project: dir,
        ...(p.lspBench.file ? { file: p.lspBench.file } : {}),
        ...(p.lspBench.files !== undefined ? { files: p.lspBench.files } : {}),
        out: join(out, `${p.name}-lsp-bench`),
        log,
      });
      done("lsp-bench", r.dir, r.summary.clean);
    }
  }
  return outcomes;
}
