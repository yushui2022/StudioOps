import assert from "node:assert/strict";
import test from "node:test";
import { normalizePublicKey } from "../services/agent/src/core/warpgate-keys.js";

const ED25519 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB7exampleKeyMaterial friend@laptop";

test("normalizePublicKey keeps a single-line key and its comment", () => {
  const result = normalizePublicKey(`  ${ED25519}  `);
  assert.equal(result.publicKey, ED25519);
  assert.equal(result.defaultLabel, "friend@laptop");
});

test("normalizePublicKey accepts ssh-rsa keys", () => {
  const result = normalizePublicKey(
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7example ci@runner",
  );
  assert.match(result.publicKey, /^ssh-rsa /);
  assert.equal(result.defaultLabel, "ci@runner");
});

test("normalizePublicKey rejects private key material", () => {
  assert.throws(
    () =>
      normalizePublicKey(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
      ),
    /私钥/,
  );
});

test("normalizePublicKey rejects unsupported key types", () => {
  assert.throws(
    () => normalizePublicKey("not-a-key AAAA test"),
    /公钥格式不正确/,
  );
});

test("normalizePublicKey rejects multi-line input", () => {
  assert.throws(() => normalizePublicKey(`${ED25519}\n${ED25519}`), /单行/);
});
