// backend/index.js

require('dotenv').config(); // Load environment variables from .env file for local development

const express = require('express');
const { MongoClient, ServerApiVersion } = require('mongodb');
const cors = require('cors');

app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));
const port = process.env.PORT || 5000; // Use port from environment (Fly.io will set this) or default to 5000

// --- Middleware ---
app.use(cors()); // Enable CORS for all routes, allowing frontend access
app.use(express.json()); // Enable JSON body parsing for incoming requests

// --- MongoDB Connection ---
const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'ExtraShare'; // Your database name

let client; // Declare client globally

async function connectToMongo() {
  if (!uri) {
    console.error("MONGODB_URI is not set. Please provide it in .env or as Fly.io secret.");
    // In a production environment like Fly.io, process.exit(1) is common for critical failures.
    // For local dev, you might just log and continue, but it won't work without the URI.
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
    throw err; // Propagate error to prevent server from starting if DB connection fails
  }
}

// Helper to get DB instance, ensuring connection is established/reused
function getDb() {
    if (!client || !client.db) {
        throw new Error("MongoDB client not connected.");
    }
    return client.db(dbName);
}

// --- Constants ---
const INITIAL_STAKE_AMOUNT = 8; // The fixed initial USD stake
const INITIAL_BXC = 8000;     // BXC awarded for initial stake
const REFERRAL_BXC = 1050;    // BXC awarded to referrer
const DAILY_REWARD_USD_MIN = 10;  // Minimum USD for event flip card reward (regular win)
const DAILY_REWARD_USD_MAX = 99;  // Maximum USD for event flip card reward (regular win)
const LUCKY_WIN_CHANCE = 0.1; // 10% chance for a lucky win (0.1 = 10%)
const LUCKY_WIN_USD_BONUS_MIN = 100; // Minimum additional USD for a lucky win
const LUCKY_WIN_USD_BONUS_MAX = 899; // Maximum additional USD for a lucky win
const REFERRAL_COPY_BXC_BONUS = 50; // BXC awarded for copying referral link/code

const EVENT_DURATION_HOURS = 95; // Global event duration
const MAX_STAKE_SLOTS = 30000; // Maximum total staking slots available

// --- API Routes ---

// Health Check Endpoint (IMPORTANT for Fly.io monitoring)
app.get('/api/health', (req, res) => {
    if (client && client.db) { // Simple check: is client object and its db method available?
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
                stakedUSDValue: 0, // NEW: Tracks total USD value including rewards
                BXC_Balance: 0,
                claimedEventRewardTime: null, // When the reward was *revealed* for this event cycle
                collectedEventRewardTime: null, // When the reward was *collected* for this event cycle
                lastRevealedUSDAmount: 0, // NEW: Stores the USD reward revealed (before collection)
                lastReferralCopyBonusGiven: null, // When the last referral copy bonus was given
                referralCode: walletAddress.toLowerCase().slice(-6), // Last 6 digits
                referralCount: 0, // Number of users referred
                createdAt: new Date(),
                stakeTransactions: [] // NEW: To store transaction hashes for stakes
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
                eventStartTime: now, // When the current event started
                eventEndTime: eventEndTime, // When the current event ends (95 hours from now)
                lastResetTime: now // Still useful for general resets if needed later
            };
            await globalStateCollection.insertOne(globalState);
            console.log(`Global event started. Ends at: ${globalState.eventEndTime}`);
        } else {
             // If global state exists but event times are missing or event has ended, reset/start new event
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
                stakedUSDValue: user.stakedUSDValue, // NEW
                BXC_Balance: user.BXC_Balance,
                claimedEventRewardTime: user.claimedEventRewardTime,
                collectedEventRewardTime: user.collectedEventRewardTime,
                lastRevealedUSDAmount: user.lastRevealedUSDAmount, // NEW
                lastReferralCopyBonusGiven: user.lastReferralCopyBonusGiven,
                referralCode: user.referralCode,
                referralCount: user.referralCount,
                createdAt: user.createdAt,
                stakeTransactions: user.stakeTransactions // NEW
            },
            global: {
                totalSlotsUsed: globalState.totalSlotsUsed,
                totalUsers: globalState.totalUsers,
                eventStartTime: globalState.eventStartTime,
                eventEndTime: globalState.eventEndTime,
                serverTime: new Date(), // Provide server time for client-side sync
                MAX_STAKE_SLOTS: MAX_STAKE_SLOTS
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
    const { walletAddress, referrerRef, transactionHash } = req.body; // <-- transactionHash added

    if (!walletAddress) {
        return res.status(400).json({ message: "Wallet address is required." });
    }
    if (!transactionHash) { // Ensure transaction hash is sent for real stakes
        return res.status(400).json({ message: "Transaction hash is required for staking." });
    }

    const userWalletAddress = walletAddress.toLowerCase();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const globalStateCollection = db.collection('globalState');

        let user = await usersCollection.findOne({ walletAddress: userWalletAddress });
        let globalState = await globalStateCollection.findOne({});

        // --- Check if max slots reached ---
        if (globalState.totalSlotsUsed >= MAX_STAKE_SLOTS) {
            return res.status(400).json({ message: "All staking slots are currently filled. Please check back later." });
        }

        // Check if transaction hash already recorded to prevent duplicate stakes
        if (user && user.stakeTransactions && user.stakeTransactions.some(tx => tx.hash === transactionHash)) {
            return res.status(400).json({ message: "This transaction has already been recorded." });
        }

        if (user && user.slotsStaked > 0) {
            return res.status(400).json({ message: "You have already completed the one-time stake." });
        }

        if (!user) { // If user doesn't exist, create them
            user = {
                walletAddress: userWalletAddress,
                slotsStaked: 0,
                stakedUSDValue: 0, // NEW
                BXC_Balance: 0,
                claimedEventRewardTime: null,
                collectedEventRewardTime: null,
                lastRevealedUSDAmount: 0, // NEW
                lastReferralCopyBonusGiven: null,
                referralCode: userWalletAddress.slice(-6),
                referralCount: 0,
                createdAt: new Date(),
                stakeTransactions: [] // NEW
            };
            await usersCollection.insertOne(user);
        }

        // --- Process the stake ---
        // $inc increments, $set sets a value, $push adds to an array
        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $inc: { slotsStaked: 1, BXC_Balance: INITIAL_BXC },
                $set: { stakedUSDValue: INITIAL_STAKE_AMOUNT }, // Set initial $8 stake
                $push: { stakeTransactions: { hash: transactionHash, timestamp: new Date() } } // Store hash
            }
        );

        // --- Update Global State ---
        await globalStateCollection.updateOne(
            {},
            { $inc: { totalSlotsUsed: 1, totalUsers: (user.slotsStaked === 0 ? 1 : 0) } },
            { upsert: true }
        );

        // --- Handle Referral Bonus (if applicable) ---
        if (referrerRef && referrerRef.toLowerCase() !== userWalletAddress.slice(-6).toLowerCase()) {
            const referrer = await usersCollection.findOne({ referralCode: referrerRef.toLowerCase() });
            if (referrer) {
                await usersCollection.updateOne(
                    { walletAddress: referrer.walletAddress },
                    { $inc: { BXC_Balance: REFERRAL_BXC, referralCount: 1 } }
                );
                console.log(`Referral bonus of ${REFERRAL_BXC} BXC given to ${referrer.walletAddress} for referring ${userWalletAddress}`);
            }
        }

        // Re-fetch updated user and global state for response
        const updatedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });
        const updatedGlobalState = await globalStateCollection.findOne({});

        res.status(200).json({
            message: "Stake successful! Welcome to ExtraShare BXC!",
            transactionHash: transactionHash, // Include hash in response
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

// 3. POST /api/reveal-reward - Handle one-time event reward claim (reveal only)
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

        // Check if user has already claimed/revealed for THIS specific event cycle
        if (user.claimedEventRewardTime && user.claimedEventRewardTime >= globalState.eventStartTime) {
            // If already revealed, just return the existing reward message and amount
            const message = user.lastRevealedUSDAmount === 0
                ? "You revealed $0. Better luck next time!"
                : `You already revealed $${user.lastRevealedUSDAmount}!`;
            
            return res.status(200).json({
                message: message,
                rewardAmount: user.lastRevealedUSDAmount, // This is now USD reward
                isLose: user.lastRevealedUSDAmount === 0,
                user: {
                    stakedUSDValue: user.stakedUSDValue, // Current USD stake
                    BXC_Balance: user.BXC_Balance, // Current BXC balance
                    claimedEventRewardTime: user.claimedEventRewardTime,
                    collectedEventRewardTime: user.collectedEventRewardTime // Include collected status
                }
            });
        }

        // Calculate USD reward
        let rewardAmountUSD;
        let isLose = false;
        const randomValue = Math.random(); // 0 to 1

        if (randomValue < LUCKY_WIN_CHANCE) { // 10% chance to win large USD
            rewardAmountUSD = Math.floor(Math.random() * (LUCKY_WIN_USD_BONUS_MAX - LUCKY_WIN_USD_BONUS_MIN + 1)) + LUCKY_WIN_USD_BONUS_MIN;
        } else if (randomValue < (LUCKY_WIN_CHANCE + 0.5)) { // 50% chance for regular USD win
            rewardAmountUSD = Math.floor(Math.random() * (DAILY_REWARD_USD_MAX - DAILY_REWARD_USD_MIN + 1)) + DAILY_REWARD_USD_MIN;
        } else { // 40% chance to get 0 USD
            rewardAmountUSD = 0;
            isLose = true;
        }

        // Update user: Set the revealed time and the amount, but DO NOT add to BXC_Balance or stakedUSDValue yet.
        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $set: {
                    claimedEventRewardTime: now, // Mark as revealed
                    lastRevealedUSDAmount: rewardAmountUSD, // Store the USD amount revealed
                }
            }
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });

        res.status(200).json({
            message: `You revealed $${rewardAmountUSD}!`, // Message for USD reward
            rewardAmount: rewardAmountUSD, // This is now USD reward
            isLose: isLose,
            user: {
                stakedUSDValue: updatedUser.stakedUSDValue, // Still current USD stake
                BXC_Balance: updatedUser.BXC_Balance, // Still current BXC balance
                claimedEventRewardTime: updatedUser.claimedEventRewardTime,
                collectedEventRewardTime: updatedUser.collectedEventRewardTime
            }
        });

    } catch (error) {
        console.error("Error revealing reward:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});

// 4. POST /api/collect-reward - New: Handle collection of revealed reward
app.post('/api/collect-reward', async (req, res) => {
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
            return res.status(400).json({ message: "You must stake first to collect rewards." });
        }

        const now = new Date();
        if (!globalState || now < globalState.eventStartTime || now > globalState.eventEndTime) {
            return res.status(400).json({ message: "Reward event is not active or has ended." });
        }

        // Check if reward has been revealed for this event cycle
        if (!user.claimedEventRewardTime || user.claimedEventRewardTime < globalState.eventStartTime) {
            return res.status(400).json({ message: "You must reveal your reward first!" });
        }

        // Check if reward has already been collected for this event cycle
        if (user.collectedEventRewardTime && user.collectedEventRewardTime >= globalState.eventStartTime) {
            return res.status(400).json({ message: "You have already collected this event's reward." });
        }
        
        const rewardToCollectUSD = user.lastRevealedUSDAmount || 0; // Get the previously revealed USD amount

        // Add reward to stakedUSDValue and mark as collected
        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $inc: { stakedUSDValue: rewardToCollectUSD }, // Add to stakedUSDValue
                $set: { collectedEventRewardTime: now } // Mark as collected
            }
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });

        res.status(200).json({
            message: `Successfully collected $${rewardToCollectUSD} and added to your staked balance!`,
            collectedAmount: rewardToCollectUSD,
            user: {
                stakedUSDValue: updatedUser.stakedUSDValue, // Updated staked USD value
                BXC_Balance: updatedUser.BXC_Balance, // BXC balance is unchanged by this
                claimedEventRewardTime: updatedUser.claimedEventRewardTime,
                collectedEventRewardTime: updatedUser.collectedEventRewardTime
            }
        });

    } catch (error) {
        console.error("Error collecting reward:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});


// 5. POST /api/withdraw - Handle BXC withdrawal
app.post('/api/withdraw', async (req, res) => {
    const { walletAddress, amount } = req.body; // Amount is optional, if not provided, withdraw all

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

        // If amount is provided and valid, use it; otherwise, withdraw the entire balance
        const withdrawAmount = (amount && amount > 0 && amount <= user.BXC_Balance) ? amount : user.BXC_Balance;

        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            { $inc: { BXC_Balance: -withdrawAmount } } // Deduct from balance
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });

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


// 6. POST /api/referral-copied - Award BXC for copying referral link/code
app.post('/api/referral-copied', async (req, res) => {
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
            return res.status(400).json({ message: "Stake at least once to earn referral copy bonuses!" });
        }

        const now = new Date();
        // Check if user has already received this specific bonus within the current event cycle
        if (user.lastReferralCopyBonusGiven && user.lastReferralCopyBonusGiven >= globalState.eventStartTime) {
             return res.status(400).json({ message: "You've already received the referral copy bonus for this event." });
        }

        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $inc: { BXC_Balance: REFERRAL_COPY_BXC_BONUS },
                $set: { lastReferralCopyBonusGiven: now } // Mark the time of this bonus
            }
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });

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


// --- Server Listener for Fly.io ---
connectToMongo().then(() => {
    app.listen(port, () => {
        console.log(`Backend server running on port ${port}`);
    });
}).catch(err => {
    console.error("Failed to start server due to MongoDB connection error:", err);
    process.exit(1);
});
