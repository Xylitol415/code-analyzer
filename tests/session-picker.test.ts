import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { chooseStartupSession, formatSessionHistory } from "../src/session-picker.js";

const history = [
  { id: "recent-id", title: "最近的问题", createdAt: "2026-01-02T12:00:00.000Z", updatedAt: "2026-01-02T12:00:00.000Z", messageCount: 4 },
  { id: "older-id", title: "较早的问题", createdAt: "2026-01-01T12:00:00.000Z", updatedAt: "2026-01-01T12:00:00.000Z", messageCount: 2 },
];

async function pick(answers: Array<string | null>) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += String(chunk);
    if (String(chunk).includes("选择会话")) {
      setImmediate(() => {
        const answer = answers.shift();
        if (answer === null || answer === undefined) input.end();
        else input.write(answer + "\n");
      });
    }
  });
  try {
    const selection = await chooseStartupSession(history, { input, output, interactive: true });
    return { selection, text };
  } finally {
    input.destroy();
    output.destroy();
  }
}

test("startup picker can restore an older history and rejects invalid numeric choices", async () => {
  const result = await pick(["99", "-1", "1oops", "2"]);
  assert.deepEqual(result.selection, { resume: false, historyId: "older-id" });
  assert.match(result.text, /最近的问题/);
  assert.match(result.text, /较早的问题/);
  assert.match(result.text, /请输入/);
});

test("startup picker defaults to fresh, and quit or EOF do not create a session", async () => {
  assert.deepEqual((await pick([""])).selection, { resume: false });
  assert.deepEqual((await pick(["0"])).selection, { resume: false });
  assert.equal((await pick(["q"])).selection, null);
  assert.equal((await pick([null])).selection, null);
});

test("non-TTY startup returns immediately without consuming piped input", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  try {
    input.write("my question\n");
    assert.deepEqual(await chooseStartupSession(history, { input, output, interactive: false }), { resume: false });
    assert.equal(input.read().toString(), "my question\n");
    assert.equal(output.read(), null);
  } finally {
    input.destroy();
    output.destroy();
  }
});

test("history list includes copyable IDs and keeps titles from writing terminal control codes", () => {
  const output = formatSessionHistory([{ ...history[0], title: "unsafe\x1b[2J\nnext", modelLabel: "custom/model" }]);
  assert.match(output, /recent-id/);
  assert.match(output, /4 条消息/);
  assert.match(output, /custom\/model/);
  assert.doesNotMatch(output, /\x1b/);
});
