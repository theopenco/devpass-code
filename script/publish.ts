#!/usr/bin/env bun

import { Script } from "@opencode/script"
import { $ } from "bun"
import { fileURLToPath } from "url"

console.log("=== publishing ===\n")

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
const tag = `v${Script.version}`
const syncBranch = process.env.GITHUB_REF_NAME || "main"

const pkgjsons = await Array.fromAsync(
  new Bun.Glob("**/package.json").scan({
    absolute: true,
  }),
).then((arr) => arr.filter((x) => !x.includes("node_modules") && !x.includes("dist")))

async function prepareReleaseFiles() {
  for (const file of pkgjsons) {
    let pkg = await Bun.file(file).text()
    pkg = pkg.replaceAll(/"version": "[^"]+"/g, `"version": "${Script.version}"`)
    console.log("updated:", file)
    await Bun.file(file).write(pkg)
  }

  await $`bun install`
}

async function writeChangelog() {
  const notes = process.env["OPENCODE_RELEASE_NOTES"]?.trim()
  if (!notes) return
  const file = Bun.file("CHANGELOG.md")
  const text = await file.text()
  const lines = text.split("\n")
  if (lines.some((line) => line === `## ${tag}` || line.startsWith(`## ${tag} `))) return
  const index = lines.findIndex((line) => line.startsWith("## "))
  const head = (index === -1 ? lines : lines.slice(0, index)).join("\n").trimEnd()
  const rest = index === -1 ? "" : lines.slice(index).join("\n")
  const entry = `## ${tag} — ${new Date().toISOString().slice(0, 10)}\n\n${notes}\n`
  await file.write(`${head}\n\n${entry}${rest ? `\n${rest}` : ""}`)
}

if (Script.release && !Script.preview) {
  await $`git fetch origin --tags`
  await $`git switch --detach`
}

await prepareReleaseFiles()

console.log("\n=== cli ===\n")
await $`bun ./packages/cli/script/publish.ts`

// The schema, sdk, plugin, ui, and other library packages are published under
// the @opencode npm scope, which belongs to upstream. Only the CLI ships here.

if (Script.release && !Script.preview) {
  if ((await $`git diff --quiet`.nothrow()).exitCode !== 0) await $`git commit -am "release: ${tag}"`
  await $`git tag -d ${tag}`.nothrow()
  await $`git tag ${tag}`
  await $`git push origin refs/tags/${tag} --force-with-lease --no-verify`
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  await $`git fetch origin`
  await $`git checkout -B ${syncBranch} origin/${syncBranch}`
  await prepareReleaseFiles()
  await writeChangelog()
  if ((await $`git diff --quiet`.nothrow()).exitCode !== 0) {
    // The release already published this code; a push-triggered dev publish of a version bump is wasted work.
    await $`git commit -am ${`sync release versions for ${tag} [skip ci]`}`
    await $`git push origin HEAD:${syncBranch} --no-verify`
  }
}
