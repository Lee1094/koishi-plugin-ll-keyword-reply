const { Schema, h } = require('koishi')
const fs = require('fs')
const path = require('path')

const RULES_FILE = path.join(__dirname, 'rules.json')

function loadRulesFile() {
  try {
    if (fs.existsSync(RULES_FILE)) {
      return JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'))
    }
  } catch {}
  return []
}

function saveRulesFile(rules) {
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf-8')
}

// 规则 Schema
const RuleItem = Schema.object({
  keywords: Schema.array(Schema.string()).default([]).description('关键词（多个逗号分隔）'),
  matchMode: Schema.union(['contains', 'regex']).default('contains').description('匹配模式'),
  weekdays: Schema.array(Schema.number()).default([]).description('星期 0-6（空=每天）'),
  reply: Schema.string().default('').description('默认回复'),
  replyType: Schema.union(['text', 'image']).default('text').description('回复类型'),
  groupOverrides: Schema.array(Schema.object({
    group: Schema.string().description('群号'),
    reply: Schema.string().default('').description('该群回复'),
    replyType: Schema.union(['text', 'image']).default('text').description('类型'),
  })).default([]).description('特定群覆盖'),
  enabled: Schema.boolean().default(true).description('启用'),
})

// dict 类型 → 设置页渲染为表格
const Config = Schema.object({
  admins: Schema.array(Schema.string()).default([]).description('管理员QQ号（留空=所有人可用管理命令）'),
  rules: Schema.dict(RuleItem).default({}).description('关键词规则表格（键=规则唯一名称）'),
})

function apply(ctx, config) {
  // 加载规则：JSON 文件优先，首次从 Config 导入
  let rules = loadRulesFile()
  if (rules.length === 0 && config.rules && Object.keys(config.rules).length > 0) {
    rules = Object.entries(config.rules).map(([key, val]) => ({ key, ...val }))
    saveRulesFile(rules)
  }

  // 规则数量变化时自动从 Config 同步（设置页保存 → JSON）
  const configLen = config.rules ? Object.keys(config.rules).length : 0
  if (configLen > 0 && configLen !== rules.length) {
    rules = Object.entries(config.rules).map(([key, val]) => ({ key, ...val }))
    saveRulesFile(rules)
  }

  function syncRules() {
    saveRulesFile(rules)
  }

  function isAdmin(userId) {
    if (!config.admins || config.admins.length === 0) return true
    return config.admins.includes(String(userId))
  }

  function flatKeywords(keywords) {
    if (!keywords) return []
    if (typeof keywords === 'string') {
      return keywords.split(',').map(s => s.trim()).filter(Boolean)
    }
    if (!Array.isArray(keywords)) return []
    return keywords.flatMap(kw => {
      if (typeof kw !== 'string' || !kw) return []
      if (kw.includes(',')) return kw.split(',').map(s => s.trim()).filter(Boolean)
      return [kw.trim()]
    })
  }

  function getReply(rule, groupId) {
    const overs = rule.groupOverrides || []
    const override = overs.find(o => o.group === groupId)
    if (override && override.reply) {
      return { reply: override.reply, replyType: override.replyType || 'text' }
    }
    return { reply: rule.reply, replyType: rule.replyType || 'text' }
  }

  // ===== message 事件 =====
  ctx.on('message', async (session) => {
    if (session.userId === session.bot?.selfId) return
    let text = (session.content || '').replace(/\[CQ:[^\]]*\]/g, '').trim()
    if (!text) return

    const today = new Date().getDay()
    const groupId = session.guildId ? String(session.guildId) : ''

    for (const rule of rules) {
      if (!rule.enabled) continue
      if (rule.weekdays && rule.weekdays.length > 0) {
        if (!rule.weekdays.includes(today)) continue
      }

      const matched = flatKeywords(rule.keywords).some(kw => {
        if (rule.matchMode === 'regex') {
          try { return new RegExp(kw).test(text) } catch { return false }
        }
        return text.includes(kw)
      })
      if (!matched) continue

      const { reply, replyType } = getReply(rule, groupId)
      if (!reply) continue

      try {
        if (replyType === 'image') {
          await session.send(h.image(reply))
        } else {
          await session.send(reply)
        }
      } catch (e) {
        ctx.logger.error(`[keyword-reply] 发送失败: ${e.message}`)
      }
      return
    }
  })

  // ===== 管理命令 =====
  ctx.command('keyword', '关键词回复管理')
    .action(() =>
      '📊 表格管理：控制台 → 插件设置 → ll-keyword-reply（rules 表格可编辑）\n' +
      '💬 命令管理：\n' +
      'keyword.list [ID] — 查看列表/详情\n' +
      'keyword.add <名称> <关键词,关键词> <回复> — 添加\n' +
      'keyword.edit <ID> <关键词> <回复> — 编辑\n' +
      'keyword.remove <ID> — 删除\n' +
      'keyword.toggle <ID> — 启用/禁用\n' +
      'keyword.group <ID> <群号> <回复> — 群覆盖\n' +
      'keyword.ungroup <ID> <群号> — 移除群覆盖\n' +
      'keyword.test <文本> — 测试匹配'
    )

  ctx.command('keyword.list [id:number]', '查看规则列表 / 详情')
    .action(({ session }, id) => {
      if (!rules.length) return '暂无关键词规则\n可在插件设置页的 rules 表格中添加'

      if (id !== undefined) {
        const r = rules[id]
        if (!r) return `未找到规则 #${id}`
        const status = r.enabled !== false ? '✅ 启用' : '⛔ 禁用'
        const mode = r.matchMode === 'regex' ? '正则' : '包含'
        const kws = flatKeywords(r.keywords).join(', ')
        const wd = (r.weekdays || []).length
          ? (r.weekdays || []).map(d => ['日','一','二','三','四','五','六'][d]).join(', ')
          : '每天'
        const defReply = r.reply
          ? `${r.replyType === 'image' ? '[图片] ' : ''}${r.reply}`
          : '(无)'
        const overs = (r.groupOverrides || []).map(o =>
          `  ${o.group}: ${o.replyType === 'image' ? '[图片]' : ''}${o.reply}`
        ).join('\n')
        return [
          `📋 规则 #${id}: ${r.key || '未命名'}`,
          `状态: ${status}`,
          `匹配模式: ${mode}`,
          `关键词: ${kws}`,
          `星期: ${wd}`,
          `默认回复: ${defReply}`,
          `按群覆盖: ${overs || '(无)'}`,
        ].join('\n')
      }

      const lines = rules.map((r, i) => {
        const s = r.enabled !== false ? '✅' : '⛔'
        const m = r.matchMode === 'regex' ? '正' : '含'
        const kws = flatKeywords(r.keywords).join(', ')
        const rp = r.reply
          ? `${r.replyType === 'image' ? '🖼' : '📝'} ${r.reply.substring(0, 25)}${r.reply.length > 25 ? '...' : ''}`
          : '(无)'
        const ov = (r.groupOverrides || []).length ? ` +${r.groupOverrides.length}群覆盖` : ''
        return `${s} #${i} [${m}] ${r.key || '未命名'}${ov}\n  ${kws} → ${rp}`
      })
      lines.push(`\n共 ${rules.length} 条 | keyword.list <ID> 详情`)
      return lines.join('\n')
    })

  ctx.command('keyword.add <keywords:string> <reply:text>', '添加关键词规则')
    .option('name', '-n <name:string>')
    .option('type', '-t <type:string>')
    .option('matchMode', '-m <mode:string>')
    .action(({ session, options }, keywords, reply) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      const kwList = keywords.split(',').map(s => s.trim()).filter(Boolean)
      if (!kwList.length) return '关键词不能为空'
      if (!reply) return '默认回复不能为空'

      const key = (options.name || kwList[0]).trim()
      const rule = {
        key,
        keywords: kwList,
        matchMode: options.matchMode || 'contains',
        weekdays: [],
        reply,
        replyType: options.type || 'text',
        groupOverrides: [],
        enabled: true,
      }
      rules.push(rule)
      syncRules()
      return `✅ 已添加规则 #${rules.length - 1}: ${rule.key} [${rule.matchMode}]`
    })

  ctx.command('keyword.edit <id:number> <keywords:string> <reply:text>', '编辑规则')
    .option('name', '-n <name:string>')
    .option('type', '-t <type:string>')
    .option('matchMode', '-m <mode:string>')
    .action(({ session, options }, id, keywords, reply) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      const rule = rules[id]
      if (!rule) return `未找到规则 #${id}`
      if (keywords) rule.keywords = keywords.split(',').map(s => s.trim()).filter(Boolean)
      if (reply) rule.reply = reply
      if (options.name) rule.key = options.name
      if (options.type) rule.replyType = options.type
      if (options.matchMode) rule.matchMode = options.matchMode
      syncRules()
      return `✅ 已更新规则 #${id}: ${rule.key}`
    })

  ctx.command('keyword.remove <id:number>', '删除规则')
    .action(({ session }, id) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      if (id < 0 || id >= rules.length) return `未找到规则 #${id}`
      const name = rules[id].key || '未命名'
      rules.splice(id, 1)
      syncRules()
      return `✅ 已删除规则 #${id}: ${name}`
    })

  ctx.command('keyword.toggle <id:number>', '启用/禁用规则')
    .action(({ session }, id) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      const rule = rules[id]
      if (!rule) return `未找到规则 #${id}`
      rule.enabled = !rule.enabled
      syncRules()
      return `${rule.enabled ? '✅ 已启用' : '⛔ 已禁用'} 规则 #${id}: ${rule.key || '未命名'}`
    })

  ctx.command('keyword.group <id:number> <group:string> <reply:text>', '设置某群专属回复')
    .option('type', '-t <type:string>')
    .action(({ session, options }, id, group, reply) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      const rule = rules[id]
      if (!rule) return `未找到规则 #${id}`
      if (!group) return '群号不能为空'
      if (!reply) return '回复内容不能为空'

      if (!rule.groupOverrides) rule.groupOverrides = []
      const idx = rule.groupOverrides.findIndex(o => o.group === group)
      const ov = { group, reply, replyType: options.type || 'text' }
      if (idx >= 0) rule.groupOverrides[idx] = ov
      else rule.groupOverrides.push(ov)
      syncRules()
      return `✅ 规则 #${id} 在群 ${group} 的回复已设置`
    })

  ctx.command('keyword.ungroup <id:number> <group:string>', '移除某群专属回复')
    .action(({ session }, id, group) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      const rule = rules[id]
      if (!rule) return `未找到规则 #${id}`
      const overs = rule.groupOverrides || []
      const idx = overs.findIndex(o => o.group === group)
      if (idx < 0) return `规则 #${id} 没有群 ${group} 的覆盖设置`
      overs.splice(idx, 1)
      syncRules()
      return `✅ 已移除规则 #${id} 在群 ${group} 的专属回复`
    })

  ctx.command('keyword.raw <id:number>', '查看原始JSON（调试）')
    .action(({ session }, id) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      const rule = rules[id]
      if (!rule) return `未找到规则 #${id}`
      return JSON.stringify(rule, null, 2)
    })

  ctx.command('keyword.test <text:text>', '测试匹配')
    .action(({ session }, text) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      if (!text) return '请输入测试文本'

      const today = new Date().getDay()
      const groupId = session.guildId ? String(session.guildId) : ''
      const matched = []

      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i]
        if (!rule.enabled) continue
        if (rule.weekdays && rule.weekdays.length > 0) {
          if (!rule.weekdays.includes(today)) continue
        }
        const hit = flatKeywords(rule.keywords).some(kw => {
          if (rule.matchMode === 'regex') {
            try { return new RegExp(kw).test(text) } catch { return false }
          }
          return text.includes(kw)
        })
        if (hit) {
          const { reply, replyType } = getReply(rule, groupId)
          matched.push({ index: i, rule, effectiveReply: reply, effectiveType: replyType })
        }
      }

      if (!matched.length) return `"${text}" 没有匹配到任何规则`
      return `"${text}" 匹配到 ${matched.length} 条规则：\n` +
        matched.map(({ index, rule, effectiveReply, effectiveType }) => {
          const eff = effectiveReply
            ? (effectiveType === 'image' ? '[图片]' : '') + effectiveReply.substring(0, 30)
            : '(无回复，跳过)'
          return `  #${index} ${rule.key || '未命名'} [${flatKeywords(rule.keywords).join(', ')}] → ${eff}`
        }).join('\n')
    })
}

module.exports = { Config, apply }
