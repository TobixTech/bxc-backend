// backend/index.js

require('dotenv').config(); // Load environment variables from .env file for local development

const express = require('express');
const { MongoClient, ServerApiVersion } = require('mongodb');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 5000; // Use port from environment (Fly.io will set this) or default to 5000

// --- Middleware ---
app.use(cors({
  origin: "*", // IMPORTANT: For production, change this to your frontend domain (e.g., "https://xtrashare-bxc.vercel.app")
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json()); // Enable JSON body parsing for incoming requests

// --- MongoDB Connection ---
const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'ExtraShare'; // Your database name

let client; // Declare client globally

async function connectToMongo() {
  if (!uri) {
    console.error("MONGODB_URI is not set. Please provide it in .env or as Fly.io secret.");
    // In a production environment like Fly.io, process.exit(1) is common for critical failures.
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

// --- Constants (Updated and Added) ---
const INITIAL_STAKE_AMOUNT = 8; // The fixed initial USD stake
const INITIAL_BXC = 8000;     // BXC awarded for initial stake
const BXC_ACCRUAL_PER_SECOND = 0.001; // NEW: BXC accrual rate
const REFERRAL_BXC = 1050;    // BXC awarded to referrer
const REFERRAL_COPY_BXC_BONUS = 50; // BXC awarded for copying referral link/code

const AIN_USD_PRICE = 0.137; // NEW: Current price of AIN in USD
// Reward distribution percentages based on frontend spec:
// 10% chance: $100-$899 (Lucky Winner - "Large")
// 50% chance: $10-$99 (Lucky Winner - "Regular")
// 40% chance: $0 (Not a Lucky Winner this time)
const REWARD_CHANCE_LARGE_WIN = 0.1; 
const REWARD_CHANCE_REGULAR_WIN = 0.5; // (0.1 + 0.5 = 0.6. The remaining 0.4 is $0)

const REWARD_USD_LARGE_MIN = 100; // Minimum USD for large win
const REWARD_USD_LARGE_MAX = 899; // Maximum USD for large win
const REWARD_USD_REGULAR_MIN = 10;  // Minimum USD for regular win
const REWARD_USD_REGULAR_MAX = 99;  // Maximum USD for regular win

const EVENT_DURATION_HOURS = 95; // Global event duration
const MAX_STAKE_SLOTS = 30000; // Maximum total staking slots available
const LUCKY_WINNER_SLOT_THRESHOLD = 9000; // NEW: Number of slots eligible for non-zero AIN rewards


// --- Helper Functions for Backend Logic ---

// NEW: Function to calculate and update BXC balance based on time elapsed
async function calculateAndSaveBXC(user) {
    const db = getDb();
    const usersCollection = db.collection('users');
    const globalStateCollection = db.collection('globalState');
    const globalState = await globalStateCollection.findOne({});

    if (!user.lastBXCAccrualTime || user.slotsStaked === 0) { // Only accrue if user has staked
        // If no last accrual time or hasn't staked, just set it to now (or when they first staked)
        // No accrual calculated yet.
        await usersCollection.updateOne(
            { walletAddress: user.walletAddress },
            { $set: { lastBXCAccrualTime: new Date() } }
        );
        user.lastBXCAccrualTime = new Date();
        return user; // Return user with updated accrual time, balance is still as it was.
    }

    const now = new Date();
    const eventEndTime = globalState ? globalState.eventEndTime : null;

    let accrualUntilTime = now;
    if (eventEndTime && now > eventEndTime) {
        // If current time is past event end, accrue only up to event end time
        accrualUntilTime = eventEndTime;
    }

    // Calculate time elapsed for accrual since last update
    const timeElapsedMs = Math.max(0, accrualUntilTime.getTime() - user.lastBXCAccrualTime.getTime());
    const timeElapsedSeconds = timeElapsedMs / 1000;

    const accruedBXC = timeElapsedSeconds * BXC_ACCRUAL_PER_SECOND;

    if (accruedBXC > 0) {
        user.BXC_Balance = (user.BXC_Balance || 0) + accruedBXC;
        user.lastBXCAccrualTime = now; // Update last accrual time to now

        await usersCollection.updateOne(
            { walletAddress: user.walletAddress },
            { $set: { BXC_Balance: user.BXC_Balance, lastBXCAccrualTime: user.lastBXCAccrualTime } }
        );
        console.log(`Accrued ${accruedBXC.toFixed(4)} BXC for ${user.walletAddress}. New balance: ${user.BXC_Balance.toFixed(4)}`);
    } else {
        // If no accrual or event ended, just update lastBXCAccrualTime to now
        await usersCollection.updateOne(
            { walletAddress: user.walletAddress },
            { $set: { lastBXCAccrualTime: now } }
        );
        user.lastBXCAccrualTime = now;
    }

    return user; // Return the user object with potentially updated BXC
}


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
    const { walletAddress } = req.body; // walletAddress might be null if not connected

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const globalStateCollection = db.collection('globalState');

        // Initialize user if walletAddress is provided and user doesn't exist
        let user = null;
        if (walletAddress) {
            user = await usersCollection.findOne({ walletAddress: walletAddress.toLowerCase() });
            if (!user) {
                user = {
                    walletAddress: walletAddress.toLowerCase(),
                    slotsStaked: 0,
                    stakedUSDValue: 0,
                    BXC_Balance: 0,
                    AIN_Balance: 0, // NEW: AIN Balance
                    claimedEventRewardTime: null,
                    collectedEventRewardTime: null,
                    lastRevealedUSDAmount: 0, // USD amount revealed for the last event cycle
                    lastReferralCopyBonusGiven: null, // Last time referral copy bonus was awarded (per event cycle)
                    referralCode: walletAddress.toLowerCase().slice(-6),
                    referralCount: 0,
                    createdAt: new Date(),
                    stakeTransactions: [],
                    lastBXCAccrualTime: new Date() // NEW: Initialize last BXC accrual time
                };
                await usersCollection.insertOne(user);
            } else {
                // If user exists, calculate BXC accrual before sending data
                user = await calculateAndSaveBXC(user); // Ensure BXC is up-to-date
            }
        }

        // Get or Initialize global state for event times
        let globalState = await globalStateCollection.findOne({});
        if (!globalState) {
            // Initial global state (event starts only when first stake occurs)
            globalState = {
                totalSlotsUsed: 0,
                eventStartTime: null, // Event starts when first stake occurs
                eventEndTime: null,   // Calculated from eventStartTime + duration
                lastResetTime: new Date() // Tracks last overall reset if needed
            };
            await globalStateCollection.insertOne(globalState);
            console.log("Global state initialized.");
        }
        // No auto-reset here. Event times are set on the first stake.

        res.json({
            user: user ? { // Only send user data if walletAddress was provided
                walletAddress: user.walletAddress,
                slotsStaked: user.slotsStaked,
                stakedUSDValue: user.stakedUSDValue,
                BXC_Balance: user.BXC_Balance,
                AIN_Balance: user.AIN_Balance, // NEW
                claimedEventRewardTime: user.claimedEventRewardTime,
                collectedEventRewardTime: user.collectedEventRewardTime,
                lastRevealedUSDAmount: user.lastRevealedUSDAmount,
                lastReferralCopyBonusGiven: user.lastReferralCopyBonusGiven,
                referralCode: user.referralCode,
                referralCount: user.referralCount,
                createdAt: user.createdAt,
                stakeTransactions: user.stakeTransactions,
                lastBXCAccrualTime: user.lastBXCAccrualTime // NEW
            } : null,
            global: {
                totalSlotsUsed: globalState.totalSlotsUsed,
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
    const { walletAddress, referrerRef, transactionHash } = req.body;

    if (!walletAddress || !transactionHash) {
        return res.status(400).json({ message: "Wallet address and transaction hash are required for staking." });
    }

    const userWalletAddress = walletAddress.toLowerCase();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const globalStateCollection = db.collection('globalState');

        let user = await usersCollection.findOne({ walletAddress: userWalletAddress });
        let globalState = await globalStateCollection.findOne({});

        // --- Global State & Event Time Initialization (on first stake) ---
        if (!globalState || globalState.totalSlotsUsed === 0 || !globalState.eventStartTime || !globalState.eventEndTime || new Date() > globalState.eventEndTime) {
            console.log("No active event found or event ended. Starting a new event cycle.");
            const now = new Date();
            const newEventEndTime = new Date(now.getTime() + EVENT_DURATION_HOURS * 60 * 60 * 1000);
            
            // Reset global state for new event cycle
            await globalStateCollection.updateOne(
                {},
                { $set: {
                    totalSlotsUsed: 0,
                    eventStartTime: now,
                    eventEndTime: newEventEndTime,
                    lastResetTime: now // Update last reset time
                }},
                { upsert: true }
            );
            globalState = await globalStateCollection.findOne({}); // Fetch updated globalState
            
            // Optionally, reset relevant user reward fields for the new event cycle
            await usersCollection.updateMany(
                { /* Consider criteria for users to reset, e.g., all users */ },
                { $set: { claimedEventRewardTime: null, collectedEventRewardTime: null, lastRevealedUSDAmount: 0 } }
            );
            console.log(`New global event started. Ends at: ${globalState.eventEndTime}`);
        }

        // --- Check if max slots reached (after ensuring globalState is updated for this cycle) ---
        if (globalState.totalSlotsUsed >= MAX_STAKE_SLOTS) {
            return res.status(400).json({ message: "All staking slots are currently filled. Please check back later." });
        }

        // Check if transaction hash already recorded for this user
        if (user && user.stakeTransactions && user.stakeTransactions.some(tx => tx.hash === transactionHash)) {
            return res.status(400).json({ message: "This transaction has already been recorded for your account." });
        }
        
        // Check if user has already staked for this event cycle
        // If user exists and their last stake was AFTER the current eventStartTime, they've already staked
        if (user && user.slotsStaked > 0 && user.stakeTransactions.some(tx => tx.timestamp >= globalState.eventStartTime)) {
            return res.status(400).json({ message: "You have already completed the one-time stake for this event cycle." });
        }

        if (!user) { // If user doesn't exist, create them
            user = {
                walletAddress: userWalletAddress,
                slotsStaked: 0,
                stakedUSDValue: 0,
                BXC_Balance: 0,
                AIN_Balance: 0, // NEW
                claimedEventRewardTime: null,
                collectedEventRewardTime: null,
                lastRevealedUSDAmount: 0,
                lastReferralCopyBonusGiven: null,
                referralCode: userWalletAddress.slice(-6),
                referralCount: 0,
                createdAt: new Date(),
                stakeTransactions: [],
                lastBXCAccrualTime: new Date() // NEW: Set this on initial stake
            };
            await usersCollection.insertOne(user);
        }

        // --- Process the stake ---
        const now = new Date();
        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $inc: { slotsStaked: 1, BXC_Balance: INITIAL_BXC },
                $set: { stakedUSDValue: INITIAL_STAKE_AMOUNT, lastBXCAccrualTime: now }, // Set initial $8 stake & accrual time
                $push: { stakeTransactions: { hash: transactionHash, timestamp: now } } // Store hash
            }
        );

        // --- Update Global State ---
        await globalStateCollection.updateOne(
            {},
            { $inc: { totalSlotsUsed: 1 } }, // Increment totalSlotsUsed
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
            transactionHash: transactionHash,
            user: {
                walletAddress: updatedUser.walletAddress,
                slotsStaked: updatedUser.slotsStaked,
                stakedUSDValue: updatedUser.stakedUSDValue,
                BXC_Balance: updatedUser.BXC_Balance,
                AIN_Balance: updatedUser.AIN_Balance, // NEW
                claimedEventRewardTime: updatedUser.claimedEventRewardTime,
                collectedEventRewardTime: updatedUser.collectedEventRewardTime,
                lastRevealedUSDAmount: updatedUser.lastRevealedUSDAmount,
                lastReferralCopyBonusGiven: updatedUser.lastReferralCopyBonusGiven,
                referralCode: updatedUser.referralCode,
                referralCount: updatedUser.referralCount,
                stakeTransactions: updatedUser.stakeTransactions,
                lastBXCAccrualTime: updatedUser.lastBXCAccrualTime // NEW
            },
            global: {
                totalSlotsUsed: updatedGlobalState.totalSlotsUsed,
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

// NEW ENDPOINT: POST /api/withdraw-stake - Allows users to withdraw their $8 stake.
app.post('/api/withdraw-stake', async (req, res) => {
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

        if (!user || user.stakedUSDValue < INITIAL_STAKE_AMOUNT || user.slotsStaked === 0) {
            return res.status(400).json({ message: "You have no active stake to withdraw." });
        }

        // --- Prevent withdrawal if event has already started (optional rule based on dApp logic) ---
        // if (globalState && globalState.eventStartTime && new Date() > globalState.eventStartTime) {
        //     return res.status(400).json({ message: "Stake withdrawal is not allowed once the event has started." });
        // }

        // Remove stake from user's record
        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $set: {
                    slotsStaked: 0,
                    stakedUSDValue: 0,
                    stakeTransactions: [] // Clear stake transactions for this user
                },
                $inc: { BXC_Balance: -(user.BXC_Balance || 0) } // Optionally, remove all BXC upon stake withdrawal if that's the rule
            }
        );

        // Decrement global totalSlotsUsed
        await globalStateCollection.updateOne(
            {},
            { $inc: { totalSlotsUsed: -1 } }
        );

        res.status(200).json({ message: `Your $${INITIAL_STAKE_AMOUNT} stake has been successfully withdrawn (simulated).` });

    } catch (error) {
        console.error("Error during stake withdrawal:", error);
        res.status(500).json({ message: "Internal server error during stake withdrawal." });
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
        if (!globalState || !globalState.eventEndTime || now < globalState.eventEndTime) {
            return res.status(400).json({ message: "Reward reveal is only available after the event ends." });
        }
        
        // Check if user has already claimed/revealed for THIS specific event cycle
        // This check should use globalState.eventStartTime to define the current event cycle
        if (user.claimedEventRewardTime && user.claimedEventRewardTime >= globalState.eventStartTime) {
            const revealedAIN = user.lastRevealedUSDAmount / AIN_USD_PRICE; // Convert stored USD back to AIN for response
            const message = user.lastRevealedUSDAmount === 0
                ? "You revealed 0 AIN. Better luck next time!"
                : `You already revealed ${revealedAIN.toFixed(4)} AIN!`;
            
            return res.status(200).json({
                message: message,
                AIN_Amount: revealedAIN,
                isLuckyWinner: user.lastRevealedUSDAmount > 0, // Based on whether they got a prize
                user: {
                    stakedUSDValue: user.stakedUSDValue,
                    BXC_Balance: user.BXC_Balance,
                    AIN_Balance: user.AIN_Balance,
                    claimedEventRewardTime: user.claimedEventRewardTime,
                    collectedEventRewardTime: user.collectedEventRewardTime
                }
            });
        }

        // --- Determine if user is a "Lucky Winner" eligible for a prize ---
        // This is a simplified "lucky 9000" logic. A more robust system would involve
        // deterministic selection based on slot ID or a public random seed.
        const isEligibleLuckyWinnerSlot = globalState.totalSlotsUsed <= LUCKY_WINNER_SLOT_THRESHOLD;
        
        let rewardAmountUSD = 0;
        let isLuckyWinner = false; // Corresponds to receiving >0 USD prize

        if (isEligibleLuckyWinnerSlot) {
            const randomValue = Math.random(); // 0 to 1
            if (randomValue < REWARD_CHANCE_LARGE_WIN) { // 10% chance for large win
                rewardAmountUSD = Math.floor(Math.random() * (REWARD_USD_LARGE_MAX - REWARD_USD_LARGE_MIN + 1)) + REWARD_USD_LARGE_MIN;
                isLuckyWinner = true;
            } else if (randomValue < (REWARD_CHANCE_LARGE_WIN + REWARD_CHANCE_REGULAR_WIN)) { // 50% chance for regular win
                rewardAmountUSD = Math.floor(Math.random() * (REWARD_USD_REGULAR_MAX - REWARD_USD_REGULAR_MIN + 1)) + REWARD_USD_REGULAR_MIN;
                isLuckyWinner = true;
            }
            // Else (remaining 40%): rewardAmountUSD remains 0, isLuckyWinner remains false
        }
        // If not isEligibleLuckyWinnerSlot, rewardAmountUSD remains 0

        // Convert USD reward to AIN for response (Frontend needs AIN value)
        const ainAmount = isLuckyWinner ? (rewardAmountUSD / AIN_USD_PRICE) : 0;

        // Update user: Set the revealed time and the USD amount revealed (for collection logic)
        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $set: {
                    claimedEventRewardTime: now, // Mark as revealed for this event cycle
                    lastRevealedUSDAmount: rewardAmountUSD, // Store USD amount revealed for later AIN calculation at collection
                }
            }
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });

        res.status(200).json({
            message: ainAmount > 0 ? `You revealed ${ainAmount.toFixed(4)} AIN!` : "Better luck next time! (0 AIN)",
            AIN_Amount: ainAmount, // Send AIN amount to frontend
            isLuckyWinner: ainAmount > 0, // Let frontend know if they won something
            user: {
                stakedUSDValue: updatedUser.stakedUSDValue,
                BXC_Balance: updatedUser.BXC_Balance,
                AIN_Balance: updatedUser.AIN_Balance,
                claimedEventRewardTime: updatedUser.claimedEventRewardTime,
                collectedEventRewardTime: updatedUser.collectedEventRewardTime
            }
        });

    } catch (error) {
        console.error("Error revealing reward:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});

// 4. POST /api/collect-reward - Handle collection of revealed reward (now for AIN)
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
        if (!globalState || !globalState.eventEndTime || now < globalState.eventEndTime) {
            return res.status(400).json({ message: "Reward collection is only available after the event ends." });
        }

        // Check if reward has been revealed for this event cycle
        if (!user.claimedEventRewardTime || user.claimedEventRewardTime < globalState.eventStartTime) {
            return res.status(400).json({ message: "You must reveal your reward first!" });
        }

        // Check if reward has already been collected for this event cycle
        if (user.collectedEventRewardTime && user.collectedEventRewardTime >= globalState.eventStartTime) {
            return res.status(400).json({ message: "You have already collected this event's reward." });
        }
        
        const rewardToCollectUSD = user.lastRevealedUSDAmount || 0; // The USD value previously revealed
        const ainAmountToCollect = rewardToCollectUSD > 0 ? (rewardToCollectUSD / AIN_USD_PRICE) : 0;

        if (ainAmountToCollect === 0) {
            return res.status(400).json({ message: "No AIN reward available to collect." });
        }

        // Add AIN reward to AIN_Balance and mark as collected
        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $inc: { AIN_Balance: ainAmountToCollect }, // Add to AIN_Balance
                $set: { collectedEventRewardTime: now } // Mark as collected
            }
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });

        res.status(200).json({
            message: `Successfully collected ${ainAmountToCollect.toFixed(4)} AIN!`,
            collectedAINAmount: ainAmountToCollect,
            user: {
                stakedUSDValue: updatedUser.stakedUSDValue,
                BXC_Balance: updatedUser.BXC_Balance,
                AIN_Balance: updatedUser.AIN_Balance, // Updated AIN value
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
    const { walletAddress, token, amount } = req.body; // Token added for potential future generalization

    if (!walletAddress || token !== 'BXC') {
        return res.status(400).json({ message: "Wallet address and token type (BXC) are required." });
    }

    const userWalletAddress = walletAddress.toLowerCase();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');

        let user = await usersCollection.findOne({ walletAddress: userWalletAddress });
        user = await calculateAndSaveBXC(user); // Ensure BXC balance is up-to-date before withdrawal

        if (!user || user.BXC_Balance <= 0) {
            return res.status(400).json({ message: "No BXC balance to withdraw." });
        }

        const withdrawAmount = (amount && amount > 0 && amount <= user.BXC_Balance) ? amount : user.BXC_Balance;

        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            { $inc: { BXC_Balance: -withdrawAmount } } // Deduct from balance
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });

        res.status(200).json({
            message: `${withdrawAmount.toFixed(4)} BXC successfully withdrawn (simulated).`,
            withdrawnAmount: withdrawAmount,
            user: {
                BXC_Balance: updatedUser.BXC_Balance
            }
        });

    } catch (error) {
        console.error("Error during BXC withdrawal:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});

// NEW ENDPOINT: POST /api/withdrawAIN - Handle AIN withdrawal
app.post('/api/withdrawAIN', async (req, res) => {
    const { walletAddress, amount } = req.body; // Amount is optional, if not provided, withdraw all

    if (!walletAddress) {
        return res.status(400).json({ message: "Wallet address is required." });
    }

    const userWalletAddress = walletAddress.toLowerCase();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');

        const user = await usersCollection.findOne({ walletAddress: userWalletAddress });

        if (!user || user.AIN_Balance <= 0) {
            return res.status(400).json({ message: "No AIN balance to withdraw." });
        }

        const withdrawAmount = (amount && amount > 0 && amount <= user.AIN_Balance) ? amount : user.AIN_Balance;

        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            { $inc: { AIN_Balance: -withdrawAmount } } // Deduct from balance
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });

        res.status(200).json({
            message: `${withdrawAmount.toFixed(4)} AIN successfully withdrawn (simulated).`,
            withdrawnAmount: withdrawAmount,
            user: {
                AIN_Balance: updatedUser.AIN_Balance
            }
        });

    } catch (error) {
        console.error("Error during AIN withdrawal:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});


// 6. POST /api/referral-copied - Award BXC for copying referral link/code
app.post('/api/referral-copied', async (req, res) => {
    const { walletAddress } = req.body; // `type` (e.g., 'code_copy', 'link_copy', 'share_event') can be passed if different bonuses are needed

    if (!walletAddress) {
        return res.status(400).json({ message: "Wallet address is required." });
    }

    const userWalletAddress = walletAddress.toLowerCase();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const globalStateCollection = db.collection('globalState');

        const user = await usersCollection.findOne({ walletAddress: userWalletAddress });
        const globalState = await globalStateCollection.findOne({}); // Need globalState for eventStartTime

        if (!user || user.slotsStaked === 0) {
            return res.status(400).json({ message: "Stake at least once to earn referral copy bonuses!" });
        }
        if (!globalState || !globalState.eventStartTime) { // Ensure event has started
            return res.status(400).json({ message: "Event has not started yet." });
        }

        // Check if user has already received this specific bonus within the current event cycle
        // If lastReferralCopyBonusGiven is older than current eventStartTime, they are eligible again
        if (user.lastReferralCopyBonusGiven && user.lastReferralCopyBonusGiven >= globalState.eventStartTime) {
             return res.status(400).json({ message: "You've already received the referral copy bonus for this event cycle." });
        }

        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $inc: { BXC_Balance: REFERRAL_COPY_BXC_BONUS },
                $set: { lastReferralCopyBonusGiven: new Date() } // Mark the time of this bonus
            }
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });

        res.status(200).json({
            message: `You received ${REFERRAL_COPY_BXC_BONUS} BXC for sharing the referral link!`,
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
