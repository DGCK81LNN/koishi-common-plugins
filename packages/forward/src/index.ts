import { Command, Context, Dict, Schema, segment, Session, Time } from 'koishi'
import type {} from '@koishijs/assets'

declare module 'koishi' {
  interface Channel {
    forward: string[]
  }
}

export interface Rule {
  source: string
  target: string
  selfId: string
  guildId?: string
}

export const Rule: Schema<Rule> = Schema.object({
  source: Schema.string().required().description('来源频道。'),
  target: Schema.string().required().description('目标频道。'),
  selfId: Schema.string().required().description('负责推送的机器人账号。'),
  guildId: Schema.string().required().description('目标频道的群组编号。'),
}).description('转发规则。')

export const name = 'forward'

export const inject = {
  optional: ['database', 'assets']
}

export interface MutationHandling {
  onEdit: 'announce' | 'none'
  onDelete: 'delete' | 'announce' | 'none'
}

export const MutationHandling: Schema<MutationHandling> = Schema.object({
  onEdit: Schema.union([
    // Schema.const('edit' as const).description('编辑'),
    Schema.const('announce' as const).description('宣告'),
    Schema.const('none' as const).description('忽略'),
  ]).description('消息被编辑时的行为。').default('announce'),
  onDelete: Schema.union([
    Schema.const('delete' as const).description('删除（撤回）'),
    // Schema.const('edit' as const).description('编辑'),
    Schema.const('announce' as const).description('宣告'),
    Schema.const('none' as const).description('忽略'),
  ]).description('消息被删除（撤回）时的行为。若“删除（撤回）”失败，会回退至“宣告”。').default('delete'),
})

export interface Config {
  mode?: 'database' | 'config'
  rules?: Rule[]
  replyTimeout?: number
  defaultMutationHandling: MutationHandling
  platformMutationHandling: Dict<MutationHandling>
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    mode: Schema.union([
      Schema.const('database' as const).description('数据库'),
      Schema.const('config' as const).description('配置文件'),
    ])
      .default('config')
      .description('转发规则的存储方式。'),
  }),
  Schema.union([
    Schema.object({
      mode: Schema.const('config' as const),
      rules: Schema.array(Rule).description('转发规则列表。'),
    }),
    Schema.object({}),
  ] as const),
  Schema.object({
    replyTimeout: Schema.natural()
      .role('ms')
      .default(Time.hour)
      .description('转发消息不再响应回复的时间。'),
    platformMutationHandling: Schema.dict(
      MutationHandling.description('目标平台名。')
    ).description('分平台指定消息变更时的行为。'),
    defaultMutationHandling: MutationHandling.description('消息变更时的默认行为。'),
  }),
] as const)

interface Msg {
  platform: string
  channelId: string
  guildId: string
  messageId: string
  messageIds?: string[]
  selfId?: string
}

interface TransformContentInfo {
  platform: string
  channelId: string
}

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh-CN', require('./locales/zh-CN'))

  const relayMap: Dict<Rule> = Object.create(null)
  const msgMap: Dict<Msg[]> = Object.create(null)

  async function transformContent(
    session: Session,
    { platform, channelId }: TransformContentInfo
  ) {
    let { author, content, quote } = session
    const userNicknames = Object.create(null)
    // replace all mentions (koishijs/koishi#506)
    if (segment.select(content, "at").length) {
      content = await segment.transformAsync(content, {
        async at(attrs) {
          if (!attrs.id) return true
          if (!(attrs.id in userNicknames)) {
            const gm = await session.bot
              .getGuildMember(session.guildId, attrs.id)
              .catch(() => null)
            userNicknames[attrs.id] =
              gm?.nick || gm?.user?.nick || gm?.user?.name || attrs.id
          }
          return segment("i", "@" + userNicknames[attrs.id])
        },
      })
    }

    if (ctx.assets) content = await ctx.assets.transform(content)
    const member = session.event.member
    let inspectedMember: typeof member
    const authorName =
      userNicknames[author.id] ||
      member?.nick ||
      (inspectedMember = await session.bot
        .getGuildMember(session.guildId, author.id)
        .catch(() => null))?.nick ||
      member?.user?.nick ||
      inspectedMember?.user?.nick ||
      member?.user?.name ||
      inspectedMember?.user?.name ||
      author.id
    let quoteEl: segment | string = ""
    if (quote) {
      const msg = msgMap[`${session.channelId}:${quote.id}`]?.find(
        msg => msg.platform === platform && msg.channelId === channelId
      )
      if (msg) {
        quoteEl = segment.quote(msg.messageId)
      } else if (quote.content) {
        const content =
          quote.user.id === session.selfId &&
          segment("", quote.elements)
            .toString(true)
            .match(/^❝*\s*\u2068.*?\u2069: \u2068/) !== null
            ? quote.content
            : `<b>\u2068${
                quote.member?.nick ||
                quote.user?.nick ||
                quote.member?.name ||
                quote.user?.name ||
                quote.user?.id ||
                "[???]"
              }\u2069:</b> \u2068${quote.content}`
        quoteEl = `<p>❝${content}</p><p>==========</p><p/>`
      }
    }
    return `${quoteEl}<b>\u2068${authorName}\u2069:</b> \u2068${content}`
  }

  async function sendRelay(session: Session<never, 'forward'>, rule: Partial<Rule>) {
    if (!session.content) return

    try {
      // get selfId
      const platform = rule.target.split(':', 1)[0]
      const channelId = rule.target.slice(platform.length + 1)
      if (!rule.selfId) {
        const channel = await ctx.database.getChannel(platform, channelId, ['assignee', 'guildId'])
        if (!channel || !channel.assignee) return
        rule.selfId = channel.assignee
        rule.guildId = channel.guildId
      }

      const bot = ctx.bots[`${platform}:${rule.selfId}`]

      const content = await transformContent(session, { platform, channelId })
      const ids = await bot.sendMessage(channelId, content, rule.guildId)
      if (ids.length) {
        const cmid = `${session.channelId}:${session.messageId}`
        if (!msgMap[cmid]) {
          msgMap[cmid] = []
          ctx.setTimeout(() => delete msgMap[cmid], config.replyTimeout)
        }
        msgMap[cmid].push({
          platform,
          channelId,
          guildId: rule.guildId,
          messageId: ids[0],
          messageIds: ids,
          selfId: rule.selfId,
        })
      }
      for (const id of ids) {
        relayMap[`${channelId}:${id}`] = {
          source: rule.target,
          target: session.cid,
          selfId: session.selfId,
          guildId: session.guildId,
        }
        msgMap[`${channelId}:${id}`] = [{
          platform: session.platform,
          channelId: session.channelId,
          guildId: session.guildId,
          messageId: session.messageId,
          selfId: session.selfId,
        }]
        ctx.setTimeout(() => {
          delete relayMap[`${channelId}:${id}`]
          delete msgMap[`${channelId}:${id}`]
        }, config.replyTimeout)
      }
    } catch (error) {
      ctx.logger('forward').warn(error)
    }
  }

  ctx.middleware(async (session: Session<never, 'forward'>, next) => {
    const { quote = {}, isDirect } = session
    if (isDirect) return next()
    const data = relayMap[`${session.channelId}:${quote.id}`]
    if (data) return sendRelay(session, data)

    const tasks: Promise<void>[] = []
    if (config.mode === 'config') {
      for (const rule of config.rules) {
        if (session.cid !== rule.source) continue
        tasks.push(sendRelay(session, rule))
      }
    } else if (ctx.database) {
      for (const target of getTargets(session)) {
        tasks.push(sendRelay(session, { target }))
      }
    }
    const [result] = await Promise.all([next(), ...tasks])
    return result
  })

  function createMutationHandler(callback: (data: { session: Session } & Msg & MutationHandling) => void) {
    return (session: Session) => {
      const msgs = msgMap[`${session.channelId}:${session.messageId}`]?.filter(
        msg => msg.messageIds
      )
      if (!msgs?.length) return
      for (const msg of msgs) {
        ctx.logger.debug({ config, msg })
        const handling = Object.hasOwn(config.platformMutationHandling, msg.platform)
          && config.platformMutationHandling[msg.platform]
          || config.defaultMutationHandling
        callback({ session, ...msg, ...handling })
      }
    }
  }

  ctx.on(
    "message-updated",
    createMutationHandler(
      async ({ session, platform, channelId, guildId, selfId, messageId, messageIds, onEdit }) => {
        const bot = ctx.bots[`${platform}:${selfId}`]
        if (!bot) return
        if (onEdit === "announce") try {
          const announcement = `${segment.quote(messageId)}✏️${await transformContent(session, { platform, channelId })}`
          const ids = await bot.sendMessage(channelId, announcement, guildId)
          messageIds.push(...ids)
          // had to add the announcement message to the mappings but this approach is kinda evil FIXME perhaps
          for (const id of ids) {
            relayMap[`${channelId}:${id}`] = {
              source: `${platform}:${channelId}`,
              target: session.cid,
              selfId: session.selfId,
              guildId: session.guildId,
            }
            msgMap[`${channelId}:${id}`] = [{
              platform: session.platform,
              channelId: session.channelId,
              guildId: session.guildId,
              messageId: session.messageId,
              selfId: session.selfId,
            }]
            ctx.setTimeout(() => {
              delete relayMap[`${channelId}:${id}`]
              delete msgMap[`${channelId}:${id}`]
            }, config.replyTimeout)
          }
        } catch (e) {
          ctx.logger.warn(e)
        }
      }
    )
  )

  ctx.on(
    "message-deleted",
    createMutationHandler(
      async ({ platform, channelId, guildId, selfId, messageIds, onDelete }) => {
        const bot = ctx.bots[`${platform}:${selfId}`]
        if (!bot) return
        ctx.logger.debug("%o", onDelete)
        if (onDelete === "delete") try {
          messageIds = messageIds.slice(0)
          while (messageIds.length) {
            await bot.deleteMessage(channelId, messageIds[0])
            messageIds.shift()
          }
          return
        } catch (e) {
          ctx.logger.warn(e)
        }
        if (onDelete !== "none") try {
          const announcement = `${segment.quote(messageIds[0])}💬\u2060🗑️`
          await bot.sendMessage(channelId, announcement, guildId)
        } catch (e) {
          ctx.logger.warn(e)
        }
      }
    )
  )

  ctx.model.extend('channel', {
    forward: 'list',
  })

  ctx.before('attach-channel', (session, fields) => {
    fields.add('forward')
  })

  if (config.mode === 'database') {
    ctx.inject(['database'], commands)
    // TODO support config mode
    // } else if (ctx.loader?.writable) {
    //   ctx.plugin(commands)
  }

  function getTargets(session: Session<never, 'forward'>) {
    if (config.mode === 'database') {
      return session.channel.forward
    }

    return config.rules
      .filter(rule => rule.source === session.cid)
      .map(rule => rule.target)
  }

  function commands(ctx: Context) {
    const cmd = ctx
      .command('forward', { authority: 3 })
      .alias('fwd')

    const register = (def: string, callback: Command.Action<never, 'forward', [string]>) => cmd
        .subcommand(def, { authority: 3, checkArgCount: true })
        .channelFields(['forward'])
        .action(callback)

    register('.add <channel:channel>', async ({ session }, id) => {
      const targets = getTargets(session)
      if (targets.includes(id)) {
        return session.text('.unchanged', [id])
      } else {
        targets.push(id)
        return session.text('.updated', [id])
      }
    })

    register('.remove <channel:channel>', async ({ session }, id) => {
      const targets = getTargets(session)
      const index = targets.indexOf(id)
      if (index >= 0) {
        targets.splice(index, 1)
        return session.text('.updated', [id])
      } else {
        return session.text('.unchanged', [id])
      }
    }).alias('forward.rm')

    register('.clear', async ({ session }) => {
      session.channel.forward = []
      return session.text('.updated')
    })

    register('.list', async ({ session }) => {
      const targets = getTargets(session)
      if (!targets.length) return session.text('.empty')
      return [session.text('.header'), ...targets].join('\n')
    }).alias('forward.ls')
  }
}
