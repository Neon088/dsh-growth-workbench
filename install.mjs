#!/usr/bin/env node
/**
 * 脚本直装。默认纯预览；--confirm 同次确认，或 --apply --expected-plan <预览指纹>。
 * 先 staging/备份再切换，保留开发 junction；不运行 pnpm、不自动重启 DSH。
 */
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMaintenanceCli } from './lib/profile-maintenance.js'

await runMaintenanceCli('install', process.argv.slice(2), { sourceDir: dirname(fileURLToPath(import.meta.url)) })
