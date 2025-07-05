// backend/index.js (formerly api/index.js)

require('dotenv').config(); // Load environment variables from .env file for local development

const express = require('express');
const { MongoClient, ServerApiVersion } = require('mongodb');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 5000; // Use port from environment (Fly.io will set this) or default to 5000

// --- Middleware ---
app.use(cors()); // Enable CORS for all routes, allowing frontend access
app.use(express.json()); // Enable JSON body parsing for incoming requests

// --- MongoDB Connection ---
const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'ExtraShare';

let client; // Declare client globally

async function connectToMongo() {
  if (!uri) {
    console.error("MONGODB_URI is not set. Please provide it in .env or as Fly.io secret.");
    process.exit(1); // Exit if critical env var is missing
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

// Helper to get DB instance, ensuring connection is established/reused
function getDb() {
    if (!client || !client.db) {
        throw new Error("MongoDB client not connected.");
    }
    return client.db(dbName);
}

// --- BXC Token Constants & Event Constants ---
const INITIAL_BXC = 8000;     // BXC awarded for initial stake
const REFERRAL_BXC = 1050;    // BXC awarded to referrer
const DAILY_REWARD_MIN = 10;  // Minimum BXC for event flip card reward
const DAILY_REWARD_MAX = 99;  // Maximum BXC for event flip card reward
const LUCKY_WIN_CHANCE = 0.1; // 10% chance for a lucky win (0.1 = 10%)
const LUCKY_WIN_BONUS_MIN = 100; // Minimum additional BXC for a lucky win
const LUCKY_WIN_BONUS_MAX = 899; // Maximum additional BXC for a lucky win

const EVENT_DURATION_HOURS = 95; // Global event duration
const MAX_STAKE_SLOTS = 75000; // NEW: Maximum total staking slots available

// --- API Routes ---

// Health Check Endpoint (IMPORTANT for Fly.io monitoring)
app.get('/api/health', (req, res) => {
    if (client && client.db) { // Simple check, more robust would be a ping
        res.status(200).json({ status: 'ok', message: 'Backend is healthy and connected to DB.' });
    } else {
        res.status(500).json({ status: 'error', message: 'Backend is running but DB connection is not established.' });
    }
});


// 1. POST /api/status - Get global status and user-specific data
app.post('/api/status', async (req, res) => {
    const { walletAddress } = req.body;

    if (!walletAddress) {
        return res.status(400).json({ message: "Wallet address is required." });
    }

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const globalStateCollection = db.collection('globalState');

        // Get user data
        let user = await usersCollection.findOne({ walletAddress: walletAddress.toLowerCase() });
        if (!user) {
            // Create a new user if they don't exist
            user = {
                walletAddress: walletAddress.toLowerCase(),
                slotsStaked: 0,
                BXC_Balance: 0,
                claimedEventRewardTime: null, // NEW: When this user claimed their ONE-TIME event reward
                referralCode: walletAddress.toLowerCase().slice(-6), // Last 6 digits
                referralCount: 0, // Number of users referred
                createdAt: new Date()
            };
            await usersCollection.insertOne(user);
        }

        // Get global state and ensure event times are set
        let globalState = await globalStateCollection.findOne({});
        if (!globalState) {
            // Initialize global state for the first time
            const now = new Date();
            const eventEndTime = new Date(now.getTime() + EVENT_DURATION_HOURS * 60 * 60 * 1000);
            globalState = {
                totalSlotsUsed: 0,
                totalUsers: 0,
                eventStartTime: now, // NEW: When the current event started
                eventEndTime: eventEndTime, // NEW: When the current event ends (95 hours from now)
                lastResetTime: now // Still useful for general resets if needed later
            };
            await globalStateCollection.insertOne(globalState);
            console.log(`Global event started. Ends at: ${globalState.eventEndTime}`);
        } else {
             // If global state exists but event times are missing (e.g., first deployment change)
             // Or if you want to reset the event automatically if it has ended
             const now = new Date();
             if (!globalState.eventStartTime || !globalState.eventEndTime || now > globalState.eventEndTime) {
                 console.log("Global event either not set or has ended. Resetting/Starting new event.");
                 globalState.eventStartTime = now;
                 globalState.eventEndTime = new Date(now.getTime() + EVENT_DURATION_HOURS * 60 * 60 * 1000);
                 await globalStateCollection.updateOne({}, { $set: {
                     eventStartTime: globalState.eventStartTime,
                     eventEndTime: globalState.eventEndTime
                 }});
             }
        }


        res.json({
            user: {
                walletAddress: user.walletAddress,
                slotsStaked: user.slotsStaked,
                BXC_Balance: user.BXC_Balance,
                claimedEventRewardTime: user.claimedEventRewardTime, // NEW
                referralCode: user.referralCode,
                referralCount: user.referralCount,
                createdAt: user.createdAt
            },
            global: {
                totalSlotsUsed: globalState.totalSlotsUsed,
                totalUsers: globalState.totalUsers,
                eventStartTime: globalState.eventStartTime, // NEW
                eventEndTime: globalState.eventEndTime,   // NEW
                serverTime: new Date(), // Provide server time for client-side sync
                MAX_STAKE_SLOTS: MAX_STAKE_SLOTS // NEW: Provide max slots to frontend
            },
            message: "Status fetched successfully."
        });

    } catch (error) {
        console.error("Error fetching status:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});

// 2. POST /api/stake - Handle the BNB staking transaction and BXC reward
app.post('/api/stake', async (req, res) => {
    const { walletAddress, referrerRef } = req.body;

    if (!walletAddress) {
        return res.status(400).json({ message: "Wallet address is required." });
    }

    const userWalletAddress = walletAddress.toLowerCase();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const globalStateCollection = db.collection('globalState');

        let user = await usersCollection.findOne({ walletAddress: userWalletAddress });
        let globalState = await globalStateCollection.findOne({}); // Fetch global state to check limit

        // --- NEW: Check if max slots reached ---
        if (globalState.totalSlotsUsed >= MAX_STAKE_SLOTS) {
            return res.status(400).json({ message: "All staking slots are currently filled. Please check back later." });
        }

        if (user && user.slotsStaked > 0) {
            return res.status(400).json({ message: "You have already completed the one-time stake." });
        }

        if (!user) { // If user doesn't exist, create them
            user = {
                walletAddress: userWalletAddress,
                slotsStaked: 0,
                BXC_Balance: 0,
                claimedEventRewardTime: null, // NEW
                referralCode: userWalletAddress.slice(-6),
                referralCount: 0,
                createdAt: new Date()
            };
            await usersCollection.insertOne(user);
        }

        // --- Process the stake ---
        const updateResult = await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $inc: { slotsStaked: 1, BXC_Balance: INITIAL_BXC }, // Increment stake count and add initial BXC
                // claimedEventRewardTime is not set here, only on reward claim
            }
        );

        if (updateResult.modifiedCount === 0 && updateResult.upsertedCount === 0) {
             console.warn(`Stake update failed for ${userWalletAddress}, attempting re-fetch.`);
            const confirmedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });
            if (confirmedUser && confirmedUser.slotsStaked > 0) {
                 return res.status(400).json({ message: "Stake already recorded or processed. No duplicate." });
            }
            return res.status(500).json({ message: "Failed to record stake. Please try again." });
        }

        // --- Update Global State ---
        await globalStateCollection.updateOne(
            {},
            { $inc: { totalSlotsUsed: 1, totalUsers: (user.slotsStaked === 0 ? 1 : 0) } }, // Increment total users if new user
            { upsert: true } // Create if not exists
        );

        // --- Handle Referral Bonus (if applicable) ---
        if (referrerRef && referrerRef.toLowerCase() !== userWalletAddress.slice(-6).toLowerCase()) {
            const referrer = await usersCollection.findOne({ referralCode: referrerRef.toLowerCase() });
            if (referrer) {
                await usersCollection.updateOne(
                    { walletAddress: referrer.walletAddress },
                    { $inc: { BXC_Balance: REFERRAL_BXC, referralCount: 1 } } // Award BXC to referrer
                );
                console.log(`Referral bonus of ${REFERRAL_BXC} BXC given to ${referrer.walletAddress} for referring ${userWalletAddress}`);
            }
        }

        const updatedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });
        const updatedGlobalState = await globalStateCollection.findOne({});

        res.status(200).json({
            message: "Stake successful! Welcome to ExtraShare BXC!",
            user: {
                walletAddress: updatedUser.walletAddress,
                slotsStaked: updatedUser.slotsStaked,
                BXC_Balance: updatedUser.BXC_Balance,
                claimedEventRewardTime: updatedUser.claimedEventRewardTime,
                referralCode: updatedUser.referralCode,
                referralCount: updatedUser.referralCount
            },
            global: {
                totalSlotsUsed: updatedGlobalState.totalSlotsUsed,
                totalUsers: updatedGlobalState.totalUsers,
                eventStartTime: updatedGlobalState.eventStartTime,
                eventEndTime: updatedGlobalState.eventEndTime,
                MAX_STAKE_SLOTS: MAX_STAKE_SLOTS // NEW: Provide max slots to frontend
            }
        });

    } catch (error) {
        console.error("Error during stake:", error);
        res.status(500).json({ message: "Internal server error during stake processing." });
    }
});

// 3. POST /api/reveal-reward - Handle one-time event reward claim
app.post('/api/reveal-reward', async (req, res) => {
    const { walletAddress } = req.body;

    if (!walletAddress) {
        return res.status(400).json({ message: "Wallet address is required." });
    }

    const userWalletAddress = walletAddress.toLowerCase();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const globalStateCollection = db.collection('globalState');

        const user = await usersCollection.findOne({ walletAddress: userWalletAddress });
        const globalState = await globalStateCollection.findOne({});

        if (!user || user.slotsStaked === 0) {
            return res.status(400).json({ message: "You must stake first to reveal rewards." });
        }

        const now = new Date();
        if (!globalState || now < globalState.eventStartTime || now > globalState.eventEndTime) {
            return res.status(400).json({ message: "Reward event is not active or has ended." });
        }

        // Check if user has already claimed for THIS specific event
        // We compare user's claimed time to the *start* of the current event
        if (user.claimedEventRewardTime && user.claimedEventRewardTime >= globalState.eventStartTime) {
            return res.status(400).json({ message: "You have already claimed your reward for this event." });
        }

        // Calculate reward
        let rewardAmount;
        let isLose = false;
        const randomValue = Math.random(); // 0 to 1

        if (randomValue < 0.1) { // 10% chance to win large
            rewardAmount = Math.floor(Math.random() * (LUCKY_WIN_BONUS_MAX - LUCKY_WIN_BONUS_MIN + 1)) + LUCKY_WIN_BONUS_MIN;
        } else if (randomValue < 0.6) { // 50% chance to win small to medium
            rewardAmount = Math.floor(Math.random() * (DAILY_REWARD_MAX - DAILY_REWARD_MIN + 1)) + DAILY_REWARD_MIN;
        } else { // 40% chance to get 0
            rewardAmount = 0;
            isLose = true;
        }

        // Update user's BXC balance and set the one-time event reward claim timestamp
        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $inc: { BXC_Balance: rewardAmount },
                $set: { claimedEventRewardTime: now } // NEW: Record when they claimed for THIS event
            }
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });

        res.status(200).json({
            message: `You revealed ${rewardAmount} BXC!`,
            rewardAmount: rewardAmount,
            isLose: isLose,
            user: {
                BXC_Balance: updatedUser.BXC_Balance,
                claimedEventRewardTime: updatedUser.claimedEventRewardTime
            }
        });

    } catch (error) {
        console.error("Error revealing reward:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});

// 4. POST /api/withdraw - Handle BXC withdrawal
app.post('/api/withdraw', async (req, res) => {
    const { walletAddress, amount } = req.body;

    if (!walletAddress) {
        return res.status(400).json({ message: "Wallet address is required." });
    }

    const userWalletAddress = walletAddress.toLowerCase();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');

        const user = await usersCollection.findOne({ walletAddress: userWalletAddress });

        if (!user || user.BXC_Balance <= 0) {
            return res.status(400).json({ message: "No BXC balance to withdraw." });
        }

        const withdrawAmount = amount && amount > 0 && amount <= user.BXC_Balance ? amount : user.BXC_Balance;

        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            { $inc: { BXC_Balance: -withdrawAmount } } // Deduct from balance
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });

        res.status(200).json({
            message: `${withdrawAmount} BXC successfully withdrawn (simulated).`,
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


// --- Server Listener for Fly.io ---
connectToMongo().then(() => {
    app.listen(port, () => {
        console.log(`Backend server running on port ${port}`);
    });
}).catch(err => {
    console.error("Failed to start server due to MongoDB connection error:", err);
    process.exit(1);
});
