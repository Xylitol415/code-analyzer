import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli-args.js";

test("custom CLI configuration preserves full model IDs and supports both flag forms", () => {
  for (const argv of [
    ["./repo", "--base-url", "http://localhost:8000/v1", "--model", "org/team/model", "--api-key", "test-key"],
    ["./repo", "--base-url=http://localhost:8000/v1", "--model=org/team/model", "--api-key=test-key"],
  ]) {
    const args = parseArgs(argv);
    assert.deepEqual(args.llm, {
      baseUrl: "http://localhost:8000/v1", model: "org/team/model", apiKey: "test-key",
    });
    assert.equal(args.modelId, undefined);
    assert.equal(args.target, "./repo");
  }
});

test("custom CLI uses environment model and key, while explicit values take precedence", () => {
  const env = { model: "environment/model", apiKey: "env-key", baseUrl: "http://legacy/v1" };
  assert.deepEqual(parseArgs(["./repo", "--base-url", "http://localhost/v1"], env).llm, {
    baseUrl: "http://localhost/v1", model: "environment/model", apiKey: "env-key",
  });
  assert.deepEqual(parseArgs([
    "./repo", "--base-url", "http://localhost/v1", "--model", "local-model", "--api-key=",
  ], env).llm, {
    baseUrl: "http://localhost/v1", model: "local-model", apiKey: "",
  });
});

test("legacy CLI options and environment base URL do not enable custom mode", () => {
  const args = parseArgs(["./repo", "--new", "--no-color", "--no-thinking", "--model=deepseek/model"], {
    model: "environment/model", apiKey: "env-key", baseUrl: "http://legacy/v1",
  });
  assert.equal(args.modelId, "deepseek/model");
  assert.equal(args.llm, undefined);
  assert.equal(args.resume, false);
  assert.equal(args.noColor, true);
  assert.equal(args.noThinking, true);
});

test("custom CLI requires a model and rejects standalone API keys", () => {
  assert.throws(() => parseArgs(["./repo", "--base-url=http://localhost/v1"]), /--model/);
  assert.throws(() => parseArgs(["./repo", "--api-key=test-secret"]), /--base-url/);
});

test("value flags reject missing values without consuming the next option", () => {
  for (const option of ["--model", "--base-url", "--api-key"]) {
    assert.throws(() => parseArgs(["./repo", option]), /需要|缺少/);
    assert.throws(() => parseArgs(["./repo", option, "--new"]), /需要|缺少/);
  }
  assert.throws(() => parseArgs(["./repo", "--model="]), /需要|缺少/);
  assert.throws(() => parseArgs(["./repo", "--base-url=", "--model=local"]), /需要|缺少/);
});

test("invalid options and extra arguments fail without including provided credentials", () => {
  for (const argv of [
    ["./repo", "--unknown=test-secret"],
    ["./repo", "--api-key=test-secret"],
    ["./repo", "extra-secret"],
  ]) {
    assert.throws(() => parseArgs(argv), (error: Error) => {
      assert.doesNotMatch(error.message, /test-secret|extra-secret/);
      return true;
    });
  }
});

test("CLI defaults to a new session and permits selecting any history by ID", () => {
  assert.equal(parseArgs(["./repo"]).resume, false);
  for (const flags of [["--session", "older-session-id"], ["--session=older-session-id"]]) {
    assert.equal(parseArgs(["./repo", ...flags]).historyId, "older-session-id");
  }
  assert.equal(parseArgs(["./repo", "--resume"]).resume, true);
  assert.equal(parseArgs(["./repo", "--new"]).newSession, true);
  assert.equal(parseArgs(["./repo", "--list-sessions"]).listSessions, true);
});

test("CLI rejects conflicting session modes and missing history IDs", () => {
  const choices = [["--new"], ["--resume"], ["--session=history-id"], ["--list-sessions"]];
  for (let a = 0; a < choices.length; a++) {
    for (let b = a + 1; b < choices.length; b++) {
      assert.throws(() => parseArgs(["./repo", ...choices[a], ...choices[b]]), /不能同时|互斥/);
    }
  }
  for (const flags of [["--session"], ["--session="], ["--session", "--new"]]) {
    assert.throws(() => parseArgs(["./repo", ...flags]), /需要|缺少/);
  }
});
