import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config()
const client = new MongoClient(process.env.MONGODB_URI)

export const connectToDatabase = () => {
  return new Promise(async (resolve, reject) => {
    try {
      await client.connect()
      console.log('Connected to db');
      resolve(client)
    } catch (error) {
      reject(error)
    }
  })
}