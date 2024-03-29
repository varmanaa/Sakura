import { ENVIRONMENT, INVITE_CHECK_COOLDOWN } from '#config'
import { SakuraCommand } from '#structures'
import { CategoryCounts } from '#types'
import { extractCodes, fetchInvite, isNewsOrTextChannel } from '#utils'
import type { GuildBasedChannelTypes } from '@sapphire/discord.js-utilities'
import { type ApplicationCommandRegistry, UserError, RegisterBehavior } from '@sapphire/framework'
import { type CategoryChannel, type CommandInteraction, type CommandInteractionOptionResolver, Formatters, type MessageEmbed, type NewsChannel, Permissions, type TextChannel } from 'discord.js'
import { hrtime } from 'node:process'
import prettyMilliseconds from 'pretty-ms'


export class CheckCommand extends SakuraCommand {
	public override registerApplicationCommands(registry: ApplicationCommandRegistry) {
		registry.registerChatInputCommand({
			description: 'Runs an invite check',
			name: this.name
		}, {
            behaviorWhenNotIdentical: RegisterBehavior.Overwrite,
			guildIds: ENVIRONMENT === 'development' ? ['903369282518396988'] : []
		})
	}

    public async chatInputRun(interaction: CommandInteraction) {
        const { client, database, queue } = this.container
        const guildId = BigInt(interaction.guildId)
        const { categoryChannelIds, resultsChannelId, embedColor, ignoredChannelIds, inCheck, lastCheck = new Date } = database.readSetting(guildId)
        const now = Date.now()
        const checkCounts: CategoryCounts[] = []

        await interaction.deferReply()
        
        if (now <= (lastCheck?.getTime() ?? 0) + INVITE_CHECK_COOLDOWN) {
            const seconds = Math.floor(((lastCheck?.getTime() ?? 0) + INVITE_CHECK_COOLDOWN) / 1000)
            throw new UserError({ identifier: null, message: `You may run an invite check again on ${ Formatters.time(seconds) } (${ Formatters.time(seconds, 'R') })` })
        }
        if (!resultsChannelId)
            throw new UserError({ identifier: null, message: 'No check channel has been set for this guild. Please set one before running an invite check.' })
        if (resultsChannelId !== BigInt(interaction.channelId))
            throw new UserError({ identifier: null, message: `This command can only be run in <#${ resultsChannelId }>.` })
        if (!categoryChannelIds.length)
            throw new UserError({ identifier: null, message: 'There are no categories to check. Please add some before running an invite check.' })
        if (inCheck)
            throw new UserError({ identifier: null, message: `${ client.user.username } is currently running an invite check in this server. Another one may not be started.` })

        const knownInvites = await database.readGuildInvites(guildId)
        const haveAllInvitesBeenChecked = [...knownInvites.values()].every(invite => invite.isChecked)

        if (!haveAllInvitesBeenChecked)
            throw new UserError({ identifier: null, message: `${ client.user.username } is still checking categories for this guild. Please try again at a later time.` })

        const haveAllInvitesBeenUpdated = [...knownInvites.values()].every(({ isValid, updatedAt }) => (isValid && lastCheck) ? (updatedAt > lastCheck) : true)

        if (!haveAllInvitesBeenUpdated)
            throw new UserError({ identifier: null, message: 'All invites have not been updated since your last invite check. Please try again at a later time.' })
       
        const { channel: resultsChannel, guild } = interaction

        await database.updateSetting(guildId, { inCheck: true })
        await database.createAuditEntry('INVITE_CHECK_START', { guildId: interaction.guildId })

        const timerStart = hrtime.bigint()
        const startEmbed: Partial<MessageEmbed> = { color: embedColor, description: `${ client.user.username } is checking your invites now!` }

        await interaction.editReply({ embeds: [startEmbed] })    
        
        const isAddedCategoryChannel = (channel: GuildBasedChannelTypes): channel is CategoryChannel => (channel.type === 'GUILD_CATEGORY') && categoryChannelIds.includes(BigInt(channel.id))
        const sortedCategoriesToCheck = guild.channels.cache
            .filter(isAddedCategoryChannel)
            .sort((c1, c2) => c1.position - c2.position)
        const shouldCheckChannel = (channel: GuildBasedChannelTypes): channel is NewsChannel | TextChannel => isNewsOrTextChannel(channel) && !ignoredChannelIds.includes(BigInt(channel.id))
        const { me } = interaction.guild

        for (const { children, name } of sortedCategoriesToCheck.values()) {
            const counts: CategoryCounts = { channels: [], issues: 0, manual: [], name }
            const channelsToCheck = children
                .filter(shouldCheckChannel)
                .sort((c1, c2) => c1.position - c2.position)

            if (!channelsToCheck.size) {
                const emptyCategoryEmbed = this.formatCategoryEmbed(counts, embedColor)
                await resultsChannel.send({ embeds: [emptyCategoryEmbed] })
                continue
            }

            for (const channel of channelsToCheck.values()) {
				if (!channel) {
					counts.issues++
					continue
				}
                const channelId = channel.id

                if(!channel.permissionsFor(me).has(this.minimumPermissions)) {
					counts.manual.push(channelId)
					continue
                }			
                if (!channel.lastMessageId) {
                    counts.channels.push({ bad: 0, channelId, good: 0 })
                    continue
                }

				const messages = await channel.messages.fetch({ limit: 10 })

				if (!messages.size) {
					counts.manual.push(channelId)
					continue
				}

				const foundCodes = extractCodes(messages, false)
				let bad = 0, good = 0

				for (const code of foundCodes) {
                    const knownInvite = knownInvites.get(code)
                    let isValid: boolean

                    if (knownInvite?.isChecked)
                        isValid = knownInvite.isValid && (knownInvite.isPermanent || (now < (knownInvite?.expiresAt?.getTime() ?? 0)))
                    else {
                        const invite = await queue.add(fetchInvite(code), { priority: 1 })
                        const expiresAt = invite?.expiresAt ?? null
                        const isPermanent = !Boolean(expiresAt) && !Boolean(invite?.maxAge) && !Boolean(invite?.maxUses)

                        isValid = Boolean(invite)

                        if (knownInvite)
                            await database.updateInvite(knownInvite.id, expiresAt, isPermanent, isValid)
                        else
                            await database.insertInvite(guildId, code, expiresAt, isPermanent, isValid)
                            
                    }

                    if (isValid)
                        good++
                    else
                        bad++
                }		
					
				counts.channels.push({ bad, channelId, good })
            }

			checkCounts.push(counts)
			const categoryEmbed = this.formatCategoryEmbed(counts, embedColor)
			await resultsChannel.send({ embeds: [categoryEmbed] })  
        }

        const timerEnd = hrtime.bigint()
        const elapsedTime = timerEnd - timerStart
		const endEmbed: Partial<MessageEmbed> = { color: embedColor, description: 'Invite check complete!' }
        const { totalBad, totalChannels, totalGood, totalInvites } = this.count(checkCounts)
		const resultsEmbed = this.formatResultsEmbed(totalBad, totalChannels, totalGood, totalInvites, elapsedTime, embedColor)
		
		await resultsChannel.send({ embeds: [endEmbed, resultsEmbed] })
        await database.updateSetting(guildId, { inCheck: false, lastCheck: new Date }) 
        await database.createAuditEntry('INVITE_CHECK_FINISH', { elapsedTime: Number(elapsedTime / BigInt(1e6)), guildId: interaction.guildId, totalBad, totalChannels, totalGood, totalInvites })
    }

    private count(categories: CategoryCounts[]) {
        let totalBad = 0, totalChannels = 0, totalGood = 0

        for (const { channels, issues, manual } of categories) {
            totalChannels += channels.length + issues + manual.length

			if (!channels.length)
				continue

            for (const { bad, good } of channels) {
                totalBad += bad
                totalGood += good
            }
        }

        return { totalBad, totalChannels, totalGood, totalInvites: totalBad + totalGood }
    }

	private formatCategoryEmbed({ channels, issues, manual, name}: CategoryCounts, color: number) {
        const embed: Partial<MessageEmbed> = {
            color,
            footer: { text: `Checked ${ channels.length ? 10 : 0 } messages` },
            timestamp: Number(new Date),
            title: `The "${ name }" category`
		}

        embed.description = (channels.length)
            ? channels.map(({ bad, channelId, good }) => `${ bad ? '🔴' : '🟢' } <#${ channelId }> - **${ bad + good }** total ${ bad ? `(**${ bad }** bad)` : '' }`).join('\n')
            : 'No channels to check in this category.'

		if (issues) {
			embed.fields ??= []
			embed.fields.push({ inline: false, name: 'Issues', value: `- ${ issues } channel(s) could not be checked.` })
		}
		if (manual.length) {
			embed.fields ??= []
			embed.fields.push({ inline: false, name: 'Manual check(s) required', value: manual.map(channelId => `- <#${ channelId }>`).join('\n') })
		}

		return embed
	}

    private formatResultsEmbed(totalBad: number, totalChannels: number, totalGood: number, totalInvites: number, elapsedTime: bigint, color: number) {   
        const embed: Partial<MessageEmbed> = {
            color,
            fields: [
                { inline: false, name: 'Elapsed time', value: prettyMilliseconds(Number(elapsedTime / BigInt(1e6)), { secondsDecimalDigits: 0, separateMilliseconds: true }) },
                {
                    inline: false,
                    name: 'Stats',
                    value: [
                        `- **${ totalChannels }** channels checked`,
                        `- **${ totalInvites }** invites checked`,
                        `- **${ totalBad }** (${ (100 * totalBad / totalInvites).toFixed(2) }%) invalid invites`,
                        `- **${ totalGood }** (${ (100 * totalGood / totalInvites).toFixed(2) }%) valid invites`                        
                    ].join('\n')
                }
            ],
            timestamp: Number(new Date),
            title: 'Invite check results'
        }

        return embed
    }

    private readonly minimumPermissions = new Permissions(['READ_MESSAGE_HISTORY', 'VIEW_CHANNEL']).freeze()
}