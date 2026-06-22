const { Schema } = require('koishi')

const Config = Schema.object({})

// 数据表字段定义
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

function apply(ctx) {
  // 注册数据表 → 控制台自动出现增删改查界面
  ctx.model.extend('keyword_rule', RuleFields, {
    autoInc: true,
  })

  // 中间件：拦截消息，匹配规则
  ctx.middleware(async (session, next) => {
    const text = session.content?.trim()
    if (!text) return next()

    const today = new Date().getDay()  // 0=周日
    const groupId = session.guildId ? String(session.guildId) : ''

    // 查所有启用的规则
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
}

module.exports = { Config, apply }
