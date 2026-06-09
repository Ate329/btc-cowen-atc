#!/usr/bin/env node

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const files = execSync("git ls-files", { encoding: "utf8" })
  .split(/\r?\n/)
  .map((file) => file.trim())
  .filter(Boolean);

const suspiciousFilePatterns = [
  /\.(pem|p12|pfx|jks|keystore|cer|crt|csr|pvk|key|asc|gpg|id_rsa|id_dsa)$/i,
];

const patterns = [
  {
    name: "Potential key / token assignment",
    regex:
      /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|private[_-]?key|refresh[_-]?token|auth(?:entication)?[_-]?token|authorization|password|passwd|bearer)\s*[:=]\s*["'`][^"'`]{8,}["'`]/gi,
  },
  { name: "AWS access key ID", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "AWS session token marker", regex: /\bASIA[0-9A-Z]{16}\b/g },
  {
    name: "GitHub token",
    regex: /\bgh[pousr]_[A-Za-z0-9_]{20,100}\b/g,
  },
  {
    name: "Stripe key",
    regex: /\b(?:sk|pk)_(?:live|test)_[0-9a-zA-Z]{20,}\b/g,
  },
  { name: "OpenAI legacy key", regex: /\bsk-[a-zA-Z0-9]{20,100}\b/g },
  { name: "Google Maps/API key shape", regex: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { name: "JWT", regex: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g },
  {
    name: "Generic base64-like private key line",
    regex: /-----BEGIN [A-Z ]+PRIVATE KEY-----/g,
  },
];

const isTextFile = (filePath) => {
  try {
    const chunk = readFileSync(filePath).subarray(0, 1024);
    return !chunk.includes(0);
  } catch (error) {
    return true;
  }
};

const normalizeFileName = (file) => basename(file);

const findings = [];

for (const file of files) {
  const fileName = normalizeFileName(file);
  const isSuspiciousFile = suspiciousFilePatterns.some((pattern) =>
    pattern.test(fileName),
  );

  if (isSuspiciousFile) {
    findings.push({
      file,
      reason: "Suspicious secret-like filename",
    });
  }

  if (!isTextFile(file)) {
    continue;
  }

  let content = "";
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  for (const { name, regex } of patterns) {
    regex.lastIndex = 0;
    for (const match of content.matchAll(regex)) {
      const lineNumber = content
        .slice(0, match.index)
        .split(/\r?\n/).length;
      findings.push({
        file,
        line: lineNumber,
        reason: `${name}: ${match[0].slice(0, 80)}`,
      });
    }
  }
}

if (findings.length === 0) {
  process.stdout.write("No obvious secret patterns detected.\n");
  process.exit(0);
}

const grouped = new Map();
for (const finding of findings) {
  const key = finding.file;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(finding);
}

process.stderr.write("Potential secret exposure risk found:\n\n");
for (const [file, fileFindings] of grouped) {
  process.stderr.write(`- ${file}\n`);
  for (const item of fileFindings) {
    if (item.line !== undefined) {
      process.stderr.write(
        `  line ${item.line}: ${item.reason}\n`,
      );
    } else {
      process.stderr.write(`  ${item.reason}\n`);
    }
  }
}
process.stderr.write(
  "\nPlease remove or mask secrets before committing and try again.\n",
);
process.exit(1);
