const { Schema, h } = require('koishi')

// ===== 规则 Schema（设置页 & 数据库共用）=====
const GroupOverride = Schema.object({
  group: Schema.string().description('群号'),
  reply: Schema.string().default('').description('该群的回复内容'),
  replyType: Schema.union(['text', 'image']).default('text').description('该群的回复类型'),
})

const RuleItem = Schema.object({
  name: Schema.string().default('').description('规则名称'),
  keywords: Schema.array(Schema.string()).default([]).description('关键词（多个逗号分隔）'),
  matchMode: Schema.union(['contains', 'regex']).default('contains').description('匹配模式'),
  weekdays: Schema.array(Schema.number()).default([]).description('生效星期 0-6（空=每天）'),
  reply: Schema.string().default('').description('默认回复'),
  replyType: Schema.union(['text', 'image']).default('text').description('默认回复类型'),
  groupOverrides: Schema.array(GroupOverride).default([]).description('特定群覆盖回复'),
  enabled: Schema.boolean().default(true).description('是否启用'),
})

const Config = Schema.object({
  admins: Schema.array(Schema.string()).default([]).description('管理员QQ号（留空=所有人可用管理命令）'),
  rules: Schema.array(RuleItem).default([]).description('关键词规则（此处编辑或去「数据库」页表格管理）'),
})

// 数据库表字段（控制台数据库页显示为表格）
const RuleFields = {
  id: 'unsigned',
  name: 'string',
  keywords: 'list',
  matchMode: 'string',
  weekdays: 'list',
  reply: 'text',
  replyType: 'string',
  groupOverrides: 'json',
  enabled: 'boolean',
}

const inject = { optional: ['database'] }

function apply(ctx, config) {
  // 注册数据表 → 控制台「数据库」页出现可编辑表格
  ctx.model.extend('keyword_rule', RuleFields, { autoInc: true })

  function hasDB() {
    return !!(ctx.database && typeof ctx.database.get === 'function')
  }

  // ===== 内存缓存 & 同步 =====
  let rules = []
  let cacheTime = 0

  async function loadRules(force) {
    const now = Date.now()
    if (!force && cacheTime && now - cacheTime < 1000) return
    if (!hasDB()) return
    try {
      rules = await ctx.database.get('keyword_rule', {})
      cacheTime = now
    } catch { rules = [] }
  }

  // 启动时：数据库优先，如果为空则从 Config 导入
  ;(async () => {
    if (!hasDB()) return
    try {
      const dbRules = await ctx.database.get('keyword_rule', {})
      if (dbRules.length === 0 && config.rules && config.rules.length > 0) {
        // Config → 数据库
        for (const r of config.rules) {
          await ctx.database.create('keyword_rule', {
            name: r.name || '',
            keywords: r.keywords || [],
            matchMode: r.matchMode || 'contains',
            weekdays: r.weekdays || [],
            reply: r.reply || '',
            replyType: r.replyType || 'text',
            groupOverrides: r.groupOverrides || [],
            enabled: r.enabled !== false,
          })
        }
        ctx.logger.info(`[keyword-reply] 已从插件设置导入 ${config.rules.length} 条规则到数据库`)
        await loadRules(true)
      } else {
        rules = dbRules
        cacheTime = Date.now()
      }
    } catch {}
  })()

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
    const result = []
    for (const kw of keywords) {
      if (typeof kw !== 'string' || !kw) continue
      if (kw.includes(',')) {
        result.push(...kw.split(',').map(s => s.trim()).filter(Boolean))
      } else {
        result.push(kw.trim())
      }
    }
    return result
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

    await loadRules()
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

  // 数据库写守卫
  function requireDB() {
    if (!hasDB()) throw new Error('数据库服务不可用，请安装 database 插件')
  }

  // ===== 管理命令 =====
  ctx.command('keyword', '关键词回复管理')
    .action(() =>
      '管理方式：\n' +
      '① 控制台「数据库」页 → keyword_rule 表格\n' +
      '② 插件设置页 → rules 配置\n' +
      '③ 聊天命令：\n' +
      'keyword.list [ID] — 查看列表/详情\n' +
      'keyword.add <关键词> <回复> — 添加\n' +
      'keyword.edit <ID> <关键词> <回复> — 编辑\n' +
      'keyword.remove <ID> — 删除\n' +
      'keyword.toggle <ID> — 启用/禁用\n' +
      'keyword.group <ID> <群号> <回复> — 群覆盖\n' +
      'keyword.ungroup <ID> <群号> — 移除群覆盖\n' +
      'keyword.test <文本> — 测试匹配'
    )

  ctx.command('keyword.list [id:number]', '查看所有规则 / 详情')
    .action(async ({ session }, id) => {
      await loadRules(true)
      if (!rules.length) return '暂无关键词规则\n\n可通过插件设置页或数据库页添加'

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
          `📋 规则 #${id}: ${r.name || '未命名'}`,
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
        return `${s} #${i} [${m}] ${r.name || '未命名'}${ov}\n  ${kws} → ${rp}`
      })
      lines.push(`\n共 ${rules.length} 条 | 控制台「数据库」页可表格管理 | keyword.list <ID> 详情`)
      return lines.join('\n')
    })

  ctx.command('keyword.add <keywords:string> <reply:text>', '添加关键词规则')
    .option('name', '-n <name:string>')
    .option('type', '-t <type:string>')
    .option('matchMode', '-m <mode:string>')
    .action(async ({ session, options }, keywords, reply) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      requireDB()
      const kwList = keywords.split(',').map(s => s.trim()).filter(Boolean)
      if (!kwList.length) return '关键词不能为空（多个用逗号分隔）'
      if (!reply) return '默认回复不能为空'

      await ctx.database.create('keyword_rule', {
        name: options.name || kwList[0],
        keywords: kwList,
        matchMode: options.matchMode || 'contains',
        weekdays: [],
        reply,
        replyType: options.type || 'text',
        groupOverrides: [],
        enabled: true,
      })
      await loadRules(true)
      return `✅ 已添加规则 #${rules.length - 1}: ${options.name || kwList[0]}`
    })

  ctx.command('keyword.edit <id:number> <keywords:string> <reply:text>', '编辑规则')
    .option('name', '-n <name:string>')
    .option('type', '-t <type:string>')
    .option('matchMode', '-m <mode:string>')
    .action(async ({ session, options }, id, keywords, reply) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      requireDB()
      await loadRules(true)
      const rule = rules[id]
      if (!rule) return `未找到规则 #${id}`

      const updates = {}
      if (keywords) updates.keywords = keywords.split(',').map(s => s.trim()).filter(Boolean)
      if (reply) updates.reply = reply
      if (options.name) updates.name = options.name
      if (options.type) updates.replyType = options.type
      if (options.matchMode) updates.matchMode = options.matchMode
      if (!Object.keys(updates).length) return '请指定要修改的内容'

      await ctx.database.set('keyword_rule', rule.id, updates)
      await loadRules(true)
      return `✅ 已更新规则 #${id}: ${rule.name}`
    })

  ctx.command('keyword.remove <id:number>', '删除规则')
    .action(async ({ session }, id) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      requireDB()
      await loadRules(true)
      const rule = rules[id]
      if (!rule) return `未找到规则 #${id}`
      await ctx.database.remove('keyword_rule', rule.id)
      await loadRules(true)
      return `✅ 已删除规则 #${id}: ${rule.name || '未命名'}`
    })

  ctx.command('keyword.toggle <id:number>', '启用/禁用规则')
    .action(async ({ session }, id) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      requireDB()
      await loadRules(true)
      const rule = rules[id]
      if (!rule) return `未找到规则 #${id}`
      const newEnabled = rule.enabled === false
      await ctx.database.set('keyword_rule', rule.id, { enabled: newEnabled })
      await loadRules(true)
      return `${newEnabled ? '✅ 已启用' : '⛔ 已禁用'} 规则 #${id}: ${rule.name || '未命名'}`
    })

  ctx.command('keyword.group <id:number> <group:string> <reply:text>', '设置某群专属回复')
    .option('type', '-t <type:string>')
    .action(async ({ session, options }, id, group, reply) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      requireDB()
      await loadRules(true)
      const rule = rules[id]
      if (!rule) return `未找到规则 #${id}`
      if (!group) return '群号不能为空'
      if (!reply) return '回复内容不能为空'

      const overs = [...(rule.groupOverrides || [])]
      const idx = overs.findIndex(o => o.group === group)
      const ov = { group, reply, replyType: options.type || 'text' }
      if (idx >= 0) overs[idx] = ov
      else overs.push(ov)
      await ctx.database.set('keyword_rule', rule.id, { groupOverrides: overs })
      await loadRules(true)
      return `✅ 规则 #${id} 在群 ${group} 的回复已设置`
    })

  ctx.command('keyword.ungroup <id:number> <group:string>', '移除某群专属回复')
    .action(async ({ session }, id, group) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      requireDB()
      await loadRules(true)
      const rule = rules[id]
      if (!rule) return `未找到规则 #${id}`
      const overs = [...(rule.groupOverrides || [])]
      const idx = overs.findIndex(o => o.group === group)
      if (idx < 0) return `规则 #${id} 没有群 ${group} 的覆盖设置`
      overs.splice(idx, 1)
      await ctx.database.set('keyword_rule', rule.id, { groupOverrides: overs })
      await loadRules(true)
      return `✅ 已移除规则 #${id} 在群 ${group} 的专属回复`
    })

  ctx.command('keyword.raw <id:number>', '查看原始JSON（调试）')
    .action(async ({ session }, id) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      await loadRules(true)
      const rule = rules[id]
      if (!rule) return `未找到规则 #${id}`
      return JSON.stringify(rule, null, 2)
    })

  ctx.command('keyword.test <text:text>', '测试匹配')
    .action(async ({ session }, text) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      if (!text) return '请输入测试文本'

      await loadRules(true)
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
          return `  #${index} ${rule.name || '未命名'} [${flatKeywords(rule.keywords).join(', ')}] → ${eff}`
        }).join('\n')
    })
}

module.exports = { Config, apply, inject }
