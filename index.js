require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 5000;

// Constants
const INITIAL_BXC = 8000;
const REFERRAL_BXC = 1050;
const MIN_REWARD = 10;
const MAX_REWARD = 899;
const TOTAL_SLOTS = 25000;
const LUCKY_WINNERS = 9000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
let db;
async function connectDB() {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db(process.env.DB_NAME || 'ExtraShare');
    console.log("Connected to MongoDB");
}

// Generate winning slots
const winningSlots = new Set();
while (winningSlots.size < LUCKY_WINNERS) {
    winningSlots.add(Math.floor(Math.random() * TOTAL_SLOTS) + 1);
}

// --- API Endpoints ---

// Health Check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date() });
});

// Get User Status
app.get('/api/status/:walletAddress', async (req, res) => {
    try {
        const walletAddress = req.params.walletAddress.toLowerCase();
        const users = db.collection('users');
        const event = db.collection('event');

        // Get or create user
        let user = await users.findOne({ walletAddress });
        if (!user) {
            user = {
                walletAddress,
                slotsStaked: 0,
                BXC_Balance: 0,
                referralCode: walletAddress.slice(-6).toLowerCase(),
                referralCount: 0,
                claimedReward: false,
                lastRewardAmount: 0,
                createdAt: new Date()
            };
            await users.insertOne(user);
        }

        // Get event status
        let eventStatus = await event.findOne({});
        if (!eventStatus) {
            eventStatus = {
                totalStaked: 0,
                slotsRemaining: TOTAL_SLOTS,
                winnersDeclared: 0,
                eventStart: new Date(),
                eventEnd: new Date(Date.now() + 95 * 60 * 60 * 1000) // 95 hours
            };
            await event.insertOne(eventStatus);
        }

        // Prepare response
        res.json({
            user: {
                ...user,
                referralLink: `https://xtrashare-bxc.vercel.app/?ref=${user.referralCode}`,
                pendingReward: {
                    rewardAvailableAt: user.lastRewardTime ? 
                        new Date(user.lastRewardTime.getTime() + 24 * 60 * 60 * 1000) : null,
                    isRevealed: user.claimedReward,
                    message: user.lastRewardAmount > 0 ? 
                        `You won ${user.lastRewardAmount} BXC!` : "Better luck next time",
                    isLose: user.lastRewardAmount === 0
                }
            },
            event: eventStatus
        });

    } catch (error) {
        console.error("Status error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Process Stake
app.post('/api/stake', async (req, res) => {
    try {
        const { walletAddress, referrerRef } = req.body;
        const users = db.collection('users');
        const event = db.collection('event');

        // Check event status
        const eventStatus = await event.findOne({});
        if (eventStatus.totalStaked >= TOTAL_SLOTS) {
            return res.status(400).json({ error: "All staking slots are filled" });
        }

        // Check if already staked
        const user = await users.findOne({ walletAddress: walletAddress.toLowerCase() });
        if (user && user.slotsStaked > 0) {
            return res.status(400).json({ error: "Already staked" });
        }

        // Determine if winner
        const isWinner = winningSlots.has(eventStatus.totalStaked + 1);
        const rewardAmount = isWinner ? 
            Math.floor(Math.random() * (MAX_REWARD - MIN_REWARD + 1)) + MIN_REWARD : 0;

        // Process referral
        if (referrerRef && referrerRef.length === 6) {
            await users.updateOne(
                { referralCode: referrerRef.toLowerCase() },
                { $inc: { BXC_Balance: REFERRAL_BXC, referralCount: 1 } }
            );
        }

        // Update user
        await users.updateOne(
            { walletAddress: walletAddress.toLowerCase() },
            {
                $set: {
                    slotsStaked: 1,
                    BXC_Balance: INITIAL_BXC + (isWinner ? rewardAmount : 0),
                    lastRewardAmount: rewardAmount,
                    claimedReward: false,
                    referralCode: walletAddress.slice(-6).toLowerCase()
                },
                $inc: { referralCount: 0 }
            },
            { upsert: true }
        );

        // Update event
        await event.updateOne(
            {},
            {
                $inc: {
                    totalStaked: 1,
                    slotsRemaining: -1,
                    winnersDeclared: isWinner ? 1 : 0
                }
            }
        );

        res.json({
            message: "Stake successful!",
            isWinner,
            rewardAmount,
            referralLink: `https://xtrashare-bxc.vercel.app/?ref=${walletAddress.slice(-6).toLowerCase()}`
        });

    } catch (error) {
        console.error("Stake error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// [
