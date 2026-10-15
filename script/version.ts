#!/usr/bin/env bun

import { Script } from "@opencode/script"
import { $ } from "bun"

const output = [`version=${Script.version}`]

if (!Script.preview || Script.channel === "beta") {
  const tag = `v${Script.version}`
  const repo = process.env.GH_REPO
  // build-cli uploads the release archives to this draft, and script/publish.ts publishes it.
  const existing = await $`gh release view ${tag} --repo ${repo} --json tagName`.quiet().nothrow()
  if (existing.exitCode !== 0) {
    const target = process.env.GITHUB_SHA ?? (await $`git rev-parse HEAD`.text()).trim()
    await $`gh release create ${tag} --draft --target ${target} --title ${tag} --generate-notes --repo ${repo}`
  }
  output.push("release=true")
  output.push(`tag=${tag}`)
}

output.push(`repo=${process.env.GH_REPO}`)

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
}

process.exit(0)
