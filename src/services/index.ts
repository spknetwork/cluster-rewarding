import { Collection, Db, MongoClient, Timestamp } from 'mongodb'
import 'dotenv/config'
import * as IPFS from 'ipfs-http-client'
import Axios from 'axios'
import type PQueue from 'p-queue'
import CID from 'cids'
import { PrivateKey } from '@hiveio/dhive'
import NodeSchedule from 'node-schedule'
import { Models, MONGODB_URL, mongoOffchan } from './db'
import { getReportPermlink, getRoundId, HiveClient } from '../utils'

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
  dhtQueue: PQueue
  pins: Collection
  peers: Collection
  validationRounds: Collection
  validationResults: Collection
  locks: Collection
  _pinRefreshRunning: boolean
  // validationStats: Collection

  async getPeers() {
    const response = await Axios.get(`${IPFS_CLUSTER_URL}/peers`, {
      responseType: 'stream',
      timeout: 6000000,
    })

    const stream = response.data

    const { data: trustedData } = await Axios.get(`${IPFS_CLUSTER_URL}/monitor/metrics/tag:group`)

    for await (let json of ndjsonParse(stream)) {
      // console.log(json)
      await this.peers.findOneAndUpdate(
        {
          id: json.id,
        },
        {
          $set: {
            ...json,
          },
        },
        {
          upsert: true,
        },
      )
    }
    const trustedPeers = trustedData
      .filter((e) => {
        return e.value === 'default'
      })
      .map((e) => {
        return e.peer
      })
    await this.peers.updateMany(
      {
        id: { $in: trustedPeers },
      },
      {
        $set: {
          trusted: true,
        },
      },
    )
    await this.peers.updateMany(
      {
        id: { $nin: trustedPeers },
      },
      {
        $set: {
          trusted: false,
        },
      },
    )
  }

  async refreshPins() {
    this._pinRefreshRunning = true;
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
        json.round_id = getRoundId()
        await this.pins.insertOne(json)
      } catch (ex) {
        console.log(ex)
        // console.log(jsonData.toString())
        //End
      }
    }
    this._pinRefreshRunning = false;
  }

  async runAllocationVerification() {
    await this.validationResults.deleteMany({})
    const startTime = new Date()
    const round_id = getRoundId()
    const peers = await this.peers.distinct('id', {
      trusted: false,
    })
    const roundInfo = await this.validationRounds.findOne({
      round_id
    })
    if(roundInfo) {
      return; //Round already generated.
    }
    if(this._pinRefreshRunning) {
      return;
    }
    // const peersIpfs = await this.peers.distinct('ipfs.id', {
    //   trusted: false,
    // })
    const data = await this.pins
      .find(
        {
          peer_map: {
            $elemMatch: {
              cluster_id: {
                $in: peers,
              },
              status: 'pinned',
            },
          },
          round_id
        },
        {
          limit: 100,
        },
      )
      .toArray()
    for (let info of data) {
      const testingPeers = info.peer_map.filter(e => {
        return e.status === "pinned" && peers.includes(e.cluster_id)
      }).map((e) => {
        return e.ipfs_peer_id
      })
      // console.log(info)
      this.dhtQueue.add(async () => {
        const passingPeers = []
        for await (let res of this.ipfs.dht.findProvs(info.cid)) {
          // console.log(res)
          if (res.name === 'PROVIDER') {
            for (let provider of res.providers) {
              // console.log('Test', provider.id)
              if (testingPeers.includes(provider.id.toString())) {
                passingPeers.push(provider.id.toString())
              }
            }
          }
        }
        for(let peer of testingPeers) {
          if(passingPeers.includes(peer)) {
            console.log('pass', peer)
            await this.validationResults.insertOne({
              cid: info.cid,
              node_id: peer,
              status: "success",
              round_id
            })
          } else {
            await this.validationResults.insertOne({
              cid: info.cid,
              node_id: peer,
              status: "fail",
              round_id
            })
            console.log('failed', peer)
          }
        }
      })
    }
    await this.dhtQueue.onIdle()
    console.log('round done in', (new Date().getTime() - startTime.getTime()) / 1000)
    await this.validationRounds.insertOne({
      round_id,
      start_at: startTime,
      finish_at: new Date()
    })
  }

  async distributesVotes() {
    const voteSlots = 3;

    const round_id = getRoundId()
    const roundInfo = await this.validationRounds.findOne({
      round_id
    })
    
    if(!roundInfo) {
      return;
    }

    const peersIpfs = await this.peers.distinct('ipfs.id', {
      trusted: false,
    })
    const peerMap: Record<string, {
      totalStoredFiles: number
      passCount: number
      failCount: number
      fileWeight: number
      username: string
    }> = {}
    let totalRedundantCopies = 0;
    for(let peerId of peersIpfs) {
      
      let username;
      for await(let result of this.ipfs.name.resolve(peerId)) {
        // console.log(peerId)
        if(result !== "/ipfs/QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn") {
          console.log(IPFS.CID.parse(result.split('/')[2]))
          
          const data = await this.ipfs.dag.get(IPFS.CID.parse(result.split('/')[2]))
          console.log(data.value)
          if(data.value) {
            username = data.value.username
          }
        }
      }
      const passCount = await this.validationResults.countDocuments({
        node_id: peerId,
        status: "success"
      })
      const failCount = await this.validationResults.countDocuments({
        node_id: peerId,
        status: "fail"
      })
      const totalStoredFiles = await this.pins.countDocuments({
        peer_map: {
          $elemMatch: {
            cluster_id: {
              $in: peerId,
            },
            status: 'pinned',
          },
        },
        round_id: getRoundId()
      })
      console.log(totalStoredFiles)
      const passfail = passCount / (passCount + failCount)
      let power = Math.min((passfail / 0.25), 1)
      
      const fileWeight = power * totalStoredFiles
      totalRedundantCopies = fileWeight + totalRedundantCopies;
      
      // const vote_weight = passCount / (passCount + failCount)
      peerMap[peerId] = {
        passCount,
        failCount,
        totalStoredFiles,
        fileWeight,
        username
      }
    }
    for(let obj of Object.values(peerMap)) {
      const share = obj.fileWeight / totalRedundantCopies
      const vote_weight = Math.round(Math.min((share * voteSlots), 1) * 10_000)
      try {
        const comments = await HiveClient.database.call('get_content_replies', [process.env.PARENT_REPORT_ACCOUNT, getReportPermlink()])
        for(let post of comments) {
          if(post.author === obj.username) {
            const voteOp = await HiveClient.broadcast.vote({
              voter: "threespeak",
              author: post.author,
              permlink: post.permlink,
              weight: vote_weight
            }, PrivateKey.from(process.env.VOTER_ACCOUNT_POSTING))
            console.log(voteOp, vote_weight)
          }
        }
      } catch (ex) {
        // console.log(ex)
        // console.log(Object.values(ex.jse_info).join(''))
      }
    }
  }

  async createReportParent() {
    console.log('creating parent post', [process.env.PARENT_REPORT_ACCOUNT, getReportPermlink()])
    try {
      const data = await HiveClient.database.call('get_content', [process.env.PARENT_REPORT_ACCOUNT, getReportPermlink()])
      console.log(data)
    } catch(ex) {
      const date = new Date();
      // console.log(ex)
      const postResult = await HiveClient.broadcast.comment({
          author: process.env.HIVE_ACCOUNT,
          title: `Daily cluster validation report (${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()})`,
          body: 'Comments below will contain basic ipfs cluster reporting information. Qualifying comments will be upvoted by @threespeak',
          json_metadata: JSON.stringify({
              tags: ['threespeak', 'cluster-rewarding'],
              app: "cluster-rewarding/0.1.0"
          }),
          parent_author: process.env.PARENT_REPORT_ACCOUNT,
          parent_permlink: '',
          permlink: getReportPermlink()
      }, PrivateKey.fromString(process.env.PARENT_REPORT_ACCOUNT_POSTING))
      console.log(postResult)
    }
  }

  async start() {
    const url = MONGODB_URL
    const mongo = new MongoClient(url)
    this.ipfs = IPFS.create()
    const PQueue = (await import('p-queue')).default
    this.dhtQueue = new PQueue({ concurrency: 50 })


    await mongo.connect()
    const db = mongo.db('cluster-rewarding')
    this.pins = db.collection('pins')
    this.peers = db.collection('peers')
    this.validationRounds = db.collection('validation_rounds')
    this.validationResults = db.collection('validation_results')
    this.locks = db.collection('locks')
    // this.validationStats = db.collection('validation_stats')
    
    // await this.createReportParent()
    try {
      for(let model of Object.values(Models)) {
        await model.syncIndexes()
      }
    } catch (ex) {
      console.log(ex)
    }

    // await this.distributesVotes()
    

    
    // NodeSchedule.registerJob('0 * * * *', this.getPeers); //Doesn't need round check
    NodeSchedule.registerJob('0 */6 * * *', this.refreshPins)
    NodeSchedule.registerJob('0 */3 * * *', this.runAllocationVerification)
    NodeSchedule.registerJob('0 */3 * * *', this.createReportParent)
    NodeSchedule.registerJob('0 */3 * * *', this.distributesVotes)

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
