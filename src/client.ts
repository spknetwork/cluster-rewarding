import 'dotenv/config'
import NodeSchedule from 'node-schedule'
import * as IPFS from 'ipfs-http-client'
import { PrivateKey } from '@hiveio/dhive'
import { getReportPermlink, HiveClient } from './utils'


class ClientService {
    ipfs: IPFS

    constructor() {

    }

    async registerNode() {
        const cid = await this.ipfs.dag.put({
            username: process.env.HIVE_ACCOUNT
        })
        console.log(cid)

        const publishResult = await this.ipfs.name.publish(cid)
        console.log(publishResult)
    }

    async createDailyReport() {
        try {
            const comments = await HiveClient.database.call('get_content_replies', [process.env.PARENT_REPORT_ACCOUNT, getReportPermlink()])
            let reportExists = false
            for(let comment of comments) {
                console.log(comment)
                const json_metadata = JSON.parse(comment.json_metadata)
                console.log(json_metadata)
                if(json_metadata.tags.includes('cluster-report') && comment.author === process.env.HIVE_ACCOUNT) {
                    reportExists = true
                }
            }
            if(!reportExists) {
                const postResult = await HiveClient.broadcast.comment({
                    author: process.env.HIVE_ACCOUNT,
                    title: '',
                    body: 'This is a test report. In production this would show a few basic details about the storage node. The main curator account would comment with the measured performance results for all to see.',
                    json_metadata: JSON.stringify({
                        tags: ['cluster-rewarding'],
                        app: "cluster-rewarding/0.1.0"
                    }),
                    parent_author: process.env.PARENT_REPORT_ACCOUNT,
                    parent_permlink: getReportPermlink(),
                    permlink: `${getReportPermlink()}-${new Date().getTime()}`
                }, PrivateKey.fromString(process.env.HIVE_ACCOUNT))
                console.log(postResult)
            } else {
                console.log('Already posted report')
            }
        } catch {

        }
    }

    async start() {
        this.ipfs = IPFS.create()

        // await this.createDailyReport()
        NodeSchedule.registerJob('0 * * * *', this.createDailyReport)
    }
}

void (async () => {
    const client = new ClientService()
    await client.start()
    
})()