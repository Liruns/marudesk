import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const read = (path) => readFileSync(resolve(root, path), "utf8");

const checks = [
  {
    id: "docs-root-guidance-files",
    run() {
      const agents = read("AGENTS.md");
      const claude = read("CLAUDE.md");

      mustInclude(agents, "toy-prj");
      mustInclude(agents, "RTK");
      mustInclude(agents, "marudesk");
      mustInclude(agents, "mobile");
      mustInclude(agents, "relay");
      mustInclude(agents, "Run commands from the package directory");
      mustInclude(claude, "@AGENTS.md");
      mustInclude(claude, "AGENTS.md");
      mustInclude(claude, "CLAUDE.md");
      mustNotInclude(claude, "npm run typecheck");
      mustHaveAtMostLines(claude, 40);
    },
  },
  {
    id: "docs-root-readme-overview",
    run() {
      const readme = read("README.md");

      mustInclude(readme, "# toy-prj");
      mustInclude(readme, "marudesk");
      mustInclude(readme, "mobile");
      mustInclude(readme, "relay");
      mustInclude(readme, "Quick start");
      mustInclude(readme, "Verification");
      mustInclude(readme, "per package");
      mustInclude(readme, "no root package");
    },
  },
  {
    id: "docs-marudesk-readme-replaces-template",
    run() {
      const readme = read("marudesk/README.md");

      mustInclude(readme, "# marudesk");
      mustInclude(readme, "Electron");
      mustInclude(readme, "runtime");
      mustInclude(readme, "npm run typecheck");
      mustNotInclude(readme, "React + TypeScript + Vite");
    },
  },
  {
    id: "docs-mobile-readme-bridge-boundary",
    run() {
      const readme = read("mobile/README.md");

      mustInclude(readme, "# marudesk-mobile");
      mustInclude(readme, "does not run the model or tools");
      mustInclude(readme, "StubTransport");
      mustInclude(readme, "RelayTransport");
      mustInclude(readme, "npm run typecheck");
      mustInclude(readme, "npm run build");
      mustInclude(readme, "npm run smoke");
      mustNotContainMojibake(readme);
    },
  },
  {
    id: "docs-relay-readme-contract",
    run() {
      const readme = read("relay/README.md");

      mustInclude(readme, "# marudesk-relay");
      mustInclude(readme, "same logged-in account");
      mustInclude(readme, "npm start");
      mustInclude(readme, "npm run typecheck");
      mustInclude(readme, "npm test");
      mustInclude(readme, "HTTP surface");
      mustInclude(readme, "WebSocket surface");
      mustInclude(readme, "cross-account isolation");
      mustNotContainMojibake(readme);
    },
  },
];

for (const check of checks) {
  try {
    check.run();
    console.log(`PASS ${check.id}`);
  } catch (error) {
    console.error(`FAIL ${check.id}: ${error.message}`);
    process.exitCode = 1;
  }
}

function mustInclude(text, needle) {
  if (!text.includes(needle)) {
    throw new Error(`expected text to include ${JSON.stringify(needle)}`);
  }
}

function mustNotInclude(text, needle) {
  if (text.includes(needle)) {
    throw new Error(`expected text not to include ${JSON.stringify(needle)}`);
  }
}

function mustHaveAtMostLines(text, maxLines) {
  const lineCount = text.trim().split(/\r?\n/).length;
  if (lineCount > maxLines) {
    throw new Error(`expected at most ${maxLines} lines, found ${lineCount}`);
  }
}

function mustNotContainMojibake(text) {
  if (/[\uFFFD\u0080-\u009F]/u.test(text)) {
    throw new Error("expected text not to contain mojibake replacement/control characters");
  }
}
