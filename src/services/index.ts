import { Collection, Db, MongoClient, Timestamp } from 'mongodb'
import 'dotenv/config'
import * as IPFS from 'ipfs-http-client'
import Axios from 'axios'
import { MONGODB_URL, mongoOffchan } from './db'

const IPFS_CLUSTER_URL = process.env.IPFS_CLUSTER_URL

const ndjsonParse = async function* (stream) {
  const matcher = /\r?\n/
  const decoder = new TextDecoder('utf8')
  let buffer = ''

  for await (let value of stream) {
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split(matcher)
    buffer = parts.pop() || ''
    for (const part of parts) yield JSON.parse(part)
  }
  buffer += decoder.decode(undefined, { stream: false })
  if (buffer) yield JSON.parse(buffer)
}

export class CoreService {
  ipfs: IPFS
  pins: Collection
  peers: Collection

  async getPeers() {
    const response = await Axios.get(`${IPFS_CLUSTER_URL}/peers`, {
      responseType: 'stream',
      timeout: 6000000,
    })

    const stream = response.data
    for await (let json of ndjsonParse(stream)) {
      // console.log(json)
      await this.peers.findOneAndUpdate({
        id: json.id,
      }, {
        $set: {
          ...json
        }
      }, {
        upsert: true
      })
    }
  }

  async refreshPins() {
    // await this.pins.deleteMany({})

    const response = await Axios.get(`${IPFS_CLUSTER_URL}/pins`, {
      responseType: 'stream',
      timeout: 6000000 * 10,
    })

    const stream = response.data

    for await (let json of ndjsonParse(stream)) {
      try {
        // const json = JSON.parse(jsonData.toString())
        json.peer_map = Object.entries(json.peer_map).map(([key, value]) => {
          return {
            ...(value as any),
            cluster_id: key,
          }
        })
        await this.pins.insertOne(json)
      } catch (ex) {
        console.log(ex)
        // console.log(jsonData.toString())
        //End
      }
    }
  }

  async runAllocationVerification() {
    this.pins.find({

    })
  }

  async start() {
    const url = MONGODB_URL
    const mongo = new MongoClient(url)
    await mongo.connect()
    const db = mongo.db('cluster-rewarding')
    this.pins = db.collection('pins')
    this.peers = db.collection('peers')
    
    
    try {
      await this.pins.createIndex({
        "metadata.key": -1
      })
    } catch {
      
    }

    await this.getPeers()
    await this.refreshPins()

    this.ipfs = IPFS.create()
    // for await (let res of this.ipfs.dht.findProvs(
    //   'QmU1k7SUq1jBhWL1EoL5R1mk44dVvSm5QkScfpsLavWmoC',
    // )) {
    //   if (res.name === 'PROVIDER') {
    //     for (let provider of res.providers) {
    //       console.log(provider.id)
    //     }
    //   }
    // }
  }
}
