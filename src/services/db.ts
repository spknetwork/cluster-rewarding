import { MongoClient } from 'mongodb'
import 'dotenv/config'
import mongoose, { Schema } from 'mongoose'

const MONGO_HOST = process.env.MONGO_HOST || '127.0.0.1:27017'

export const MONGODB_URL = `mongodb://${MONGO_HOST}`
export const mongo = new MongoClient(MONGODB_URL)

const PinSchema = new Schema({})

PinSchema.index({
    "metadata.key": -1
})

PinSchema.index({
    "peer_map.cluster_id": -1
})

PinSchema.index({
    "peer_map.ipfs_peer_id": -1
})


export const Models = {
    PinModel: mongoose.model('pins', PinSchema)
}