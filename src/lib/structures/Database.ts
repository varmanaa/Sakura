import { PGCRYPTO_KEY } from '#config'
import { FormattedInvite, RawInvite } from '#types'
import Prisma from '@prisma/client'
import type { AuditEvent, Setting } from '@prisma/client'
import { container } from '@sapphire/framework'
import { Except, RequireAtLeastOne } from 'type-fest'

const { PrismaClient } = Prisma

export class Database {
    #prisma = new PrismaClient()
    #settings: Map<bigint, Setting> = new Map()

    public async createAuditEntry(event: AuditEvent, metadata: Prisma.Prisma.JsonObject) {
        await this.#prisma.audit.create({ data: { event, metadata } })
    }

    public async createAuditEntries(data: { event: AuditEvent, metadata: Prisma.Prisma.JsonObject }[]) {
        await this.#prisma.audit.createMany({ data, skipDuplicates: true })
    }
    
    public async createInvites(data: { guildId: bigint, code: string }[]) {
        const values = data.map(({ guildId, code }) => `(${ guildId.toString() }, pgp_sym_encrypt('${ code }', '${ PGCRYPTO_KEY }'))`).join(',')
        const query = `INSERT INTO invite ("guildId", "code") VALUES ${ values };`

        await this.#prisma.$executeRawUnsafe(query)
    }

    public async createSetting(guildId: bigint) {
        const setting = await this.#prisma.setting.create({ data: { guildId, categoryChannelIds: [], ignoredChannelIds: [] } })
        
        this.#settings.set(guildId, setting)

        await this.createAuditEntry('GUILD_CREATE', { guildId: guildId.toString(), total: container.client.guilds.cache.size })
    }

    public async deleteSetting(guildId: bigint) {
        await this.#prisma.setting.delete({ where: { guildId } })

        this.#settings.delete(guildId)

        await this.createAuditEntry('GUILD_DELETE', { guildId: guildId.toString(), total: container.client.guilds.cache.size })
    }

    public async deleteGuildInvites(guildId: bigint) {
        await this.#prisma.invite.deleteMany({ where: { guildId } })
    }

    public async init() {
		await this.#prisma.setting.updateMany({ data: { inCheck: false } })

		const settings = await this.#prisma.setting.findMany()

		for (const setting of settings)
			this.#settings.set(setting.guildId, setting)
    }

    public async insertInvite(guildId: bigint, code: string, expiresAt: Date, isPermanent: boolean, isValid: boolean) {
        const d = expiresAt ? `'${ expiresAt.toISOString() }'` : null
        const query = `
            INSERT INTO invite("guildId", code, "expiresAt", "isPermanent", "isValid", "isChecked", "updatedAt")
            VALUES(${ guildId.toString() }, pgp_sym_encrypt('${ code }', '${ PGCRYPTO_KEY }'), ${ d }, ${ isPermanent }, ${ isValid }, TRUE, CURRENT_TIMESTAMP)
        `

        await this.#prisma.$executeRawUnsafe(query)
    }
    
    public async readAuditEntries(startTime: Date, endTime: Date) {
        const records = await this.#prisma.audit.findMany({
            where: {
                timestamp: {
                    gte: startTime,
                    lte: endTime
                }
            }
        })

        return records        
    }

    public async readCheckedCodes(amount: number): Promise<{ id: number; code: string }[]> {
        const query = `
            SELECT
                id,
                pgp_sym_decrypt(code, '${ PGCRYPTO_KEY }') AS code
            FROM
                invite
            WHERE
                "isChecked"
                AND "isValid"
            ORDER BY
                "updatedAt"
            LIMIT
                ${ amount };
        `
        const codes = await this.#prisma.$queryRawUnsafe<{ id: number; code: string }[]>(query)

        return codes
    }

    public async readGuildCodes(guildId: bigint): Promise<{ code: string }[]> {
        const query = `
            SELECT
                pgp_sym_decrypt(code, '${ PGCRYPTO_KEY }') AS code
            FROM
                invite
            WHERE
                "guildId" = ${ guildId.toString() };
        `
        const codes = await this.#prisma.$queryRawUnsafe<{ code: string }[]>(query)

        return codes
    }

    public async readGuildInvites(guildId: bigint): Promise<Map<string, FormattedInvite>> {
        const query = `
            SELECT
                id,
                "guildId"::TEXT,
                pgp_sym_decrypt(code, '${ PGCRYPTO_KEY }') AS code,
                "isPermanent",
                "isValid",
                "isChecked",
                "expiresAt",
                "createdAt",
                "updatedAt"
            FROM
                invite
            WHERE
                "guildId" = ${ guildId.toString() };
        `
        const data = await this.#prisma.$queryRawUnsafe<RawInvite[]>(query)
        const invites = new Map<string, FormattedInvite>()

        for (const datum of data) {
            const invite = {
                id: datum.id,
                guildId: BigInt(datum.guildId),
                code: datum.code,
                isPermanent: datum.isPermanent,
                isValid: datum.isValid,
                isChecked: datum.isChecked,
                expiresAt: (typeof datum.expiresAt === 'string') ? new Date(datum.expiresAt) : null,
                createdAt: new Date(datum.createdAt),
                updatedAt: (typeof datum.updatedAt === 'string') ? new Date(datum.updatedAt) : null
            }

            invites.set(invite.code, invite)
        }

        return invites
    }

	public readSetting(guildId: bigint): Setting
	public readSetting<K extends keyof Setting>(guildId: bigint, field: K): Setting[K]
	public readSetting<K extends keyof Setting>(guildId: bigint, field?: K) {
        const setting = this.#settings.get(guildId)

		return field
			? setting?.[field]
			: setting
	}

    public async readUncheckedCodes(amount: number): Promise<{ id: number; code: string }[]> {
        const query = `
            SELECT
                id,
                pgp_sym_decrypt(code, '${ PGCRYPTO_KEY }') AS code
            FROM
                invite
            WHERE
                "isChecked" = FALSE                
            ORDER BY
                "createdAt"
            LIMIT
                ${ amount };
        `
        const codes = await this.#prisma.$queryRawUnsafe<{ id: number; code: string }[]>(query)

        return codes
    }

    public async recycleInvites(xDays: number) {
        const now = new Date()
        const xDaysAgo = new Date(now.setDate(now.getDate() - xDays))
        const query = `
            SELECT
                "guildId"::TEXT,
                pgp_sym_decrypt(code, '${ PGCRYPTO_KEY }') AS code
            FROM
                invite
            WHERE
                "isValid"
                AND "createdAt" <= '${ xDaysAgo.toISOString() }';
        `
        const xDaysAgoCodes = await this.#prisma.$queryRawUnsafe<{ guildId: string; code: string }[]>(query)
        const xDaysAgoCodesFormatted = xDaysAgoCodes.map(({ guildId, code }) => ({ guildId: BigInt(guildId), code }))

        await this.#prisma.invite.deleteMany({
            where: {
                createdAt: {
                    lte: xDaysAgo
                }
            }
        })

        if (xDaysAgoCodes.length)
            await this.createInvites(xDaysAgoCodesFormatted)
    }

    public async updateInvite(id: number, expiresAt: Date, isPermanent: boolean, isValid: boolean) {
        const d = expiresAt ? `'${ expiresAt.toISOString() }'` : null
        const query = `
            UPDATE invite
            SET 
                "expiresAt" = ${ d },
                "isPermanent" = ${ isPermanent },
                "isValid" = ${ isValid },
                "isChecked" = TRUE,
                "updatedAt" = CURRENT_TIMESTAMP
            WHERE
                id = ${ id }
        `

        await this.#prisma.$executeRawUnsafe(query)
    }

	public async updateSetting(guildId: bigint, data: RequireAtLeastOne<Except<Setting, 'guildId'>>) {
        const setting = await this.#prisma.setting.update({ data, where: { guildId } })

        this.#settings.set(guildId, setting)
	}
}