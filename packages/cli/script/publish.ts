#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
const name = "devpass-code"

const REPO = "theopenco/devpass-code"

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

async function publish(dir: string, name: string, version: string) {
  // GitHub artifact downloads can drop the executable bit, and Docker uses the
  // unpacked dist binaries directly rather than the published tarball.
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`bun pm pack`.cwd(dir)
  await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(dir)
}

const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  const item = await Bun.file(`./dist/${filepath}`).json()
  if (item.name.startsWith(`${name}-`)) binaries[item.name] = item.version
}
console.log("binaries", binaries)
const version = Object.values(binaries)[0]

await $`mkdir -p ./dist/${name}`
await $`mkdir -p ./dist/${name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${name}/postinstall.mjs`
await Bun.file(`./dist/${name}/LICENSE`).write(await Bun.file("../../LICENSE").text())
await Bun.file(`./dist/${name}/bin/${name}.exe`).write(
  [
    `echo "Error: ${name}'s postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "This occurs when using --ignore-scripts during installation, or when using a" >&2',
    'echo "package manager like pnpm that does not run postinstall scripts by default." >&2',
    'echo "" >&2',
    'echo "To fix this, run the postinstall script manually:" >&2',
    `echo "  cd node_modules/${name} && node postinstall.mjs" >&2`,
    'echo "" >&2',
    `echo "Or reinstall ${name} without the --ignore-scripts flag." >&2`,
    "exit 1",
    "",
  ].join("\n"),
)

await Bun.file(`./dist/${name}/package.json`).write(
  JSON.stringify(
    {
      name: name,
      description: "DevPass Code — the LLM Gateway coding agent for the terminal",
      bin: {
        [name]: `./bin/${name}.exe`,
      },
      scripts: {
        postinstall: "node ./postinstall.mjs",
      },
      version: version,
      license: pkg.license,
      repository: {
        type: "git",
        url: `git+https://github.com/${REPO}.git`,
      },
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

// Promise.all would reject on the first failure and take the process down with it,
// killing the other in-flight npm publishes mid-upload. That both hides which
// packages actually failed and leaves the release half-published.
const results = await Promise.allSettled(
  Object.entries(binaries).map(([bin, version]) => publish(`./dist/${bin}`, bin, version)),
)
const failed = results.flatMap((r, i) =>
  r.status === "rejected" ? [`${Object.keys(binaries)[i]}: ${r.reason?.message ?? r.reason}`] : [],
)
if (failed.length) {
  console.error(`failed to publish ${failed.length}/${results.length} binary packages:`)
  for (const f of failed) console.error(`  ${f}`)
  process.exit(1)
}
await publish(`./dist/${name}`, name, version)

const image = `ghcr.io/${REPO}`
const platforms = "linux/amd64,linux/arm64"
const tags = [`${image}:${version}`, `${image}:${Script.channel}`]
const tagFlags = tags.flatMap((t) => ["-t", t])

// registries
if (!Script.preview) {
  await $`docker buildx build --platform ${platforms} ${tagFlags} --push .`
  // Calculate SHA values
  const arm64Sha = await $`sha256sum ./dist/${name}-linux-arm64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const x64Sha = await $`sha256sum ./dist/${name}-linux-x64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const macX64Sha = await $`sha256sum ./dist/${name}-darwin-x64.zip | cut -d' ' -f1`.text().then((x) => x.trim())
  const macArm64Sha = await $`sha256sum ./dist/${name}-darwin-arm64.zip | cut -d' ' -f1`.text().then((x) => x.trim())

  const [pkgver, _subver = ""] = Script.version.split(/(-.*)/, 2)

  // arch (AUR pushes need the AUR SSH key; skip when it is not configured)
  if (process.env.AUR_KEY) {
    const binaryPkgbuild = [
      "# Maintainer: devpass",
      "",
      `pkgname='${name}-bin'`,
      `pkgver=${pkgver}`,
      `_subver=${_subver}`,
      "options=('!debug' '!strip')",
      "pkgrel=1",
      "pkgdesc='DevPass Code — the LLM Gateway coding agent for the terminal.'",
      `url='https://github.com/${REPO}'`,
      "arch=('aarch64' 'x86_64')",
      "license=('MIT')",
      `provides=('${name}')`,
      `conflicts=('${name}')`,
      "depends=('ripgrep')",
      "",
      `source_aarch64=("\${pkgname}_\${pkgver}_aarch64.tar.gz::https://github.com/${REPO}/releases/download/v\${pkgver}\${_subver}/${name}-linux-arm64.tar.gz")`,
      `sha256sums_aarch64=('${arm64Sha}')`,

      `source_x86_64=("\${pkgname}_\${pkgver}_x86_64.tar.gz::https://github.com/${REPO}/releases/download/v\${pkgver}\${_subver}/${name}-linux-x64.tar.gz")`,
      `sha256sums_x86_64=('${x64Sha}')`,
      "",
      "package() {",
      `  install -Dm755 ./${name} "\${pkgdir}/usr/bin/${name}"`,
      "}",
      "",
    ].join("\n")

    for (const [aurPkg, pkgbuild] of [[`${name}-bin`, binaryPkgbuild]]) {
      for (let i = 0; i < 30; i++) {
        try {
          await $`rm -rf ./dist/aur-${aurPkg}`
          await $`git clone ssh://aur@aur.archlinux.org/${aurPkg}.git ./dist/aur-${aurPkg}`
          await $`cd ./dist/aur-${aurPkg} && git checkout master`
          await Bun.file(`./dist/aur-${aurPkg}/PKGBUILD`).write(pkgbuild)
          await $`cd ./dist/aur-${aurPkg} && makepkg --printsrcinfo > .SRCINFO`
          await $`cd ./dist/aur-${aurPkg} && git add PKGBUILD .SRCINFO`
          if ((await $`cd ./dist/aur-${aurPkg} && git diff --cached --quiet`.nothrow()).exitCode === 0) break
          await $`cd ./dist/aur-${aurPkg} && git commit -m "Update to v${Script.version}"`
          await $`cd ./dist/aur-${aurPkg} && git push`
          break
        } catch {
          continue
        }
      }
    }
  }

  // Homebrew formula
  const homebrewFormula = [
    "# typed: false",
    "# frozen_string_literal: true",
    "",
    "# This file was generated by the devpass-code release pipeline. DO NOT EDIT.",
    "class DevpassCode < Formula",
    `  desc "DevPass Code — the LLM Gateway coding agent for the terminal."`,
    `  homepage "https://github.com/${REPO}"`,
    `  version "${Script.version.split("-")[0]}"`,
    "",
    `  depends_on "ripgrep"`,
    "",
    "  on_macos do",
    "    if Hardware::CPU.intel?",
    `      url "https://github.com/${REPO}/releases/download/v${Script.version}/${name}-darwin-x64.zip"`,
    `      sha256 "${macX64Sha}"`,
    "",
    "      def install",
    `        bin.install "${name}"`,
    "      end",
    "    end",
    "    if Hardware::CPU.arm?",
    `      url "https://github.com/${REPO}/releases/download/v${Script.version}/${name}-darwin-arm64.zip"`,
    `      sha256 "${macArm64Sha}"`,
    "",
    "      def install",
    `        bin.install "${name}"`,
    "      end",
    "    end",
    "  end",
    "",
    "  on_linux do",
    "    if Hardware::CPU.intel? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/${REPO}/releases/download/v${Script.version}/${name}-linux-x64.tar.gz"`,
    `      sha256 "${x64Sha}"`,
    "      def install",
    `        bin.install "${name}"`,
    "      end",
    "    end",
    "    if Hardware::CPU.arm? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/${REPO}/releases/download/v${Script.version}/${name}-linux-arm64.tar.gz"`,
    `      sha256 "${arm64Sha}"`,
    "      def install",
    `        bin.install "${name}"`,
    "      end",
    "    end",
    "  end",
    "end",
    "",
    "",
  ].join("\n")

  const token = process.env.GITHUB_TOKEN
  if (!token) {
    console.error("GITHUB_TOKEN is required to update homebrew tap")
    process.exit(1)
  }
  const tap = `https://x-access-token:${token}@github.com/theopenco/homebrew-tap.git`
  await $`rm -rf ./dist/homebrew-tap`
  await $`git clone ${tap} ./dist/homebrew-tap`
  await Bun.file(`./dist/homebrew-tap/${name}.rb`).write(homebrewFormula)
  await $`cd ./dist/homebrew-tap && git add ${name}.rb`
  if ((await $`cd ./dist/homebrew-tap && git diff --cached --quiet`.nothrow()).exitCode !== 0) {
    await $`cd ./dist/homebrew-tap && git commit -m "Update to v${Script.version}"`
    await $`cd ./dist/homebrew-tap && git push`
  }
}
