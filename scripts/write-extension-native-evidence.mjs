#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION_PART = '[0-9A-Za-z][0-9A-Za-z._-]*'

export const ARTIFACT_RULES = {
  darwin: {
    pattern: new RegExp(`^Kun-${VERSION_PART}-mac-(arm64|x64)\\.(dmg|zip)$`),
    required: [
      /-mac-arm64\.dmg$/,
      /-mac-arm64\.zip$/,
      /-mac-x64\.dmg$/,
      /-mac-x64\.zip$/
    ]
  },
  win32: {
    pattern: new RegExp(`^Kun-${VERSION_PART}-win-x64\\.exe$`),
    required: [/-win-x64\.exe$/]
  },
  linux: {
    pattern: new RegExp(`^Kun-${VERSION_PART}-linux-x86_64\\.AppImage$`),
    required: [/-linux-x86_64\.AppImage$/]
  }
}

export async function collectNativeArtifacts({ distDirectory, platform }) {
  const rule = ARTIFACT_RULES[platform]
  if (!rule) throw new Error(`Unsupported native evidence platform: ${platform}`)

  const directory = resolve(distDirectory)
  const entries = await readdir(directory, { withFileTypes: true })
  const matching = entries.filter((entry) => rule.pattern.test(entry.name))
  for (const entry of matching) {
    const path = join(directory, entry.name)
    const details = await lstat(path)
    if (!entry.isFile() || details.isSymbolicLink()) {
      throw new Error(`Native evidence artifact must be a regular file: ${path}`)
    }
  }

  const names = matching.map((entry) => entry.name).sort()
  for (const required of rule.required) {
    const candidates = names.filter((name) => required.test(name))
    if (candidates.length !== 1) {
      throw new Error(
        `Expected exactly one native ${platform} artifact matching ${required}, ` +
        `found ${candidates.length}${candidates.length ? `: ${candidates.join(', ')}` : ''}`
      )
    }
  }
  if (names.length !== rule.required.length) {
    throw new Error(
      `Expected exactly ${rule.required.length} native ${platform} artifacts in ${directory}, ` +
      `found ${names.length}: ${names.join(', ') || '(none)'}`
    )
  }

  return names.map((name) => join(directory, name))
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function createNativeEvidence({
  distDirectory = resolve('dist'),
  platform = process.platform,
  commit = resolveCommit(),
  environment = process.env
} = {}) {
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error(`Native evidence requires a full 40-character commit SHA, got: ${commit}`)
  }
  const artifacts = await collectNativeArtifacts({ distDirectory, platform })
  return {
    schemaVersion: 1,
    platform,
    commit: commit.toLowerCase(),
    run: {
      repository: optionalString(environment.GITHUB_REPOSITORY),
      runId: optionalString(environment.GITHUB_RUN_ID),
      runAttempt: optionalString(environment.GITHUB_RUN_ATTEMPT)
    },
    artifacts: await Promise.all(artifacts.map(async (path) => ({
      file: path.slice(resolve(distDirectory).length + 1).replaceAll('\\', '/'),
      bytes: (await stat(path)).size,
      sha256: await sha256File(path)
    })))
  }
}

export async function writeNativeEvidence({ outputPath, ...options } = {}) {
  const evidence = await createNativeEvidence(options)
  const output = resolve(
    outputPath ?? join(options.distDirectory ?? resolve('dist'), `extension-native-evidence-${evidence.platform}.json`)
  )
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
  return { evidence, output }
}

function resolveCommit() {
  const fromEnvironment = optionalString(process.env.GITHUB_SHA)
  if (fromEnvironment) return fromEnvironment
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

async function main() {
  const { evidence, output } = await writeNativeEvidence({
    distDirectory: argumentValue('--dist') ?? resolve('dist'),
    platform: argumentValue('--platform') ?? process.platform,
    outputPath: argumentValue('--output')
  })
  process.stdout.write(
    `Extension native evidence OK: ${evidence.platform}, ${evidence.artifacts.length} artifact(s), ${output}\n`
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
