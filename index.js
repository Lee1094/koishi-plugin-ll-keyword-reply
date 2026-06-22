const { Schema } = require('koishi')

const Config = Schema.object({
  admins: Schema.array(Schema.string())
    .default([])
    .description('管理员QQ号（留空则所有人可用管理命令）'),
})

const RuleFields = {
  id: 'unsigned',
  name: 'string',
  keywords: 'list',
  matchMode: 'string',   // 'contains' | 'regex'
  groups: 'list',        // 生效群号，空=所有群
  weekdays: 'list',      // 0-6，空=每天
  replyType: 'string',   // 'text' | 'image'
  reply: 'text',
  enabled: 'boolean',
}

function apply(ctx, config) {
  // 注册数据表 → 控制台数据库页可管理
  ctx.model.extend('keyword_rule', RuleFields, { autoInc: true })

  function isAdmin(userId) {
    if (!config.admins || config.admins.length === 0) return true
    return config.admins.includes(String(userId))
  }

  // ===== 中间件：拦截消息，匹配规则 =====
  ctx.middleware(async (session, next) => {
    const text = session.content?.trim()
    if (!text) return next()

    const today = new Date().getDay()  // 0=周日
    const groupId = session.guildId ? String(session.guildId) : ''

    const rules = await ctx.database.get('keyword_rule', { enabled: { $ne: false } })

    for (const rule of rules) {
      // 星期过滤
      if (rule.weekdays && rule.weekdays.length > 0) {
        if (!rule.weekdays.includes(today)) continue
      }

      // 群过滤
      if (rule.groups && rule.groups.length > 0) {
        if (!rule.groups.includes(groupId)) continue
      }

      // 关键词匹配
      const matched = (rule.keywords || []).some(kw => {
        if (!kw) return false
        if (rule.matchMode === 'regex') {
          try {
            return new RegExp(kw).test(text)
          } catch { return false }
        }
        return text.includes(kw)
      })

      if (!matched) continue

      // 发送回复
      if (rule.replyType === 'image') {
        await session.send(`[CQ:image,file=${rule.reply}]`)
      } else {
        await session.send(rule.reply)
      }
      return // 命中一个规则即停止
    }

    return next()
  })

  // ===== 管理命令 =====
  ctx.command('keyword', '关键词回复管理')
    .action(() =>
      '关键词回复管理命令：\n' +
      'keyword.list — 查看所有规则\n' +
      'keyword.add <关键词> <回复> — 添加规则\n' +
      'keyword.edit <ID> <关键词> <回复> — 编辑规则\n' +
      'keyword.remove <ID> — 删除规则\n' +
      'keyword.toggle <ID> — 启用/禁用规则\n' +
      'keyword.test <文本> — 测试匹配'
    )

  ctx.command('keyword.list', '查看所有关键词规则')
    .action(async () => {
      const rules = await ctx.database.get('keyword_rule', {})
      if (!rules.length) return '暂无关键词规则'
      return rules.map(r => {
        const status = r.enabled !== false ? '✅' : '⛔'
        const mode = r.matchMode === 'regex' ? '[正则]' : '[包含]'
        const kws = (r.keywords || []).join(', ')
        const reply = r.replyType === 'image'
          ? `[图片] ${r.reply}`
          : (r.reply || '').substring(0, 40) + ((r.reply || '').length > 40 ? '...' : '')
        return `${status} #${r.id} ${mode} ${r.name || '未命名'}\n  关键词: ${kws}\n  回复: ${reply}`
      }).join('\n')
    })

  ctx.command('keyword.add <keywords:string> <reply:text>', '添加关键词回复规则')
    .option('name', '-n <name:string>')
    .option('type', '-t <type:string>')
    .option('matchMode', '-m <mode:string>')
    .action(async ({ session, options }, keywords, reply) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      const kwList = keywords.split(',').map(s => s.trim()).filter(Boolean)
      if (!kwList.length) return '关键词不能为空（多个用逗号分隔）'
      if (!reply) return '回复内容不能为空'

      const rule = {
        name: options.name || kwList[0],
        keywords: kwList,
        matchMode: options.matchMode || 'contains',
        groups: [],
        weekdays: [],
        replyType: options.type || 'text',
        reply,
        enabled: true,
      }

      await ctx.database.create('keyword_rule', rule)
      return `✅ 已添加规则: ${rule.name} [${rule.matchMode}]`
    })

  ctx.command('keyword.edit <id:number> <keywords:string> <reply:text>', '编辑关键词规则')
    .option('name', '-n <name:string>')
    .option('type', '-t <type:string>')
    .option('matchMode', '-m <mode:string>')
    .action(async ({ session, options }, id, keywords, reply) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      const [rule] = await ctx.database.get('keyword_rule', { id })
      if (!rule) return `未找到ID为 ${id} 的规则`

      const updates = {}
      if (keywords) {
        updates.keywords = keywords.split(',').map(s => s.trim()).filter(Boolean)
      }
      if (reply) updates.reply = reply
      if (options.name) updates.name = options.name
      if (options.type) updates.replyType = options.type
      if (options.matchMode) updates.matchMode = options.matchMode

      if (!Object.keys(updates).length) return '请指定要修改的内容'
      await ctx.database.set('keyword_rule', { id }, updates)
      return `✅ 已更新规则 #${id}`
    })

  ctx.command('keyword.remove <id:number>', '删除关键词规则')
    .action(async ({ session }, id) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      const count = await ctx.database.remove('keyword_rule', { id })
      if (!count) return `未找到ID为 ${id} 的规则`
      return `✅ 已删除规则 #${id}`
    })

  ctx.command('keyword.toggle <id:number>', '启用/禁用关键词规则')
    .action(async ({ session }, id) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      const [rule] = await ctx.database.get('keyword_rule', { id })
      if (!rule) return `未找到ID为 ${id} 的规则`
      const newState = rule.enabled === false
      await ctx.database.set('keyword_rule', { id }, { enabled: newState })
      return `${newState ? '✅ 已启用' : '⛔ 已禁用'} 规则 #${id}`
    })

  ctx.command('keyword.test <text:text>', '测试关键词匹配（显示当前群/星期下会命中的规则）')
    .action(async ({ session }, text) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      if (!text) return '请输入测试文本'

      const today = new Date().getDay()
      const groupId = session.guildId ? String(session.guildId) : ''
      const rules = await ctx.database.get('keyword_rule', { enabled: { $ne: false } })
      const matched = []

      for (const rule of rules) {
        if (rule.weekdays && rule.weekdays.length > 0) {
          if (!rule.weekdays.includes(today)) continue
        }
        if (rule.groups && rule.groups.length > 0) {
          if (!rule.groups.includes(groupId)) continue
        }
        const hit = (rule.keywords || []).some(kw => {
          if (!kw) return false
          if (rule.matchMode === 'regex') {
            try { return new RegExp(kw).test(text) } catch { return false }
          }
          return text.includes(kw)
        })
        if (hit) matched.push(rule)
      }

      if (!matched.length) return `"${text}" 没有匹配到任何规则`
      return `"${text}" 匹配到 ${matched.length} 条规则：\n` +
        matched.map(r => `  #${r.id} ${r.name}: ${(r.keywords || []).join(', ')}`).join('\n')
    })
}

module.exports = { Config, apply }
