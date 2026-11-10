#!/usr/bin/env node
/**
 * 卸载救急。默认纯预览；--confirm 同次确认，或 --apply --expected-plan <预览指纹>。
 * 只移除本插件的精确注册项，先备份清单/YAML，再隔离插件 entry。
 * 不清空整份 Cordis 配置，不跟随 junction 删除源码；笔记与插件配置保留。
 */
import { runMaintenanceCli } from './lib/profile-maintenance.js'

await runMaintenanceCli('rollback', process.argv.slice(2))
