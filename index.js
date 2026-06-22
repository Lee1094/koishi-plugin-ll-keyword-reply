const { Schema } = require('koishi')
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

// 规则对象的 Schema 定义（插件设置页 & 命令共用）
const RuleItem = Schema.object({
  name: Schema.string()
    .default('')
    .description('规则名称（用于标识）'),
  keywords: Schema.array(Schema.string())
    .default([])
    .description('关键词列表（多个用逗号分隔）'),
  matchMode: Schema.union(['contains', 'regex'])
    .default('contains')
    .description('匹配模式：contains=包含匹配 / regex=正则匹配'),
  groups: Schema.array(Schema.string())
    .default([])
    .description('生效群号（留空=所有群）'),
  weekdays: Schema.array(Schema.number())
    .default([])
    .description('生效星期 0-6（留空=每天；0=周日 1=周一 … 6=周六）'),
  replyType: Schema.union(['text', 'image'])
    .default('text')
    .description('回复类型：text=文字 / image=图片URL'),
  reply: Schema.string()
    .default('')
    .description('回复内容（文字或图片URL）'),
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
    .description('关键词规则列表（在此配置或使用命令管理）'),
})

function apply(ctx, config) {
  // 加载规则：优先从 JSON 文件（命令写入），首次使用取配置页的初始值
  let rules = loadRules()
  if (rules.length === 0 && config.rules && config.rules.length > 0) {
    rules = config.rules
    saveRules(rules)
  }

  function syncRules() {
    saveRules(rules)
  }

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

    for (const rule of rules) {
      if (!rule.enabled) continue

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
    .action(() => {
      if (!rules.length) return '暂无关键词规则'
      return rules.map((r, i) => {
        const status = r.enabled !== false ? '✅' : '⛔'
        const mode = r.matchMode === 'regex' ? '[正则]' : '[包含]'
        const kws = (r.keywords || []).join(', ')
        const reply = r.replyType === 'image'
          ? `[图片] ${r.reply}`
          : (r.reply || '').substring(0, 40) + ((r.reply || '').length > 40 ? '...' : '')
        return `${status} #${i} ${mode} ${r.name || '未命名'}\n  关键词: ${kws}\n  回复: ${reply}`
      }).join('\n')
    })

  ctx.command('keyword.add <keywords:string> <reply:text>', '添加关键词回复规则')
    .option('name', '-n <name:string>')
    .option('type', '-t <type:string>')
    .option('matchMode', '-m <mode:string>')
    .action(({ session, options }, keywords, reply) => {
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

      rules.push(rule)
      syncRules()
      return `✅ 已添加规则 #${rules.length - 1}: ${rule.name} [${rule.matchMode}]`
    })

  ctx.command('keyword.edit <id:number> <keywords:string> <reply:text>', '编辑关键词规则')
    .option('name', '-n <name:string>')
    .option('type', '-t <type:string>')
    .option('matchMode', '-m <mode:string>')
    .action(({ session, options }, id, keywords, reply) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      const rule = rules[id]
      if (!rule) return `未找到规则 #${id}`

      if (keywords) {
        rule.keywords = keywords.split(',').map(s => s.trim()).filter(Boolean)
      }
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

  ctx.command('keyword.test <text:text>', '测试关键词匹配（显示当前群/星期下会命中的规则）')
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
        if (hit) matched.push({ index: i, rule })
      }

      if (!matched.length) return `"${text}" 没有匹配到任何规则`
      return `"${text}" 匹配到 ${matched.length} 条规则：\n` +
        matched.map(({ index, rule }) => `  #${index} ${rule.name || '未命名'}: ${(rule.keywords || []).join(', ')}`).join('\n')
    })
}

module.exports = { Config, apply }
