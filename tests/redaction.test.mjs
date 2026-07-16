import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  collectConfigSecrets,
  redactText,
  truncateOutput,
  buildStructuredError,
} from "../plugins/gateway/scripts/lib/redaction.mjs";

describe("redactText", () => {
  it("redacts Bearer tokens (preserves prior sanitizeError behavior)", () => {
    const out = redactText("Authorization: Bearer sk-abc123XYZ failed");
    assert.ok(!out.includes("sk-abc123XYZ"), "token must be gone");
    assert.match(out, /Bearer \[REDACTED\]/);
  });

  it("redacts a literal profile secret containing regex metacharacters", () => {
    const secret = "sk-abc$123.(x)+[y]"; // regex-special chars must be escaped
    const out = redactText(`connect failed with key ${secret} at endpoint`, [secret]);
    assert.ok(!out.includes(secret), "literal secret must be scrubbed verbatim");
    assert.match(out, /\[REDACTED\]/);
  });

  it("masks credentials embedded in a URL", () => {
    const out = redactText("dialing http://user:pass@host.example/path now");
    assert.ok(!out.includes("user:pass"), "userinfo must be masked");
    assert.match(out, /http:\/\/\[REDACTED\]@host\.example/);
  });

  it("redacts URL query strings (no secret needed to know the shape)", () => {
    const out = redactText("GET https://host/v1/chat?api_key=xyz&t=1");
    assert.ok(!out.includes("api_key=xyz"), "query must be redacted");
    assert.match(out, /https:\/\/host\/v1\/chat\?\[REDACTED\]/);
  });

  it("does not mangle a plain email address (no scheme:// prefix)", () => {
    const out = redactText("contact ops@example.com for access");
    assert.equal(out, "contact ops@example.com for access");
  });
});

describe("truncateOutput", () => {
  it("bounds 200 lines to 50 with an omitted-lines marker", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
    const out = truncateOutput(text);
    const lines = out.split("\n");
    assert.equal(lines.length, 51, "50 kept lines + 1 marker line");
    assert.equal(lines[49], "line 50");
    assert.equal(lines[50], "[... 150 lines omitted]");
  });

  it("leaves short text untouched", () => {
    assert.equal(truncateOutput("a\nb\nc"), "a\nb\nc");
  });
});

describe("collectConfigSecrets", () => {
  it("collects non-empty apiKey/authToken across profiles, ignoring empties", () => {
    const config = {
      profiles: {
        a: { apiKey: "key-a", authToken: "" },
        b: { authToken: "tok-b" },
        c: { apiKey: "", authToken: null },
      },
    };
    const secrets = collectConfigSecrets(config).sort();
    assert.deepEqual(secrets, ["key-a", "tok-b"]);
  });

  it("returns [] for missing/empty config", () => {
    assert.deepEqual(collectConfigSecrets(undefined), []);
    assert.deepEqual(collectConfigSecrets({}), []);
  });
});

describe("buildStructuredError", () => {
  let logDir;

  before(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-redaction-test-"));
  });

  after(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it("writes a 0600 log, redacts userMessage/operatorDetail, keeps full detail on disk", () => {
    const secret = "sk-super-secret-key";
    const result = buildStructuredError(
      {
        message: `Task failed while using ${secret}`,
        stderr: `boom at http://user:pass@gw/v1?api_key=${secret}\nextra line`,
        exitCode: 2,
        context: "task-worker",
      },
      { secrets: [secret], logDir }
    );

    // localLogPath exists with mode 0600
    assert.ok(result.localLogPath, "expected a log path");
    const mode = fs.statSync(result.localLogPath).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);

    // userMessage: short, first line, exit code, no secret
    assert.ok(!result.userMessage.includes(secret), "userMessage must not leak the secret");
    assert.match(result.userMessage, /\(exit 2\)/);
    assert.ok(!result.userMessage.includes("\n"), "userMessage must be a single line");

    // operatorDetail: redacted (no secret, no raw credentials)
    assert.ok(!result.operatorDetail.includes(secret), "operatorDetail must not leak the secret");
    assert.ok(!result.operatorDetail.includes("user:pass"), "operatorDetail must mask URL creds");

    // The log on disk IS the diagnostic channel — it MUST retain full detail.
    const logContents = fs.readFileSync(result.localLogPath, "utf8");
    assert.ok(logContents.includes(secret), "log must contain the full unredacted secret");
    assert.ok(logContents.includes("user:pass@gw"), "log must contain the full unredacted URL");
  });

  it("operatorDetail is both redacted AND line-bounded for a >50-line stderr", () => {
    const secret = "sk-buried-in-stderr";
    // Secret on line 1 (survives truncation) proves redaction; 200 lines proves bounding.
    const stderr = [`leak ${secret}`, ...Array.from({ length: 199 }, (_, i) => `noise ${i}`)].join("\n");
    const result = buildStructuredError(
      { message: "task blew up", stderr },
      { secrets: [secret], logDir }
    );

    assert.ok(!result.operatorDetail.includes(secret), "operatorDetail must be redacted");
    assert.match(result.operatorDetail, /\[\.\.\. \d+ lines omitted\]/, "operatorDetail must be line-bounded");
    // message line + 50 kept stderr lines + marker = 52 lines
    assert.equal(result.operatorDetail.split("\n").length, 52);
  });

  it("returns localLogPath: null (never throws) when the log write fails", () => {
    // A path whose parent is a regular file can never be mkdir'd — ENOTDIR even
    // as root, so this is robust regardless of the test runner's uid.
    const blocker = path.join(logDir, "not-a-dir");
    fs.writeFileSync(blocker, "x");
    const unwritable = path.join(blocker, "sub");

    let result;
    assert.doesNotThrow(() => {
      result = buildStructuredError(
        { message: "will fail to log", stderr: "detail" },
        { logDir: unwritable }
      );
    });
    assert.equal(result.localLogPath, null);
    // The user/operator channels still work even when the log can't be written.
    assert.match(result.userMessage, /will fail to log/);
  });
});
