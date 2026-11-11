import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ConnectionManager } from './ssh/connection-manager'
import { posixQuote } from './cli-runner'

/**
 * v1.7.0 远程 Skills 写通道（用户指令：本机和远程的 skill 安装管理都移植到设置页）：
 * - 移除：VM 侧 mv 到 ~/.claude/.skills-trash/<name>-<ts>（客户端回收站不适用 VM
 *   路径——错侧；VM 侧 trash 保留可手工找回）；路径经 posixQuote 硬化。
 * - 导入：本机目录递归 SFTP 上传到 VM ~/.claude/skills/<basename>（逐文件读写，
 *   目录经 sftp.mkdir 幂等创建；符号链接跳过——上传内容而非链接语义）。
 */

async function remoteHome(mgr: ConnectionManager, cid: string): Promise<string> {
  const r = await mgr.exec(cid, `h=$(printf %s "$HOME"); printf %s "$h"`)
  if (r.code !== 0) throw new Error(`remote HOME unavailable (exit ${r.code})`)
  const home = r.stdout.trim()
  if (home === '') throw new Error('remote HOME unavailable')
  return home
}

/** 远程移除 skill（path 为 VM 侧绝对路径——SkillInfo.path 远端形态） */
export async function removeRemoteSkill(
  mgr: ConnectionManager,
  cid: string,
  remotePath: string
): Promise<void> {
  const home = await remoteHome(mgr, cid)
  const trash = `${home}/.claude/.skills-trash`
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const prep = await mgr.exec(cid, `mkdir -p ${posixQuote(trash)} && printf ok`)
  if (prep.code !== 0 || !prep.stdout.includes('ok')) {
    throw new Error(`remote trash dir prepare failed (exit ${prep.code})`)
  }
  const target = `${trash}/${basename(remotePath)}-${ts}`
  const r = await mgr.exec(
    cid,
    `test -e ${posixQuote(remotePath)} && mv ${posixQuote(remotePath)} ${posixQuote(target)} && printf moved`
  )
  if (r.code !== 0 || !r.stdout.includes('moved')) {
    throw new Error(r.stderr.trim() !== '' ? r.stderr.trim() : `remote remove failed (exit ${r.code})`)
  }
}

/** 本机目录递归上传到 VM 目标目录（导入远程 skill 用） */
export async function uploadDirRemote(
  mgr: ConnectionManager,
  cid: string,
  localDir: string,
  remoteDir: string
): Promise<{ files: number }> {
  const sftp = await mgr.sftp(cid)
  if (sftp.mkdir === undefined) {
    throw new Error('remote sftp session does not support mkdir')
  }
  const files: Array<{ local: string; remote: string }> = []
  const walk = (local: string, remote: string): void => {
    for (const entry of readdirSync(local)) {
      const lp = join(local, entry)
      const rp = `${remote}/${entry}`
      const st = statSync(lp)
      if (st.isDirectory()) walk(lp, rp)
      else if (st.isFile()) files.push({ local: lp, remote: rp })
      // 符号链接跳过（上传内容语义——链接指向本机侧无意义）
    }
  }
  walk(localDir, remoteDir)
  // 先建全部目录（按路径深度浅→深，幂等 mkdir），再写文件
  const dirs = new Set<string>()
  for (const f of files) {
    const parts = f.remote.split('/')
    for (let i = 2; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  for (const d of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
    await sftp.mkdir(d)
  }
  for (const f of files) {
    await sftp.writeFile(f.remote, readFileSync(f.local))
  }
  return { files: files.length }
}

/** 导入远程 skill：上传到 VM ~/.claude/skills/<basename(localDir)>，返回 VM 侧路径 */
export async function importRemoteSkillFolder(
  mgr: ConnectionManager,
  cid: string,
  localDir: string
): Promise<string> {
  const home = await remoteHome(mgr, cid)
  const dest = `${home}/.claude/skills/${basename(localDir)}`
  await uploadDirRemote(mgr, cid, localDir, dest)
  return dest
}
