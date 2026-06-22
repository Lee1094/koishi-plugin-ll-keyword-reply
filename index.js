const { Schema, h } = require('koishi')
const fs = require('fs')
const path = require('path')

const RULES_FILE = path.join(__dirname, 'rules.json')

function loadRules() {
  try {
    if (fs.existsSync(RULES_FILE)) {
      return JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'))
    }
  } catch {}
  return []
}

function saveRules(rules) {
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf-8')
}

// 按群覆盖回复
const GroupOverride = Schema.object({
  group: Schema.string()
    .description('群号'),
  reply: Schema.string()
    .default('')
    .description('该群的回复内容'),
  replyType: Schema.union(['text', 'image'])
    .default('text')
    .description('该群的回复类型'),
})

// 规则对象 Schema（插件设置页可见全部字段）
const RuleItem = Schema.object({
  name: Schema.string()
    .default('')
    .description('规则名称'),
  keywords: Schema.array(Schema.string())
    .default([])
    .description('关键词列表（多个用逗号分隔）'),
  matchMode: Schema.union(['contains', 'regex'])
    .default('contains')
    .description('匹配模式'),
  weekdays: Schema.array(Schema.number())
    .default([])
    .description('生效星期 0-6（留空=每天）'),
  reply: Schema.string()
    .default('')
    .description('默认回复（所有群通用，留空则只对 groupOverrides 中的群生效）'),
  replyType: Schema.union(['text', 'image'])
    .default('text')
    .description('默认回复类型'),
  groupOverrides: Schema.array(GroupOverride)
    .default([])
    .description('特定群的回复（优先级高于默认回复）'),
  enabled: Schema.boolean()
    .default(true)
    .description('是否启用'),
})

const Config = Schema.object({
  admins: Schema.array(Schema.string())
    .default([])
    .description('管理员QQ号（留空则所有人可用管理命令）'),
  rules: Schema.array(RuleItem)
    .default([])
    .description('关键词规则列表'),
})

function apply(ctx, config) {
  let rules = loadRules()
  // 设置页编辑时同步到 JSON：config 中数量 ≥ JSON 则以 config 为准
  if (config.rules && config.rules.length >= rules.length) {
    rules = config.rules
    saveRules(rules)
  }

  // 展开关键词（兼容数组/字符串、逗号分隔等各种格式）
  function flatKeywords(keywords) {
    if (!keywords) return []
    // 兼容字符串（设置页 YAML 可能存成字符串而非数组）
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

  function syncRules() {
    saveRules(rules)
  }

  function isAdmin(userId) {
    if (!config.admins || config.admins.length === 0) return true
    return config.admins.includes(String(userId))
  }

  // 获取某条规则在指定群的实际回复（覆盖 > 默认）
  function getReply(rule, groupId) {
    const override = (rule.groupOverrides || []).find(o => o.group === groupId)
    if (override && override.reply) {
      return { reply: override.reply, replyType: override.replyType || 'text' }
    }
    return { reply: rule.reply, replyType: rule.replyType || 'text' }
  }

  // ===== message 事件（在中间件链之前触发，不会被其他插件拦截）=====
  ctx.on('message', async (session) => {
    // 跳过机器人自己的消息
    if (session.userId === session.bot?.selfId) return
    // 去掉所有 CQ 码
    let text = (session.content || '').replace(/\[CQ:[^\]]*\]/g, '').trim()
    if (!text) return

    const today = new Date().getDay()
    const groupId = session.guildId ? String(session.guildId) : ''

    for (const rule of rules) {
      if (!rule.enabled) continue

      // 星期过滤
      if (rule.weekdays && rule.weekdays.length > 0) {
        if (!rule.weekdays.includes(today)) continue
      }

      // 关键词匹配
      const keywords = flatKeywords(rule.keywords)
      const matched = keywords.some(kw => {
        if (rule.matchMode === 'regex') {
          try { return new RegExp(kw).test(text) } catch { return false }
        }
        return text.includes(kw)
      })
      if (!matched) continue

      // 获取实际回复（按群覆盖）
      const { reply, replyType } = getReply(rule, groupId)
      if (!reply) continue

      // 发送
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

  // ===== 命令 =====
  ctx.command('keyword', '关键词回复管理')
    .action(() =>
      '关键词回复管理命令：\n' +
      'keyword.list [ID] — 查看规则列表/详情\n' +
      'keyword.add <关键词> <默认回复> — 添加规则\n' +
      'keyword.edit <ID> <关键词> <默认回复> — 编辑规则\n' +
      'keyword.remove <ID> — 删除规则\n' +
      'keyword.toggle <ID> — 启用/禁用\n' +
      'keyword.group <ID> <群号> <回复> — 设置某群的专属回复\n' +
      'keyword.ungroup <ID> <群号> — 移除某群的专属回复\n' +
      'keyword.test <文本> — 测试匹配\n' +
      'keyword.raw <ID> — 查看原始JSON'
    )

  ctx.command('keyword.list [id:number]', '查看所有规则 / 指定ID查看详情')
    .action(({ session }, id) => {
      if (!rules.length) return '暂无关键词规则'

      // 查看单个规则详情
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

      // 列表视图
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
      lines.push(`\n共 ${rules.length} 条规则 | keyword.list <ID> 查看详情`)
      return lines.join('\n')
    })

  ctx.command('keyword.add <keywords:string> <reply:text>', '添加关键词规则（所有群默认回复）')
    .option('name', '-n <name:string>')
    .option('type', '-t <type:string>')
    .option('matchMode', '-m <mode:string>')
    .action(({ session, options }, keywords, reply) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      const kwList = keywords.split(',').map(s => s.trim()).filter(Boolean)
      if (!kwList.length) return '关键词不能为空（多个用逗号分隔）'
      if (!reply) return '默认回复不能为空'

      const rule = {
        name: options.name || kwList[0],
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
      return `✅ 已添加规则 #${rules.length - 1}: ${rule.name} [${rule.matchMode}]`
    })

  ctx.command('keyword.edit <id:number> <keywords:string> <reply:text>', '编辑规则的默认关键词和回复')
    .option('name', '-n <name:string>')
    .option('type', '-t <type:string>')
    .option('matchMode', '-m <mode:string>')
    .action(({ session, options }, id, keywords, reply) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      const rule = rules[id]
      if (!rule) return `未找到规则 #${id}`
      if (keywords) rule.keywords = keywords.split(',').map(s => s.trim()).filter(Boolean)
      if (reply) rule.reply = reply
      if (options.name) rule.name = options.name
      if (options.type) rule.replyType = options.type
      if (options.matchMode) rule.matchMode = options.matchMode
      syncRules()
      return `✅ 已更新规则 #${id}: ${rule.name}`
    })

  ctx.command('keyword.remove <id:number>', '删除关键词规则')
    .action(({ session }, id) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      if (id < 0 || id >= rules.length) return `未找到规则 #${id}`
      const name = rules[id].name || '未命名'
      rules.splice(id, 1)
      syncRules()
      return `✅ 已删除规则 #${id}: ${name}`
    })

  ctx.command('keyword.toggle <id:number>', '启用/禁用关键词规则')
    .action(({ session }, id) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      const rule = rules[id]
      if (!rule) return `未找到规则 #${id}`
      rule.enabled = !rule.enabled
      syncRules()
      return `${rule.enabled ? '✅ 已启用' : '⛔ 已禁用'} 规则 #${id}: ${rule.name || '未命名'}`
    })

  ctx.command('keyword.group <id:number> <group:string> <reply:text>', '为某条规则设置特定群的专属回复')
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
      if (idx >= 0) {
        rule.groupOverrides[idx] = ov
      } else {
        rule.groupOverrides.push(ov)
      }
      syncRules()
      return `✅ 规则 #${id} 在群 ${group} 的回复已设为: ${reply.substring(0, 30)}`
    })

  ctx.command('keyword.ungroup <id:number> <group:string>', '移除某条规则在特定群的专属回复')
    .action(({ session }, id, group) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      const rule = rules[id]
      if (!rule) return `未找到规则 #${id}`
      if (!rule.groupOverrides) return `规则 #${id} 没有群覆盖设置`
      const idx = rule.groupOverrides.findIndex(o => o.group === group)
      if (idx < 0) return `规则 #${id} 没有群 ${group} 的覆盖设置`
      rule.groupOverrides.splice(idx, 1)
      syncRules()
      return `✅ 已移除规则 #${id} 在群 ${group} 的专属回复，恢复使用默认回复`
    })

  ctx.command('keyword.raw <id:number>', '查看规则原始数据（调试用）')
    .action(({ session }, id) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      const rule = rules[id]
      if (!rule) return `未找到规则 #${id}`
      return JSON.stringify(rule, null, 2)
    })

  ctx.command('keyword.test <text:text>', '测试关键词匹配')
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
          return `  #${index} ${rule.name || '未命名'} [${(rule.keywords || []).join(', ')}] → ${eff}`
        }).join('\n')
    })
}

module.exports = { Config, apply }
