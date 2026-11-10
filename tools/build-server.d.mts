/** tools/build-server.mjs 的 TS 消费面（src/main 测试 import 用；vitest/electron 均不经打包直接跑 ESM） */

export interface BuiltServerManifest {
  version: string
  file: string
  sha256: string
  sizeBytes: number
  fileCount: number
  nodeVersion?: string
  nodeAbi?: string
  builtAt?: string
}

export function serverVersion(pkgJson: { version?: unknown }): string
export function buildStaging(
  stageDir: string,
  opts?: { quiet?: boolean }
): Promise<{ version: string }>
/** 返回值已含 gzip 层（.tgz 字节流，勿再压缩） */
export function createTarball(stageDir: string, topEntries: string[]): Buffer
export function buildServerPackage(opts?: {
  outDir?: string
  quiet?: boolean
}): Promise<BuiltServerManifest>
