import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGitReadonlyTool, readonlyGitArgs } from "../src/git-tool.js";

const blocked: Array<[string, string[]]> = [
  ["branch", ["new-branch"]], ["branch", ["-D", "main"]], ["branch", ["--delete", "main"]],
  ["tag", ["v2"]], ["tag", ["-d", "v1"]], ["stash", ["pop"]], ["stash", ["push"]],
  ["remote", ["add", "origin", "https://example.com/repo"]], ["remote", ["update"]],
  ["reflog", ["expire", "--all"]], ["reflog", ["delete", "HEAD@{0}"]],
  ["diff", ["--ext-diff"]], ["diff", ["--textconv"]], ["log", ["--output=/tmp/result"]],
  ["cat-file", ["--filters", "HEAD:file"]], ["grep", ["--open-files-in-pager=sh", "pattern"]],
  ["grep", ["-Osh", "pattern"]], ["log", ["--exec=sh"]], ["diff", ["--out=/tmp/result"]],
  ["status", ["-c", "core.fsmonitor=sh"]], ["branch", ["--list", "--edit-description"]],
];
test("Git argument grammar rejects mutations, abbreviated writes, and external command entry points", () => {
  for (const [command, args] of blocked) assert.throws(() => readonlyGitArgs(command, args), undefined, `${command} ${args.join(" ")}`);
});

test("Git queries preserve repository state and disable configured diff helpers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "analyzer-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "Test"]);
  await writeFile(join(directory, "file.txt"), "first\n");
  git(["add", "file.txt"]);
  git(["commit", "-qm", "initial"]);
  const before = git(["show-ref"]);
  await writeFile(join(directory, "file.txt"), "second\n");
  const helper = join(directory, "helper.sh");
  await writeFile(helper, '#!/bin/sh\nprintf unsafe > "' + join(directory, "marker") + '"\n');
  git(["config", "diff.external", `sh ${helper}`]);
  const queries: Array<[string, string[]]> = [
    ["log", ["--oneline", "-5"]], ["show", ["HEAD"]], ["diff", []], ["status", ["--short"]],
    ["branch", []], ["branch", ["--list", "*"]], ["tag", ["--list"]], ["remote", ["-v"]],
    ["stash", ["list"]], ["reflog", ["show", "-2"]], ["cat-file", ["-p", "HEAD"]],
  ];
  for (const [command, args] of queries) {
    const output = git(readonlyGitArgs(command, args));
    assert.equal(typeof output, "string");
  }
  await assert.rejects(readFile(join(directory, "marker")));
  assert.equal(git(["show-ref"]), before);
  const tool = createGitReadonlyTool(directory);
  for (const [command, args] of blocked) {
    const result = await tool.execute("test", { command, args }, undefined, undefined, undefined as never);
    assert.match(result.content[0].text, /错误/);
  }
  assert.equal(git(["show-ref"]), before);
});

test("configured clean/process filters and signature formatters cannot execute helpers during queries", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "analyzer-git-helpers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (args: string[], options = {}) => execFileSync("git", args, { cwd: directory, encoding: "utf8", ...options });
  git(["init", "-q"]); git(["config", "user.email", "test@example.invalid"]); git(["config", "user.name", "Test"]);
  await writeFile(join(directory, ".gitattributes"), "*.txt filter=probe\n");
  await writeFile(join(directory, "file.txt"), "first\n");
  git(["add", ".gitattributes", "file.txt"]); git(["commit", "-qm", "initial"]);
  const marker = join(directory, "marker");
  const script = join(directory, "filter.sh");
  await writeFile(script, `#!/bin/sh\nprintf unsafe > "${marker}"\ncat\n`);
  await chmod(script, 0o700);
  await writeFile(join(directory, "file.txt"), "second\n");
  git(["config", "filter.probe.clean", `sh ${script}`]);
  git(["config", "filter.probe.process", `sh ${script}`]);
  git(["config", "filter.probe.required", "true"]);
  const tree = git(["rev-parse", "HEAD^{tree}"]).trim();
  const signed = `tree ${tree}\nauthor Test <test@example.invalid> 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\nfixture\n`;
  const hash = git(["hash-object", "-t", "commit", "-w", "--stdin"], { input: signed }).trim();
  git(["config", "gpg.program", script]);
  git(["config", "log.showSignature", "true"]);
  git(["config", "format.pretty", "%G?"]);
  git(["config", "pretty.medium", "%G?"]);
  git(["config", "pretty.signed", "%G?"]);
  const tool = createGitReadonlyTool(directory);
  for (const [command, args] of [["diff", []], ["blame", ["file.txt"]], ["log", ["-1", hash]]] as Array<[string, string[]]>) {
    const result = await tool.execute("test", { command, args }, undefined, undefined, undefined as never);
    assert.doesNotMatch(result.content[0].text, /^错误/);
    await assert.rejects(readFile(marker), `${command} must not execute configured helpers`);
  }
  for (const command of ["log", "show", "branch", "tag", "for-each-ref"]) {
    for (const format of ["--format=%G?", "--format=%+G?", "--format=%-G?", "--format=% G?", "--format=%(signature:signer)", "--format=%(*signature:grade)"]) {
      assert.throws(() => readonlyGitArgs(command, [format]));
    }
  }
  for (const alias of ["--format=signed", "--pretty=signed", "--pretty=medium"]) assert.throws(() => readonlyGitArgs("log", [alias]));
  for (const sort of ["--sort=signature:signer", "--sort=-signature:grade", "--sort=*signature:trustlevel"]) assert.throws(() => readonlyGitArgs("for-each-ref", [sort]));
});
