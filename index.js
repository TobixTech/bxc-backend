require('dotenv').config();
const express = require('express');
const { MongoClient, ServerApiVersion } = require('mongodb');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 5000;

// ======================
// CORS Configuration (ONLY ADDITION)
// ======================
const corsOptions = {
  origin: "https://xtrashare-bxc.vercel.app",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: true
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Preflight handling
// ======================

app.use(express.json());

// --- MongoDB Connection --- 
const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'ExtraShare';

let client;

async function connectToMongo() {
  if (!uri) {
    console.error("MONGODB_URI is not set. Please provide it in .env or as Fly.io secret.");
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

// --- Constants ---
const INITIAL_STAKE_AMOUNT = 8;
const INITIAL_BXC = 8000;    
const REFERRAL_BXC = 1050;   
const DAILY_REWARD_USD_MIN = 10;
const DAILY_REWARD_USD_MAX = 99;
const LUCKY_WIN_CHANCE = 0.1;
const LUCKY_WIN_USD_BONUS_MIN = 100;
const LUCKY_WIN_USD_BONUS_MAX = 899;
const REFERRAL_COPY_BXC_BONUS = 50;
const EVENT_DURATION_HOURS = 95;
const MAX_STAKE_SLOTS = 30000;

// --- API Routes ---

// Health Check Endpoint
app.get('/api/health', (req, res) => {
    if (client && client.db) {
        res.status(200).json({ status: 'ok', message: 'Backend is healthy and connected to DB.' });
    } else {
        res.status(500).json({ status: 'error', message: 'Backend is running but DB connection is not established.' });
    }
});

// Status Endpoint
app.post('/api/status', async (req, res) => {
    const { walletAddress } = req.body;

    if (!walletAddress) {
        return res.status(400).json({ message: "Wallet address is required." });
    }

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const globalStateCollection = db.collection('globalState');

        let user = await usersCollection.findOne({ walletAddress: walletAddress.toLowerCase() });
        if (!user) {
            user = {
                walletAddress: walletAddress.toLowerCase(),
                slotsStaked: 0,
                stakedUSDValue: 0,
                BXC_Balance: 0,
                claimedEventRewardTime: null,
                collectedEventRewardTime: null,
                lastRevealedUSDAmount: 0,
                lastReferralCopyBonusGiven: null,
                referralCode: walletAddress.toLowerCase().slice(-6),
                referralCount: 0,
                createdAt: new Date(),
                stakeTransactions: []
            };
            await usersCollection.insertOne(user);
        }

        let globalState = await globalStateCollection.findOne({});
        if (!globalState) {
            const now = new Date();
            const eventEndTime = new Date(now.getTime() + EVENT_DURATION_HOURS * 60 * 60 * 1000);
            globalState = {
                totalSlotsUsed: 0,
                totalUsers: 0,
                eventStartTime: now,
                eventEndTime: eventEndTime,
                lastResetTime: now
            };
            await globalStateCollection.insertOne(globalState);
        }

        res.json({
            user: {
                walletAddress: user.walletAddress,
                slotsStaked: user.slotsStaked,
                stakedUSDValue: user.stakedUSDValue,
                BXC_Balance: user.BXC_Balance,
                claimedEventRewardTime: user.claimedEventRewardTime,
                collectedEventRewardTime: user.collectedEventRewardTime,
                lastRevealedUSDAmount: user.lastRevealedUSDAmount,
                lastReferralCopyBonusGiven: user.lastReferralCopyBonusGiven,
                referralCode: user.referralCode,
                referralCount: user.referralCount,
                createdAt: user.createdAt,
                stakeTransactions: user.stakeTransactions
            },
            global: {
                totalSlotsUsed: globalState.totalSlotsUsed,
                totalUsers: globalState.totalUsers,
                eventStartTime: globalState.eventStartTime,
                eventEndTime: globalState.eventEndTime,
                serverTime: new Date(),
                MAX_STAKE_SLOTS: MAX_STAKE_SLOTS
            },
            message: "Status fetched successfully."
        });

    } catch (error) {
        console.error("Error fetching status:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});

// Stake Endpoint
app.post('/api/stake', async (req, res) => {
    const { walletAddress, referrerRef, transactionHash } = req.body;

    if (!walletAddress || !transactionHash) {
        return res.status(400).json({ message: "Wallet address and transaction hash are required." });
    }

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const globalStateCollection = db.collection('globalState');

        let user = await usersCollection.findOne({ walletAddress: walletAddress.toLowerCase() });
        let globalState = await globalStateCollection.findOne({});

        if (globalState.totalSlotsUsed >= MAX_STAKE_SLOTS) {
            return res.status(400).json({ message: "All staking slots are currently filled." });
        }

        if (user && user.stakeTransactions?.some(tx => tx.hash === transactionHash)) {
            return res.status(400).json({ message: "This transaction has already been recorded." });
        }

        if (!user) {
            user = {
                walletAddress: walletAddress.toLowerCase(),
                slotsStaked: 0,
                stakedUSDValue: 0,
                BXC_Balance: 0,
                claimedEventRewardTime: null,
                collectedEventRewardTime: null,
                lastRevealedUSDAmount: 0,
                lastReferralCopyBonusGiven: null,
                referralCode: walletAddress.slice(-6),
                referralCount: 0,
                createdAt: new Date(),
                stakeTransactions: []
            };
            await usersCollection.insertOne(user);
        }

        await usersCollection.updateOne(
            { walletAddress: walletAddress.toLowerCase() },
            {
                $inc: { slotsStaked: 1, BXC_Balance: INITIAL_BXC },
                $set: { stakedUSDValue: INITIAL_STAKE_AMOUNT },
                $push: { stakeTransactions: { hash: transactionHash, timestamp: new Date() } }
            }
        );

        await globalStateCollection.updateOne(
            {},
            { $inc: { totalSlotsUsed: 1, totalUsers: (user.slotsStaked === 0 ? 1 : 0) } },
            { upsert: true }
        );

        if (referrerRef && referrerRef.toLowerCase() !== walletAddress.slice(-6).toLowerCase()) {
            const referrer = await usersCollection.findOne({ referralCode: referrerRef.toLowerCase() });
            if (referrer) {
                await usersCollection.updateOne(
                    { walletAddress: referrer.walletAddress },
                    { $inc: { BXC_Balance: REFERRAL_BXC, referralCount: 1 } }
                );
            }
        }

        const updatedUser = await usersCollection.findOne({ walletAddress: walletAddress.toLowerCase() });
        const updatedGlobalState = await globalStateCollection.findOne({});

        res.status(200).json({
            message: "Stake successful! Welcome to ExtraShare BXC!",
            transactionHash: transactionHash,
            user: {
                walletAddress: updatedUser.walletAddress,
                slotsStaked: updatedUser.slotsStaked,
                stakedUSDValue: updatedUser.stakedUSDValue,
                BXC_Balance: updatedUser.BXC_Balance,
                claimedEventRewardTime: updatedUser.claimedEventRewardTime,
                collectedEventRewardTime: updatedUser.collectedEventRewardTime,
                lastRevealedUSDAmount: updatedUser.lastRevealedUSDAmount,
                lastReferralCopyBonusGiven: updatedUser.lastReferralCopyBonusGiven,
                referralCode: updatedUser.referralCode,
                referralCount: updatedUser.referralCount,
                stakeTransactions: updatedUser.stakeTransactions
            },
            global: {
                totalSlotsUsed: updatedGlobalState.totalSlotsUsed,
                totalUsers: updatedGlobalState.totalUsers,
                eventStartTime: updatedGlobalState.eventStartTime,
                eventEndTime: updatedGlobalState.eventEndTime,
                MAX_STAKE_SLOTS: MAX_STAKE_SLOTS
            }
        });

    } catch (error) {
        console.error("Error during stake:", error);
        res.status(500).json({ message: "Internal server error during stake processing." });
    }
});

// Reveal Reward Endpoint
app.post('/api/reveal-reward', async (req, res) => {
    const { walletAddress } = req.body;

    if (!walletAddress) {
        return res.status(400).json({ message: "Wallet address is required." });
    }

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const globalStateCollection = db.collection('globalState');

        const user = await usersCollection.findOne({ walletAddress: walletAddress.toLowerCase() });
        const globalState = await globalStateCollection.findOne({});

        if (!user || user.slotsStaked === 0) {
            return res.status(400).json({ message: "You must stake first to reveal rewards." });
        }

        const now = new Date();
        if (!globalState || now < globalState.eventStartTime || now > globalState.eventEndTime) {
            return res.status(400).json({ message: "Reward event is not active or has ended." });
        }

        if (user.claimedEventRewardTime && user.claimedEventRewardTime >= globalState.eventStartTime) {
            const message = user.lastRevealedUSDAmount === 0
                ? "You revealed $0. Better luck next time!"
                : `You already revealed $${user.lastRevealedUSDAmount}!`;
            
            return res.status(200).json({
                message: message,
                rewardAmount: user.lastRevealedUSDAmount,
                isLose: user.lastRevealedUSDAmount === 0,
                user: {
                    stakedUSDValue: user.stakedUSDValue,
                    BXC_Balance: user.BXC_Balance,
                    claimedEventRewardTime: user.claimedEventRewardTime,
                    collectedEventRewardTime: user.collectedEventRewardTime
                }
            });
        }

        let rewardAmountUSD;
        let isLose = false;
        const randomValue = Math.random();

        if (randomValue < LUCKY_WIN_CHANCE) {
            rewardAmountUSD = Math.floor(Math.random() * (LUCKY_WIN_USD_BONUS_MAX - LUCKY_WIN_USD_BONUS_MIN + 1)) + LUCKY_WIN_USD_BONUS_MIN;
        } else if (randomValue < (LUCKY_WIN_CHANCE + 0.5)) {
            rewardAmountUSD = Math.floor(Math.random() * (DAILY_REWARD_USD_MAX - DAILY_REWARD_USD_MIN + 1)) + DAILY_REWARD_USD_MIN;
        } else {
            rewardAmountUSD = 0;
            isLose = true;
        }

        await usersCollection.updateOne(
            { walletAddress: walletAddress.toLowerCase() },
            {
                $set: {
                    claimedEventRewardTime: now,
                    lastRevealedUSDAmount: rewardAmountUSD,
                }
            }
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: walletAddress.toLowerCase() });

        res.status(200).json({
            message: `You revealed $${rewardAmountUSD}!`,
            rewardAmount: rewardAmountUSD,
            isLose: isLose,
            user: {
                stakedUSDValue: updatedUser.stakedUSDValue,
                BXC_Balance: updatedUser.BXC_Balance,
                claimedEventRewardTime: updatedUser.claimedEventRewardTime,
                collectedEventRewardTime: updatedUser.collectedEventRewardTime
            }
        });

    } catch (error) {
        console.error("Error revealing reward:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});

// Collect Reward Endpoint
app.post('/api/collect-reward', async (req, res) => {
    const { walletAddress } = req.body;

    if (!walletAddress) {
        return res.status(400).json({ message: "Wallet address is required." });
    }

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const globalStateCollection = db.collection('globalState');

        const user = await usersCollection.findOne({ walletAddress: walletAddress.toLowerCase() });
        const globalState = await globalStateCollection.findOne({});

        if (!user || user.slotsStaked === 0) {
            return res.status(400).json({ message: "You must stake first to collect rewards." });
        }

        const now = new Date();
        if (!globalState || now < globalState.eventStartTime || now > globalState.eventEndTime) {
            return res.status(400).json({ message: "Reward event is not active or has ended." });
        }

        if (!user.claimedEventRewardTime || user.claimedEventRewardTime < globalState.eventStartTime) {
            return res.status(400).json({ message: "You must reveal your reward first!" });
        }

        if (user.collectedEventRewardTime && user.collectedEventRewardTime >= globalState.eventStartTime) {
            return res.status(400).json({ message: "You have already collected this event's reward." });
        }
        
        const rewardToCollectUSD = user.lastRevealedUSDAmount || 0;

        await usersCollection.updateOne(
            { walletAddress: walletAddress.toLowerCase() },
            {
                $inc: { stakedUSDValue: rewardToCollectUSD },
                $set: { collectedEventRewardTime: now }
            }
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: walletAddress.toLowerCase() });

        res.status(200).json({
            message: `Successfully collected $${rewardToCollectUSD} and added to your staked balance!`,
            collectedAmount: rewardToCollectUSD,
            user: {
                stakedUSDValue: updatedUser.stakedUSDValue,
                BXC_Balance: updatedUser.BXC_Balance,
                claimedEventRewardTime: updatedUser.claimedEventRewardTime,
                collectedEventRewardTime: updatedUser.collectedEventRewardTime
            }
        });

    } catch (error) {
        console.error("Error collecting reward:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});

// Withdraw Endpoint
app.post('/api/withdraw', async (req, res) => {
    const { walletAddress, amount } = req.body;

    if (!walletAddress) {
        return res.status(400).json({ message: "Wallet address is required." });
    }

    try {
        const db = getDb();
        const usersCollection = db.collection('users');

        const user = await usersCollection.findOne({ walletAddress: walletAddress.toLowerCase() });

        if (!user || user.BXC_Balance <= 0) {
            return res.status(400).json({ message: "No BXC balance to withdraw." });
        }

        const withdrawAmount = (amount && amount > 0 && amount <= user.BXC_Balance) ? amount : user.BXC_Balance;

        await usersCollection.updateOne(
            { walletAddress: walletAddress.toLowerCase() },
            { $inc: { BXC_Balance: -withdrawAmount } }
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: walletAddress.toLowerCase() });

        res.status(200).json({
            message: `${withdrawAmount.toFixed(0)} BXC successfully withdrawn (simulated).`,
            withdrawnAmount: withdrawAmount,
            user: {
                BXC_Balance: updatedUser.BXC_Balance
            }
        });

    } catch (error) {
        console.error("Error during withdrawal:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});

// Referral Copied Endpoint
app.post('/api/referral-copied', async (req, res) => {
    const { walletAddress } = req.body;

    if (!walletAddress) {
        return res.status(400).json({ message: "Wallet address is required." });
    }

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const globalStateCollection = db.collection('globalState');

        const user = await usersCollection.findOne({ walletAddress: walletAddress.toLowerCase() });
        const globalState = await globalStateCollection.findOne({});

        if (!user || user.slotsStaked === 0) {
            return res.status(400).json({ message: "Stake at least once to earn referral copy bonuses!" });
        }

        const now = new Date();
        if (user.lastReferralCopyBonusGiven && user.lastReferralCopyBonusGiven >= globalState.eventStartTime) {
             return res.status(400).json({ message: "You've already received the referral copy bonus for this event." });
        }

        await usersCollection.updateOne(
            { walletAddress: walletAddress.toLowerCase() },
            {
                $inc: { BXC_Balance: REFERRAL_COPY_BXC_BONUS },
                $set: { lastReferralCopyBonusGiven: now }
            }
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: walletAddress.toLowerCase() });

        res.status(200).json({
            message: `You received ${REFERRAL_COPY_BXC_BONUS} BXC for copying the referral link!`,
            awardedAmount: REFERRAL_COPY_BXC_BONUS,
            user: {
                BXC_Balance: updatedUser.BXC_Balance
            }
        });

    } catch (error) {
        console.error("Error awarding referral copy bonus:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});

// ===========================================
// Server Startup (WITH CORS FIXES APPLIED)
// ===========================================
connectToMongo()
  .then(() => {
    app.listen(port, () => {
      console.log(`🚀 Backend running on port ${port}`);
      console.log(`🔒 CORS restricted to: https://xtrashare-bxc.vercel.app`);
    });
  })
  .catch(err => {
    console.error("💥 Failed to start:", err);
    process.exit(1);
  });
