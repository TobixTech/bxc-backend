// backend/index.js - One-Time Stake Event Version

require('dotenv').config();
const express = require('express');
const { MongoClient, ServerApiVersion } = require('mongodb');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 5000;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- MongoDB Connection ---
const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'ExtraShare';

let client;

async function connectToMongo() {
  if (!uri) {
    console.error("MONGODB_URI is not set.");
    process.exit(1);
  }

  try {
    client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      }
    });
    await client.connect();
    console.log("Connected to MongoDB!");
  } catch (err) {
    console.error("Failed to connect to MongoDB", err);
    throw err;
  }
}

function getDb() {
    if (!client || !client.db) {
        throw new Error("MongoDB client not connected.");
    }
    return client.db(dbName);
}

// --- Event Constants ---
const INITIAL_BXC = 8000;               // Initial BXC for staking
const REFERRAL_BXC = 1050;              // BXC for successful referrals
const MIN_REWARD = 10;                  // $10 minimum reward
const MAX_REWARD = 899;                 // $899 maximum reward
const TOTAL_SLOTS = 25000;              // Total available slots
const LUCKY_WINNERS = 9000;             // Number of lucky winners
const BASE_REFERRAL_URL = "https://xtrashare-bxc.vercel.app/";

// --- Helper Functions ---
function generateReferralCode(walletAddress) {
  return walletAddress.slice(-6).toLowerCase(); // Last 6 chars of wallet
}

function getReferralLink(walletAddress) {
  return `${BASE_REFERRAL_URL}${generateReferralCode(walletAddress)}`;
}

// Pre-calculate winning slots
const winningSlots = new Set();
while (winningSlots.size < LUCKY_WINNERS) {
  winningSlots.add(Math.floor(Math.random() * TOTAL_SLOTS) + 1);
}

// --- API Routes ---

// Health Check
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// 1. GET /api/status/:walletAddress - Get user and event status
app.get('/api/status/:walletAddress', async (req, res) => {
    const walletAddress = req.params.walletAddress.toLowerCase();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const eventCollection = db.collection('event');

        // Get or create user
        let user = await usersCollection.findOne({ walletAddress });
        if (!user) {
            user = {
                walletAddress,
                hasStaked: false,
                stakedAmount: 0,
                rewardAmount: 0,
                isWinner: false,
                referralCode: generateReferralCode(walletAddress),
                referralCount: 0,
                createdAt: new Date()
            };
            await usersCollection.insertOne(user);
        }

        // Get event status
        let event = await eventCollection.findOne({});
        if (!event) {
            event = {
                totalStaked: 0,
                slotsRemaining: TOTAL_SLOTS,
                winnersDeclared: 0,
                eventActive: true,
                createdAt: new Date()
            };
            await eventCollection.insertOne(event);
        }

        res.json({
            user: {
                hasStaked: user.hasStaked,
                stakedAmount: user.stakedAmount,
                rewardAmount: user.rewardAmount,
                isWinner: user.isWinner,
                referralCode: user.referralCode,
                referralLink: getReferralLink(walletAddress)
            },
            event: {
                totalStaked: event.totalStaked,
                slotsRemaining: event.slotsRemaining,
                winnersDeclared: event.winnersDeclared,
                eventActive: event.eventActive
            }
        });

    } catch (error) {
        console.error("Status error:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// 2. POST /api/stake - Handle one-time stake
app.post('/api/stake', async (req, res) => {
    const { walletAddress, referrerCode } = req.body;
    const userWalletAddress = walletAddress.toLowerCase();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const eventCollection = db.collection('event');

        // Check event status
        const event = await eventCollection.findOne({});
        if (!event.eventActive || event.slotsRemaining <= 0) {
            return res.status(400).json({ message: "Event is no longer active" });
        }

        // Check if user already staked
        const user = await usersCollection.findOne({ walletAddress: userWalletAddress });
        if (user && user.hasStaked) {
            return res.status(400).json({ message: "You can only stake once" });
        }

        // Determine if this is a winning slot
        const isWinner = winningSlots.has(event.totalStaked + 1);
        const rewardAmount = isWinner 
            ? Math.floor(Math.random() * (MAX_REWARD - MIN_REWARD + 1)) + MIN_REWARD
            : 0;

        // Update user
        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $set: {
                    hasStaked: true,
                    stakedAmount: 8, // $8 minimum
                    rewardAmount: rewardAmount,
                    isWinner: isWinner,
                    referralCode: generateReferralCode(walletAddress)
                },
                $inc: { referralCount: 0 } // Placeholder
            },
            { upsert: true }
        );

        // Update event
        await eventCollection.updateOne(
            {},
            {
                $inc: { 
                    totalStaked: 1,
                    slotsRemaining: -1,
                    winnersDeclared: isWinner ? 1 : 0
                }
            }
        );

        // Handle referral if provided
        if (referrerCode && referrerCode !== generateReferralCode(walletAddress)) {
            await usersCollection.updateOne(
                { referralCode: referrerCode.toLowerCase() },
                { $inc: { rewardAmount: REFERRAL_BXC, referralCount: 1 } }
            );
        }

        res.json({
            message: "Stake successful!",
            isWinner: isWinner,
            rewardAmount: rewardAmount,
            slotsRemaining: event.slotsRemaining - 1
        });

    } catch (error) {
        console.error("Stake error:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// 3. POST /api/referral-copied - Track referral link copies
app.post('/api/referral-copied', async (req, res) => {
    const { walletAddress } = req.body;
    const userWalletAddress = walletAddress.toLowerCase();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');

        // Award referral BXC
        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            { $inc: { rewardAmount: REFERRAL_BXC } }
        );

        const user = await usersCollection.findOne({ walletAddress: userWalletAddress });
        
        res.json({
            message: `+${REFERRAL_BXC} BXC for referral!`,
            rewardAmount: user.rewardAmount
        });
    } catch (error) {
        console.error("Referral error:", error);
        res.status(500).json({ message: "Failed to process referral" });
    }
});

// 4. POST /api/withdraw - Handle withdrawals
app.post('/api/withdraw', async (req, res) => {
    const { walletAddress } = req.body;
    const userWalletAddress = walletAddress.toLowerCase();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');

        const user = await usersCollection.findOne({ walletAddress: userWalletAddress });
        if (!user || !user.hasStaked) {
            return res.status(400).json({ message: "No staked funds to withdraw" });
        }

        if (user.rewardAmount <= 0) {
            return res.status(400).json({ message: "No rewards to withdraw" });
        }

        // In a real implementation, you would process the withdrawal here
        // For this example, we'll just reset the reward amount
        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            { $set: { rewardAmount: 0 } }
        );

        res.json({
            message: `Successfully withdrew $${user.rewardAmount}!`,
            withdrawnAmount: user.rewardAmount
        });

    } catch (error) {
        console.error("Withdrawal error:", error);
        res.status(500).
