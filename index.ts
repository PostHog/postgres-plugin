import { createBuffer } from '@posthog/plugin-contrib'
import { Plugin, PluginMeta, PluginEvent } from '@posthog/plugin-scaffold'
import { Client } from 'pg'

type PostgresPlugin = Plugin<{
    global: {
        pgClient: Client
        buffer: ReturnType<typeof createBuffer>
        eventsToIgnore: Set<string>
        sanitizedTableName: string
    }
    config: {
        databaseUrl: string
        host: string
        port: string
        dbName: string
        tableName: string
        dbUsername: string
        dbPassword: string
        uploadSeconds: string
        uploadMegabytes: string
        eventsToIgnore: string
        isHeroku: 'Yes' | 'No'
    }
}>

type PostgresMeta = PluginMeta<PostgresPlugin>

interface ParsedEvent {
    uuid: string
    eventName: string
    properties: Record<string, any>
    elements: Record<string, any>
    set: Record<string, any>
    set_once: Record<string, any>
    distinct_id: string
    team_id: number
    ip: string
    site_url: string
    timestamp: string
}

type InsertQueryValue = string | number

interface UploadJobPayload {
    batch: ParsedEvent[]
    batchId: number
    retriesPerformedSoFar: number
}

export const jobs: PostgresPlugin['jobs'] = {
    uploadBatchToPostgres: async (payload: UploadJobPayload, meta: PostgresMeta) => {
        await insertBatchIntoPostgres(payload, meta)
    },
}

export const setupPlugin: PostgresPlugin['setupPlugin'] = async (meta) => {
    const { global, config } = meta

    if (!config.databaseUrl) {
        const requiredConfigOptions = ['host', 'port', 'dbName', 'dbUsername', 'dbPassword']
        for (const option of requiredConfigOptions) {
            if (!(option in config)) {
                throw new Error(`Required config option ${option} is missing!`)
            }
        }
    }

    const uploadMegabytes = Math.max(1, Math.min(parseInt(config.uploadMegabytes) || 1, 10))
    const uploadSeconds = Math.max(1, Math.min(parseInt(config.uploadSeconds) || 1, 600))

    global.sanitizedTableName = sanitizeSqlIdentifier(config.tableName)

    const queryError = await executeQuery(
        `CREATE TABLE IF NOT EXISTS public.${global.sanitizedTableName} (
            uuid varchar(200),
            event varchar(200),
            properties jsonb,
            elements jsonb,
            set jsonb,
            set_once jsonb,
            timestamp timestamp with time zone,
            team_id int,
            distinct_id varchar(200),
            ip varchar(200),
            site_url varchar(200)
        );`,
        [],
        config
    )

    if (queryError) {
        throw new Error(`Unable to connect to PostgreSQL instance and create table with error: ${queryError.message}`)
    }

    global.buffer = createBuffer({
        limit: uploadMegabytes * 1024 * 1024,
        timeoutSeconds: uploadSeconds,
        onFlush: async (batch) => {
            await insertBatchIntoPostgres(
                { batch, batchId: Math.floor(Math.random() * 1000000), retriesPerformedSoFar: 0 },
                meta
            )
        },
    })

    global.eventsToIgnore = new Set(
        config.eventsToIgnore ? config.eventsToIgnore.split(',').map((event) => event.trim()) : null
    )
}

export async function onEvent(event: PluginEvent, { global }: PostgresMeta) {
    const {
        event: eventName,
        properties,
        $set,
        $set_once,
        distinct_id,
        team_id,
        site_url,
        now,
        sent_at,
        uuid,
        ..._discard
    } = event

    const ip = properties?.['$ip'] || event.ip
    const timestamp = event.timestamp || properties?.timestamp || now || sent_at
    let ingestedProperties = properties
    let elements = []

    // only move prop to elements for the $autocapture action
    if (eventName === '$autocapture' && properties && '$elements' in properties) {
        const { $elements, ...props } = properties
        ingestedProperties = props
        elements = $elements
    }

    const parsedEvent = {
        uuid,
        eventName,
        properties: JSON.stringify(ingestedProperties || {}),
        elements: JSON.stringify(elements || {}),
        set: JSON.stringify($set || {}),
        set_once: JSON.stringify($set_once || {}),
        distinct_id,
        team_id,
        ip,
        site_url,
        timestamp: new Date(timestamp).toISOString(),
    }

    if (!global.eventsToIgnore.has(eventName)) {
        global.buffer.add(parsedEvent)
    }
}

export const insertBatchIntoPostgres = async (payload: UploadJobPayload, { global, jobs, config }: PostgresMeta) => {
    let values: InsertQueryValue[] = []
    let valuesString = ''

    for (let i = 0; i < payload.batch.length; ++i) {
        const { uuid, eventName, properties, elements, set, set_once, distinct_id, team_id, ip, site_url, timestamp } =
            payload.batch[i]

        // Creates format: ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11), ($12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
        valuesString += ' ('
        for (let j = 1; j <= 11; ++j) {
            valuesString += `$${11 * i + j}${j === 11 ? '' : ', '}`
        }
        valuesString += `)${i === payload.batch.length - 1 ? '' : ','}`

        values = [
            ...values,
            ...[
                uuid,
                eventName,
                JSON.stringify(properties),
                JSON.stringify(elements),
                JSON.stringify(set),
                JSON.stringify(set_once),
                distinct_id,
                team_id,
                ip,
                site_url,
                timestamp,
            ],
        ]
    }

    console.log(
        `(Batch Id: ${payload.batchId}) Flushing ${payload.batch.length} event${
            payload.batch.length > 1 ? 's' : ''
        } to Postgres instance`
    )

    const queryError = await executeQuery(
        `INSERT INTO ${global.sanitizedTableName} (uuid, event, properties, elements, set, set_once, distinct_id, team_id, ip, site_url, timestamp)
        VALUES ${valuesString}`,
        values,
        config
    )

    if (queryError) {
        console.error(`(Batch Id: ${payload.batchId}) Error uploading to Postgres: ${queryError.message}`)
        if (payload.retriesPerformedSoFar >= 15) {
            return
        }
        const nextRetryMs = 2 ** payload.retriesPerformedSoFar * 3000
        console.log(`Enqueued batch ${payload.batchId} for retry in ${nextRetryMs}ms`)
        await jobs
            .uploadBatchToPostgres({
                ...payload,
                retriesPerformedSoFar: payload.retriesPerformedSoFar + 1,
            })
            .runIn(nextRetryMs, 'milliseconds')
    }
}

const executeQuery = async (query: string, values: any[], config: PostgresMeta['config']): Promise<Error | null> => {
    const pgClient = new Client(
        config.databaseUrl ?? {
            user: config.dbUsername,
            password: config.dbPassword,
            host: config.host,
            database: config.dbName,
            port: parseInt(config.port),
            ssl:
                config.isHeroku === 'Yes'
                    ? {
                          rejectUnauthorized: false,
                      }
                    : undefined,
        }
    )

    await pgClient.connect()

    let error: Error | null = null
    try {
        await pgClient.query(query, values)
    } catch (err) {
        error = err
    }

    await pgClient.end()

    return error
}

export const teardownPlugin: PostgresPlugin['teardownPlugin'] = ({ global }) => {
    global.buffer.flush()
}

const sanitizeSqlIdentifier = (unquotedIdentifier: string): string => {
    return unquotedIdentifier.replace(/[^\w\d_]+/g, '')
}
