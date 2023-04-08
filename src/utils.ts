import EventEmitter from 'events'
//import PQueue from 'p-queue'
import type PQueue from 'p-queue'
import { BlockchainMode, BlockchainStreamOptions, Client } from '@hiveio/dhive'
import Pushable from 'it-pushable'

export const HiveClient = new Client(process.env.HIVE_HOST?.split(',') || ["https://hive-api.3speak.tv", 'https://anyx.io'])
