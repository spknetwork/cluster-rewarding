import { Collection, Db, MongoClient, Timestamp } from 'mongodb'
import 'dotenv/config'
import * as IPFS from 'ipfs-http-client'
import { IPFSHTTPClient } from 'ipfs-http-client'

import Axios from 'axios'
import PQueue from 'p-queue'
import CID from 'cids'
import { cryptoUtils, PrivateKey } from '@hiveio/dhive'
import NodeSchedule from 'node-schedule'
import { Models, MONGODB_URL } from './db'
import { getReportPermlink, getRoundId, HiveClient } from '../utils'

const IPFS_CLUSTER_URL = process.env.IPFS_CLUSTER_URL

export const ndjsonParse = async function* (stream) {
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
  ipfs: IPFSHTTPClient
  dhtQueue: PQueue
  pins: Collection
  peers: Collection
  validationRounds: Collection
  validationResults: Collection
  locks: Collection
  _pinRefreshRunning: boolean
  markers: Collection
  // validationStats: Collection

  constructor() {
    this._pinRefreshRunning = false;

    this.refreshPins = this.refreshPins.bind(this)
    this.runAllocationVerification = this.runAllocationVerification.bind(this)
    this.createReportParent = this.createReportParent.bind(this)
    this.distributeVotes = this.distributeVotes.bind(this)
    this.getPeers = this.getPeers.bind(this)
  }

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
    const queue = new PQueue({concurrency: 50})
    this._pinRefreshRunning = true;
    // await this.pins.deleteMany({})

    const response = await Axios.get(`${IPFS_CLUSTER_URL}/pins`, {
      responseType: 'stream',
      timeout: 6000000 * 10,
    })

    const stream = response.data
    const round_id = getRoundId();
    
    try {
      for await (let json of ndjsonParse(stream)) {
        queue.add(async () => {
          try {
            // const json = JSON.parse(jsonData.toString())
            json.peer_map = Object.entries(json.peer_map).map(([key, value]) => {
              return {
                ...(value as any),
                cluster_id: key,
              }
            })
            json.round_id = round_id
            if(!(await this.pins.findOne({
              cid: json.cid,
              round_id: round_id
            }))) {
              await this.pins.insertOne(json)
            }
          } catch (ex) {
            console.log(ex)
            // console.log(jsonData.toString())
            //End
          }
        })
      }
      await queue.onIdle()
      await this.pins.deleteMany({
        round_id: {
          $ne: round_id
        }
      })
    } catch (ex) {
      console.log(ex)
    }
    this._pinRefreshRunning = false;
  }

  async runAllocationVerification() {
    console.log('running allocation verification')
    const startTime = new Date()
    const round_id = getRoundId()
    const peers = await this.peers.distinct('id', {
      trusted: false,
    })
    const roundInfo = await this.validationRounds.findOne({
      round_id
    })
    console.log(roundInfo)
    if(roundInfo) {
      console.log('running allocation verification 2')
      return; //Round already generated.
    }
    if(this._pinRefreshRunning) {
      console.log('running allocation verification 3')
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
        },
        {
          limit: 200,
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

  async pingIpfsNode(peerId) {
    try {
      for await(let _ of this.ipfs.ping(peerId)) {}
    } catch {

    }
  }

  async distributeVotes() {
    const voteSlots = 2;

    const round_id = getRoundId()
    const queue = new PQueue({concurrency: 5})
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
      dhtPassFail: number
      // username: string
    }> = {}
    let totalRedundantCopies = 0;
    for(let peerId of peersIpfs) {
      
      
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
            ipfs_peer_id: peerId,
            status: 'pinned',
          },
        },
      })
      const passfail = passCount / (passCount + failCount)
      let power = Math.min((passfail / 0.25), 1)
      
      const fileWeight = power * totalStoredFiles
      if(fileWeight) {
        totalRedundantCopies = fileWeight + totalRedundantCopies;
      }
      console.log('fileWeight', fileWeight)
      
      // const vote_weight = passCount / (passCount + failCount)
      peerMap[peerId] = {
        passCount,
        failCount,
        totalStoredFiles,
        fileWeight,
        dhtPassFail: passfail
      }
    }
    for(let [peerId, obj] of Object.entries(peerMap)) {
      queue.add(async() => {
        this.pingIpfsNode(peerId)
        let username;
        for await(let result of this.ipfs.name.resolve(peerId)) {
          // console.log(peerId)
          if(result !== "/ipfs/QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn") {
            console.log(IPFS.CID.parse(result.split('/')[2]))
            
            const data = await this.ipfs.dag.get(IPFS.CID.parse(result.split('/')[2]))
            console.log(data.value)
            if(data.value) {
              username = data.value.username
              break;
            }
          }
        }
        const share = obj.fileWeight / totalRedundantCopies
        const vote_weight = Math.round(Math.min((share * voteSlots), 1) * 10_000)
        console.log({
          share,
          vote_weight,
          totalRedundantCopies,
          obj
        })
        try {
          const comments = await HiveClient.database.call('get_content_replies', [process.env.PARENT_REPORT_ACCOUNT, getReportPermlink()])
          for(let post of comments) {
            if(post.author === username) {
              if(!!post.active_votes.find(e => {
                return e.voter === process.env.VOTER_ACCOUNT
              })) {
                continue;
              }
              try {
                const voteOp = await HiveClient.broadcast.vote({
                  voter: process.env.VOTER_ACCOUNT,
                  author: post.author,
                  permlink: post.permlink,
                  weight: vote_weight
                }, PrivateKey.from(process.env.VOTER_ACCOUNT_POSTING))
                console.log(voteOp, vote_weight)
                await HiveClient.broadcast.comment({
                  author: process.env.PARENT_REPORT_ACCOUNT,
                  title: ``,
                  body: 
                  `Observation report\n` +
                  `File score: ${obj.fileWeight}\n` +
                  `Network dominance score: ${share}\n` +
                  `DHT score: ${obj.dhtPassFail}`
                  ,
                  json_metadata: JSON.stringify({
                      tags: ['threespeak', 'cluster-rewarding'],
                      app: "cluster-rewarding/0.1.0"
                  }),
                  parent_author: post.author,
                  parent_permlink: post.permlink,
                  permlink: `re-${cryptoUtils.sha256(`${post.author}-${post.permlink}`).toString('hex')}`
                }, PrivateKey.fromString(process.env.PARENT_REPORT_ACCOUNT_POSTING))
              } catch (ex) {
                console.log(ex)
              }
            }
          }
        } catch (ex) {
          console.log(ex)
          // console.log(Object.values(ex.jse_info).join(''))
        }
      })
    }
    await queue.onIdle();
  }

  async createReportParent() {
    console.log('Attempting to create parent post', [process.env.PARENT_REPORT_ACCOUNT, getReportPermlink()])
    try {
      const data = await HiveClient.database.call('get_content', [process.env.PARENT_REPORT_ACCOUNT, getReportPermlink()])
    } catch(ex) {
      const date = new Date();
      // console.log(ex)
      try {
        const postResult = await HiveClient.broadcast.comment({
            author: process.env.PARENT_REPORT_ACCOUNT,
            title: `Daily cluster validation report (${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()})`,
            body: 'Comments below will contain basic ipfs cluster reporting information. Qualifying comments will be upvoted by @threespeak',
            json_metadata: JSON.stringify({
                tags: ['threespeak', 'cluster-rewarding'],
                app: "cluster-rewarding/0.1.0"
            }),
            parent_author: '',
            parent_permlink: 'hive-181335',
            permlink: getReportPermlink()
        }, PrivateKey.fromString(process.env.PARENT_REPORT_ACCOUNT_POSTING))
        console.log(postResult)
      } catch (ex) {
        console.log(ex)
      }
    }
  }

  async start() {
    const url = MONGODB_URL
    const mongo = new MongoClient(url)
    this.ipfs = IPFS.create({ url: process.env.IPFS_HOST || 'http://127.0.0.1:5001' })
    const PQueue = (await import('p-queue')).default
    this.dhtQueue = new PQueue({ concurrency: 50 })


    await mongo.connect()
    const db = mongo.db('cluster-rewarding')
    this.pins = db.collection('pins')
    this.peers = db.collection('peers')
    this.validationRounds = db.collection('validation_rounds')
    this.validationResults = db.collection('validation_results')
    this.locks = db.collection('locks')
    this.markers = db.collection('markers')
    // this.validationStats = db.collection('validation_stats')
    
    // await this.createReportParent()
    try {
      for(let model of Object.values(Models)) {
        await model.syncIndexes()
      }
    } catch (ex) {
      console.log(ex)
    }

    
    NodeSchedule.scheduleJob('0 */6 * * *', this.refreshPins)
    NodeSchedule.scheduleJob('0 */1 * * *', async() => {
      await this.getPeers()
      await this.createReportParent()
      await this.runAllocationVerification()
      await this.distributeVotes()
    })
    
    // await this.runAllocationVerification()
    // console.log('running')
    // await this.distributeVotes()


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
