import EventEmitter from 'events'
//import PQueue from 'p-queue'
import type PQueue from 'p-queue'
import { BlockchainMode, BlockchainStreamOptions, Client } from '@hiveio/dhive'
import Pushable from 'it-pushable'

export const HiveClient = new Client(process.env.HIVE_HOST?.split(',') || ['https://anyx.io'])


export function getReportPermlink() {
    const date = new Date()
    return `daily-cluster-validation-report-${date.getUTCMonth() + 1}${date.getUTCDate()}${date.getUTCFullYear()}`
}