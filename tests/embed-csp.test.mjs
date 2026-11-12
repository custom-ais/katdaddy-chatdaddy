import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const previewOrigin = "https://dryer-vent-squad-az-preview.og-kvtdaddy.chatgpt.site";
const existingOrigins = [
  "'self'",
  "https://dryerventsquadaz.com",
  "https://www.dryerventsquadaz.com",
  "https://444390.us12.myftpupload.com",
];
const policy = (source) => {
  const rule = config.headers.filter((entry) => entry.source === source);
  assert.equal(rule.length, 1, "The route must have exactly one header rule");
  const headers = rule[0].headers.filter((header) => header.key.toLowerCase() === "content-security-policy");
  assert.equal(headers.length, 1, "The rule must set exactly one CSP");
  return headers[0].value;
};
const ancestors = (csp) => {
  const directives = csp.split(";").map((value) => value.trim()).filter((value) => value.startsWith("frame-ancestors "));
  assert.equal(directives.length, 1);
  return directives[0].split(/\s+/).slice(1);
};

test("existing public pages keep their original framing origins", () => {
  assert.deepEqual(ancestors(policy("/(.*)")), existingOrigins);
  assert.equal(policy("/(.*)").includes(previewOrigin), false);
});

test("only the exact chat route adds the authorized preview origin", () => {
  const publicPolicy = policy("/(.*)");
  const chatPolicy = policy("/chat");
  assert.equal(chatPolicy, publicPolicy + " " + previewOrigin);
  assert.deepEqual(ancestors(chatPolicy), [...existingOrigins, previewOrigin]);
  assert.equal(config.headers.filter((rule) =>
    rule.headers.some((header) => header.value.includes(previewOrigin))).length, 1);
  assert.ok(config.headers.findIndex((rule) => rule.source === "/chat") >
    config.headers.findIndex((rule) => rule.source === "/(.*)"));
  const chatRule = config.headers.find((rule) => rule.source === "/chat");
  assert.deepEqual(Object.keys(chatRule).sort(), ["headers", "source"]);
  assert.equal(chatRule.headers.length, 1);
  assert.ok(config.rewrites.some((rule) => rule.source === "/chat" && rule.destination === "/index.html"));
  for (const disallowed of [
    "*",
    "https:",
    "https://*.chatgpt.site",
    "http://dryer-vent-squad-az-preview.og-kvtdaddy.chatgpt.site",
    "https://unrelated.chatgpt.site",
    previewOrigin + ".evil.example",
  ]) assert.equal(ancestors(chatPolicy).includes(disallowed), false);
});

test("admin framing remains denied", () => {
  assert.deepEqual(ancestors(policy("/admin(.*)")), ["'none'"]);
  assert.equal(policy("/admin(.*)").includes(previewOrigin), false);
});
