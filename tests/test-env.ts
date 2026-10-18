// Keep the suite and its child CLIs away from the user's real skill store,
// model settings, and conversation history. Inherited by child processes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.CODE_ANALYZER_TEST_DATA_ROOT) {
  const root = mkdtempSync(join(tmpdir(), "code-analyzer-suite-"));
  process.env.CODE_ANALYZER_TEST_DATA_ROOT = root;
  process.env.CODE_ANALYZER_DATA_DIR = join(root, "data");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
}
