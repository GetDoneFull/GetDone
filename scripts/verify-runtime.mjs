import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
);

const [major] = process.versions.node.split(".").map(Number);
if (major !== 24) {
  console.error(`GetDone CI requires Node 24.x; received ${process.versions.node}`);
  process.exit(1);
}

const npmVersion = process.env.npm_config_user_agent?.match(/npm\/([^\s]+)/)?.[1];
if (!npmVersion) {
  console.error("Unable to determine npm runtime version.");
  process.exit(1);
}

const expectedNpm = typeof packageJson.packageManager === "string"
  ? packageJson.packageManager.match(/^npm@(.+)$/)?.[1]
  : undefined;

const expectedNpmMajor = expectedNpm?.split(".")[0];
const actualNpmMajor = npmVersion.split(".")[0];
if (!expectedNpmMajor || actualNpmMajor !== expectedNpmMajor) {
  console.error(`GetDone requires npm ${expectedNpm ?? "(packageManager missing)"} compatible major; received ${npmVersion}`);
  process.exit(1);
}

console.log(`Runtime verified: node=${process.versions.node} npm=${npmVersion} packageManager=${packageJson.packageManager}`);
