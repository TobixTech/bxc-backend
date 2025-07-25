// backend/index.js

require('dotenv').config();

const express = require('express');
const { MongoClient, ServerApiVersion } = require('mongodb');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 8080;

app.use(cors({
  origin: "https://xtrashare-bxc.vercel.app", 
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());

const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'ExtraShare';

let client;

async function connectToMongo() {
  if (!uri) {
    console.error("CRITICAL ERROR: MONGODB_URI is not set. Please provide it as a Fly.io secret or in your local .env file.");
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
    await ensureGlobalStateInitialized(); 
  } catch (err) {
    console.error("FAILED TO CONNECT TO MONGODB:", err);
    process.exit(1); 
  }
}

function getDb() {
    if (!client || !client.db) {
        console.error("CRITICAL ERROR: MongoDB client not connected when getDb() was called.");
        throw new Error("MongoDB client not connected.");
    }
    return client.db(dbName);
}

// --- General Constants (some values are now dynamically set in globalState) ---
const BXC_ACCRUAL_PER_SECOND = 0.001;
const REFERRAL_BXC = 1050;
const REFERRAL_COPY_BXC_BONUS = 50;
const INITIAL_BXC = 2000; // <--- ADDED THIS LINE

const AIN_USD_PRICE = 0.137; // Still a fixed price for AIN conversion
const REWARD_CHANCE_LARGE_WIN = 0.1; 
const REWARD_CHANCE_REGULAR_WIN = 0.5;

const REWARD_USD_LARGE_MIN = 100;
const REWARD_USD_LARGE_MAX = 899;
const REWARD_USD_REGULAR_MIN = 10;
const REWARD_USD_REGULAR_MAX = 99;

const LUCKY_WINNER_SLOT_THRESHOLD = 9000; // This can remain a constant if not admin-controlled

const ADMIN_WALLET_ADDRESS = process.env.ADMIN_WALLET_ADDRESS ? process.env.ADMIN_WALLET_ADDRESS.toLowerCase() : ''; 
if (!ADMIN_WALLET_ADDRESS) {
    console.warn("WARNING: ADMIN_WALLET_ADDRESS environment variable is not set. Admin features will be inaccessible.");
}

function isAdmin(walletAddress) {
    return walletAddress && walletAddress.toLowerCase() === ADMIN_WALLET_ADDRESS;
}

// Ensures global event state is always present and valid
async function ensureGlobalStateInitialized() {
    try {
        const db = getDb();
        const globalStateCollection = db.collection('globalState');
        let globalState = await globalStateCollection.findOne({});
        const now = new Date();

        if (!globalState) {
            console.log("Global state not found. Initializing with default values.");
            globalState = {
                totalSlotsUsed: 0, 
                eventStartTime: now, 
                eventEndTime: new Date(now.getTime() + 95 * 60 * 60 * 1000), // Default 95 hours event duration
                isPaused: false,
                pauseStartTime: null,
                withdrawalsPaused: false,
                lastResetTime: now,
                // --- NEW ADMIN-CONTROLLABLE DEFAULTS ---
                stakingRecipientAddress: '0x9FfDabC1b4e1d0a2B64045C32EBf3231F8541578', // <<<--- IMPORTANT: REPLACE THIS PLACEHOLDER WITH YOUR ACTUAL STAKING WALLET ADDRESS
                initialStakeAmountUSD: 8, // Default initial stake amount
                maxStakeSlots: 30000, // Default max slots
                maxAinRewardPool: 100000, // Default total AIN pool cap (e.g., 100,000 AIN)
                totalAinRewarded: 0, // Initial total AIN rewarded for the current event cycle
                eventDurationHours: 95, // Default event duration in hours (for persistence)
            };
            await globalStateCollection.insertOne(globalState);
            console.log(`[INIT] New default global event and settings initialized. Event ends: ${globalState.eventEndTime.toISOString()}`);
        } else {
            console.log(`[INIT] Existing global state found. Current event ends: ${globalState.eventEndTime ? globalState.eventEndTime.toISOString() : 'N/A'}`);
            console.log(`[INIT] isPaused: ${globalState.isPaused}, withdrawalsPaused: ${globalState.withdrawalsPaused}`);
            console.log(`[INIT] Staking Address: ${globalState.stakingRecipientAddress}, Stake Amount: ${globalState.initialStakeAmountUSD}, Max Slots: ${globalState.maxStakeSlots}`);
            console.log(`[INIT] AIN Pool: ${globalState.maxAinRewardPool}, AIN Rewarded: ${globalState.totalAinRewarded}`);

            // If event expired, start a new one
            if (!globalState.eventStartTime || !globalState.eventEndTime || now > globalState.eventEndTime) {
                console.log("[INIT] Existing event expired. Starting a new event cycle.");
                // Use existing duration if available, otherwise default to 95 hours
                const eventDurationHours = globalState.eventDurationHours || 95; // Use this to preserve admin set duration
                const newEventStartTime = now;
                const newEventEndTime = new Date(now.getTime() + eventDurationHours * 60 * 60 * 1000); 
                
                await globalStateCollection.updateOne(
                    {},
                    { $set: {
                        totalSlotsUsed: 0, 
                        eventStartTime: newEventStartTime,
                        eventEndTime: newEventEndTime,
                        isPaused: false, 
                        pauseStartTime: null, 
                        // withdrawalsPaused: false, // Don't reset this on event cycle start unless admin wants it reset
                        lastResetTime: now,
                        totalAinRewarded: 0, // Reset rewarded AIN for new event cycle
                    }},
                    { upsert: true } 
                );
                console.log(`[INIT] New event cycle started at: ${newEventStartTime.toISOString()}, ends at: ${newEventEndTime.toISOString()}`);
    
                // Also reset user reward flags for the new cycle
                const usersCollection = db.collection('users');
                await usersCollection.updateMany(
                    {}, 
                    { $set: { 
                        claimedEventRewardTime: null, 
                        collectedEventRewardTime: null, 
                        lastRevealedUSDAmount: 0,
                        // lastReferralCopyBonusGiven: null // Uncomment if you want this bonus per event cycle, not just once
                    } }
                );
            }

            // Ensure any missing new fields are added to existing globalState document without overwriting existing
            const updateFields = {};
            if (globalState.stakingRecipientAddress === undefined) updateFields.stakingRecipientAddress = '0xYourDefaultStakeRecipientAddressHere';
            if (globalState.initialStakeAmountUSD === undefined) updateFields.initialStakeAmountUSD = 8;
            if (globalState.maxStakeSlots === undefined) updateFields.maxStakeSlots = 30000;
            if (globalState.maxAinRewardPool === undefined) updateFields.maxAinRewardPool = 100000;
            if (globalState.totalAinRewarded === undefined) updateFields.totalAinRewarded = 0;
            if (globalState.isPaused === undefined) updateFields.isPaused = false;
            if (globalState.pauseStartTime === undefined) updateFields.pauseStartTime = null;
            if (globalState.withdrawalsPaused === undefined) updateFields.withdrawalsPaused = false;
            if (globalState.eventDurationHours === undefined) updateFields.eventDurationHours = 95;

            if (Object.keys(updateFields).length > 0) {
                await globalStateCollection.updateOne({}, { $set: updateFields });
                console.log("Existing global state updated with new default fields.");
            }
        }
    } catch (error) {
        console.error("ERROR IN ensureGlobalStateInitialized:", error);
    }
}


// Helper Function: Calculates and updates BXC balance based on time elapsed
async function calculateAndSaveBXC(user) {
    const db = getDb();
    const usersCollection = db.collection('users');
    const globalStateCollection = db.collection('globalState');
    const globalState = await globalStateCollection.findOne({});
    const now = new Date();

    if (globalState && globalState.isPaused) {
        await usersCollection.updateOne(
            { walletAddress: user.walletAddress },
            { $set: { lastBXCAccrualTime: now } }
        );
        user.lastBXCAccrualTime = now;
        return user;
    }

    if (!user.lastBXCAccrualTime || user.slotsStaked === 0) { 
        await usersCollection.updateOne(
            { walletAddress: user.walletAddress },
            { $set: { lastBXCAccrualTime: now } }
        );
        user.lastBXCAccrualTime = now; 
        return user; 
    }

    const eventEndTime = globalState ? globalState.eventEndTime : null;

    let accrualUntilTime = now;
    if (eventEndTime && now > eventEndTime) {
        accrualUntilTime = eventEndTime;
    }
    
    const effectiveAccrualStartTime = Math.max(user.lastBXCAccrualTime.getTime(), (globalState && globalState.eventStartTime ? globalState.eventStartTime.getTime() : 0));

    const timeElapsedMs = Math.max(0, accrualUntilTime.getTime() - effectiveAccrualStartTime);
    const timeElapsedSeconds = timeElapsedMs / 1000;

    const accruedBXC = timeElapsedSeconds * BXC_ACCRUAL_PER_SECOND;

    if (accruedBXC > 0 && user.slotsStaked > 0 && globalState && now >= globalState.eventStartTime && (eventEndTime ? now <= eventEndTime : true)) {
        user.BXC_Balance = (user.BXC_Balance || 0) + accruedBXC;
        user.lastBXCAccrualTime = now;

        await usersCollection.updateOne(
            { walletAddress: user.walletAddress },
            { $set: { BXC_Balance: user.BXC_Balance, lastBXCAccrualTime: user.lastBXCAccrualTime } }
        );
        console.log(`Accrued ${accruedBXC.toFixed(4)} BXC for ${user.walletAddress}. New balance: ${user.BXC_Balance.toFixed(4)}`);
    } else {
        await usersCollection.updateOne(
            { walletAddress: user.walletAddress },
            { $set: { lastBXCAccrualTime: now } }
        );
        user.lastBXCAccrualTime = now;
    }

    return user;
}


// --- API Routes ---

app.get('/api/health', (req, res) => {
    try {
        if (client && client.db) {
            res.status(200).json({ status: 'ok', message: 'Backend is healthy and connected to DB.' });
        } else {
            res.status(500).json({ status: 'error', message: 'Backend is running but DB connection is not established.' });
        }
    } catch (error) {
        console.error("Error in /api/health:", error);
        res.status(500).json({ status: 'error', message: 'Internal server error during health check.' });
    }
});


app.post('/api/status', async (req, res) => {
    const { walletAddress } = req.body;
    const now = new Date();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const globalStateCollection = db.collection('globalState');

        let user = null;
        if (walletAddress) {
            user = await usersCollection.findOne({ walletAddress: walletAddress.toLowerCase() });
            if (!user) {
                user = {
                    walletAddress: walletAddress.toLowerCase(),
                    slotsStaked: 0,
                    stakedUSDValue: 0,
                    BXC_Balance: 0,
                    AIN_Balance: 0,
                    claimedEventRewardTime: null,
                    collectedEventRewardTime: null,
                    lastRevealedUSDAmount: 0,
                    lastReferralCopyBonusGiven: null,
                    referralCode: walletAddress.toLowerCase().slice(-6),
                    referralCount: 0,
                    createdAt: now,
                    stakeTransactions: [],
                    lastBXCAccrualTime: now
                };
                await usersCollection.insertOne(user);
            } else {
                user = await calculateAndSaveBXC(user);
            }
        }

        const globalState = await globalStateCollection.findOne({}); 
        if (!globalState) {
            console.error("[API/STATUS] Global state not found. This should be initialized on startup.");
            return res.status(500).json({ 
                message: "Global state not initialized on server. Please check backend logs.",
                global: { // Provide fallback structure to prevent frontend crashes
                    totalSlotsUsed: 0,
                    eventStartTime: now,
                    eventEndTime: new Date(now.getTime() + 95 * 60 * 60 * 1000),
                    isPaused: false,
                    pauseStartTime: null,
                    withdrawalsPaused: false,
                    serverTime: now,
                    stakingRecipientAddress: '0xDefaultErrorAddress', 
                    initialStakeAmountUSD: 8,     
                    maxStakeSlots: 30000,                     
                    maxAinRewardPool: 0,          
                    totalAinRewarded: 0,          
                    totalConnectedWallets: 0,
                    eventDurationHours: 95,
                }
            });
        }

        const totalConnectedWallets = await usersCollection.countDocuments({});

        res.json({
            user: user ? {
                walletAddress: user.walletAddress,
                slotsStaked: user.slotsStaked,
                stakedUSDValue: user.stakedUSDValue,
                BXC_Balance: user.BXC_Balance,
                AIN_Balance: user.AIN_Balance,
                claimedEventRewardTime: user.claimedEventRewardTime,
                collectedEventRewardTime: user.collectedEventRewardTime,
                lastRevealedUSDAmount: user.lastRevealedUSDAmount,
                lastReferralCopyBonusGiven: user.lastReferralCopyBonusGiven,
                referralCode: user.referralCode,
                referralCount: user.referralCount,
                createdAt: user.createdAt,
                stakeTransactions: user.stakeTransactions,
                lastBXCAccrualTime: user.lastBXCAccrualTime
            } : null,
            global: {
                totalSlotsUsed: globalState.totalSlotsUsed,
                eventStartTime: globalState.eventStartTime,
                eventEndTime: globalState.eventEndTime,
                isPaused: globalState.isPaused || false, 
                pauseStartTime: globalState.pauseStartTime || null,
                withdrawalsPaused: globalState.withdrawalsPaused || false,
                serverTime: now,
                // NEW: Dynamic values from globalState
                stakingRecipientAddress: globalState.stakingRecipientAddress, 
                initialStakeAmountUSD: globalState.initialStakeAmountUSD,     
                maxStakeSlots: globalState.maxStakeSlots,                     
                maxAinRewardPool: globalState.maxAinRewardPool || 0,          
                totalAinRewarded: globalState.totalAinRewarded || 0,          
                totalConnectedWallets: totalConnectedWallets,                 
                eventDurationHours: globalState.eventDurationHours || 95,
            },
            message: "Status fetched successfully."
        });

    } catch (error) {
        console.error("[API/STATUS] Error fetching status:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});


app.post('/api/stake', async (req, res) => {
    const { walletAddress, referrerRef, transactionHash } = req.body;
    const now = new Date();

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

        if (!globalState) {
            throw new Error("Global state not found during stake. Server startup issue.");
        }
        if (globalState.isPaused) { 
            return res.status(400).json({ message: "Staking is currently paused by admin." });
        }

        const currentMaxStakeSlots = globalState.maxStakeSlots || 30000;
        const eventDurationHours = globalState.eventDurationHours || 95;


        if (globalState.totalSlotsUsed >= currentMaxStakeSlots || now > globalState.eventEndTime) { 
            console.log("[API/STAKE] Current event cycle has ended or filled. Starting a new event cycle upon this stake.");
            const newEventStartTime = now;
            const newEventEndTime = new Date(now.getTime() + eventDurationHours * 60 * 60 * 1000); 
            
            await globalStateCollection.updateOne(
                {},
                { $set: {
                    totalSlotsUsed: 0, 
                    eventStartTime: newEventStartTime,
                    eventEndTime: newEventEndTime,
                    isPaused: false, 
                    pauseStartTime: null, 
                    withdrawalsPaused: false, 
                    lastResetTime: now,
                    totalAinRewarded: 0, 
                }}
            );
            globalState = await globalStateCollection.findOne({}); 
            
            await usersCollection.updateMany(
                {}, 
                { $set: { 
                    claimedEventRewardTime: null, 
                    collectedEventRewardTime: null, 
                    lastRevealedUSDAmount: 0,
                } }
            );
            console.log(`[API/STAKE] New event cycle started due to stake. Ends at: ${globalState.eventEndTime.toISOString()}`);
        }

        if (globalState.totalSlotsUsed >= currentMaxStakeSlots) { 
            return res.status(400).json({ message: "All staking slots are currently filled for this event cycle." });
        }


        const hasStakedInCurrentCycle = user && user.stakeTransactions && 
            user.stakeTransactions.some(tx => tx.timestamp && tx.timestamp >= globalState.eventStartTime);

        if (hasStakedInCurrentCycle) {
            return res.status(400).json({ message: "You have already completed the one-time stake for this event cycle." });
        }
        
        if (user && user.stakeTransactions && user.stakeTransactions.some(tx => tx.hash === transactionHash)) {
            return res.status(400).json({ message: "This transaction hash has already been recorded for your account." });
        }

        if (!user) {
            user = {
                walletAddress: userWalletAddress,
                slotsStaked: 0,
                stakedUSDValue: 0,
                BXC_Balance: 0,
                AIN_Balance: 0,
                claimedEventRewardTime: null,
                collectedEventRewardTime: null,
                lastRevealedUSDAmount: 0,
                lastReferralCopyBonusGiven: null,
                referralCode: userWalletAddress.slice(-6),
                referralCount: 0,
                createdAt: now,
                stakeTransactions: [],
                lastBXCAccrualTime: now
            };
            await usersCollection.insertOne(user);
        } else {
             user = await calculateAndSaveBXC(user); 
        }

        const currentInitialStakeAmount = globalState.initialStakeAmountUSD || 8;
        const currentStakingRecipientAddress = globalState.stakingRecipientAddress; // This is the address to use for the actual crypto transfer

        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $inc: { slotsStaked: 1, BXC_Balance: INITIAL_BXC }, 
                $set: { 
                    stakedUSDValue: currentInitialStakeAmount, 
                    lastBXCAccrualTime: now,
                }, 
                $push: { stakeTransactions: { hash: transactionHash, timestamp: now, amountUSD: currentInitialStakeAmount } } 
            }
        );

        await globalStateCollection.updateOne(
            {},
            { $inc: { totalSlotsUsed: 1 } },
            { upsert: true }
        );

        if (referrerRef && referrerRef.toLowerCase() !== userWalletAddress.slice(-6).toLowerCase()) {
            const referrer = await usersCollection.findOne({ referralCode: referrerRef.toLowerCase() });
            if (referrer) {
                const updatedReferrer = await calculateAndSaveBXC(referrer); 

                await usersCollection.updateOne(
                    { walletAddress: updatedReferrer.walletAddress },
                    { $inc: { BXC_Balance: REFERRAL_BXC, referralCount: 1 } }
                );
                console.log(`Referral bonus of ${REFERRAL_BXC} BXC given to ${referrer.walletAddress} for referring ${userWalletAddress}`);
            }
        }

        const updatedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });
        const updatedGlobalState = await globalStateCollection.findOne({});

        res.status(200).json({
            message: `Stake successful! Welcome to ExtraShare BXC! You staked $${currentInitialStakeAmount}.`,
            transactionHash: transactionHash,
            user: {
                walletAddress: updatedUser.walletAddress,
                slotsStaked: updatedUser.slotsStaked,
                stakedUSDValue: updatedUser.stakedUSDValue,
                BXC_Balance: updatedUser.BXC_Balance,
                AIN_Balance: updatedUser.AIN_Balance,
                claimedEventRewardTime: updatedUser.claimedEventRewardTime,
                collectedEventRewardTime: updatedUser.collectedEventRewardTime,
                lastRevealedUSDAmount: updatedUser.lastRevealedUSDAmount,
                lastReferralCopyBonusGiven: updatedUser.lastReferralCopyBonusGiven,
                referralCode: updatedUser.referralCode,
                referralCount: updatedUser.referralCount,
                stakeTransactions: updatedUser.stakeTransactions,
                lastBXCAccrualTime: updatedUser.lastBXCAccrualTime
            },
            global: {
                totalSlotsUsed: updatedGlobalState.totalSlotsUsed,
                eventStartTime: updatedGlobalState.eventStartTime,
                eventEndTime: updatedGlobalState.eventEndTime,
                isPaused: updatedGlobalState.isPaused || false,
                pauseStartTime: updatedGlobalState.pauseStartTime || null,
                withdrawalsPaused: updatedGlobalState.withdrawalsPaused || false,
                maxStakeSlots: updatedGlobalState.maxStakeSlots, 
                initialStakeAmountUSD: updatedGlobalState.initialStakeAmountUSD, 
                stakingRecipientAddress: updatedGlobalState.stakingRecipientAddress,
                maxAinRewardPool: updatedGlobalState.maxAinRewardPool,
                totalAinRewarded: updatedGlobalState.totalAinRewarded,
            }
        });

    } catch (error) {
        console.error("[API/STAKE] Error during stake:", error);
        res.status(500).json({ message: "Internal server error during stake processing." });
    }
});


app.post('/api/withdraw-stake', async (req, res) => {
    const { walletAddress } = req.body;
    const now = new Date();

    if (!walletAddress) {
        return res.status(400).json({ message: "Wallet address is required." });
    }

    const userWalletAddress = walletAddress.toLowerCase();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const globalStateCollection = db.collection('globalState');

        let user = await usersCollection.findOne({ walletAddress: userWalletAddress });
        user = await calculateAndSaveBXC(user);
        const globalState = await globalStateCollection.findOne({});

        if (!user || user.stakedUSDValue < (globalState.initialStakeAmountUSD || 8) || user.slotsStaked === 0) { 
            return res.status(400).json({ message: "You have no active stake to withdraw." });
        }
        if (globalState && globalState.isPaused) { 
            return res.status(400).json({ message: "Stake withdrawal is paused by admin." });
        }
        if (globalState && globalState.withdrawalsPaused) { 
            return res.status(400).json({ message: "All withdrawals are currently paused by admin." });
        }

        if (globalState && globalState.eventStartTime && now > globalState.eventStartTime) {
             return res.status(400).json({ message: "Stake withdrawal is not allowed once the event has started." });
        }

        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $set: {
                    slotsStaked: 0,
                    stakedUSDValue: 0,
                    stakeTransactions: [],
                    BXC_Balance: 0, 
                    lastBXCAccrualTime: now,
                    claimedEventRewardTime: null,
                    collectedEventRewardTime: null,
                    lastRevealedUSDAmount: 0,
                    AIN_Balance: 0
                }
            }
        );

        await globalStateCollection.updateOne(
            {},
            { $inc: { totalSlotsUsed: -1 } }
        );

        res.status(200).json({ message: `Your $${(globalState.initialStakeAmountUSD || 8).toFixed(2)} stake has been successfully withdrawn (simulated).` }); 

    } catch (error) {
        console.error("[API/WITHDRAW-STAKE] Error during stake withdrawal:", error);
        res.status(500).json({ message: "Internal server error during stake withdrawal." });
    }
});


app.post('/api/reveal-reward', async (req, res) => {
    const { walletAddress } = req.body;
    const now = new Date();

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
        if (globalState && globalState.isPaused) { 
            return res.status(400).json({ message: "Reward reveal is paused by admin." });
        }

        if (!globalState || !globalState.eventEndTime || now < globalState.eventEndTime) {
            return res.status(400).json({ message: "Reward reveal is only available after the event ends." });
        }
        
        if (user.claimedEventRewardTime && user.claimedEventRewardTime >= globalState.eventStartTime) {
            const revealedAIN = user.lastRevealedUSDAmount / AIN_USD_PRICE;
            const message = user.lastRevealedUSDAmount === 0
                ? "You revealed 0 AIN. Better luck next time!"
                : `You already revealed ${revealedAIN.toFixed(4)} AIN!`;
            
            return res.status(200).json({
                message: message,
                AIN_Amount: revealedAIN,
                isLuckyWinner: user.lastRevealedUSDAmount > 0,
                user: {
                    stakedUSDValue: user.stakedUSDValue,
                    BXC_Balance: user.BXC_Balance,
                    AIN_Balance: user.AIN_Balance,
                    claimedEventRewardTime: user.claimedEventRewardTime,
                    collectedEventRewardTime: user.collectedEventRewardTime
                }
            });
        }

        const totalSlotsCurrentlyUsed = globalState.totalSlotsUsed;
        const maxAinRewardPool = globalState.maxAinRewardPool || 0;
        let totalAinRewarded = globalState.totalAinRewarded || 0;
        
        let rewardAmountUSD = 0;
        let isLuckyWinner = false;
        let calculatedAinAmount = 0;

        if (totalSlotsCurrentlyUsed <= LUCKY_WINNER_SLOT_THRESHOLD) {
            const randomValue = Math.random();
            if (randomValue < REWARD_CHANCE_LARGE_WIN) {
                rewardAmountUSD = Math.floor(Math.random() * (REWARD_USD_LARGE_MAX - REWARD_USD_LARGE_MIN + 1)) + REWARD_USD_LARGE_MIN;
                isLuckyWinner = true;
            } else if (randomValue < (REWARD_CHANCE_LARGE_WIN + REWARD_CHANCE_REGULAR_WIN)) {
                rewardAmountUSD = Math.floor(Math.random() * (REWARD_USD_REGULAR_MAX - REWARD_USD_REGULAR_MIN + 1)) + REWARD_USD_REGULAR_MIN;
                isLuckyWinner = true;
            }
        }

        calculatedAinAmount = isLuckyWinner ? (rewardAmountUSD / AIN_USD_PRICE) : 0;

        // Feature 3: Enforce MAX_AIN_REWARD_POOL
        if (maxAinRewardPool > 0 && (totalAinRewarded + calculatedAinAmount) > maxAinRewardPool) {
            // Adjust reward to not exceed cap
            calculatedAinAmount = Math.max(0, maxAinRewardPool - totalAinRewarded);
            rewardAmountUSD = calculatedAinAmount * AIN_USD_PRICE; 
            if (calculatedAinAmount === 0) { 
                isLuckyWinner = false; 
            }
            console.warn(`[API/REVEAL-REWARD] AIN reward adjusted due to pool cap. New AIN: ${calculatedAinAmount.toFixed(4)}`);
        }
        
        // Update total Ain rewarded in global state
        if (calculatedAinAmount > 0) {
            await globalStateCollection.updateOne(
                {},
                { $inc: { totalAinRewarded: calculatedAinAmount } }
            );
        }

        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $set: {
                    claimedEventRewardTime: now,
                    lastRevealedUSDAmount: rewardAmountUSD, 
                }
            }
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });

        res.status(200).json({
            message: calculatedAinAmount > 0 ? `You revealed ${calculatedAinAmount.toFixed(4)} AIN!` : "Better luck next time! (0 AIN)",
            AIN_Amount: calculatedAinAmount,
            isLuckyWinner: calculatedAinAmount > 0,
            user: {
                stakedUSDValue: updatedUser.stakedUSDValue,
                BXC_Balance: updatedUser.BXC_Balance,
                AIN_Balance: updatedUser.AIN_Balance,
                claimedEventRewardTime: updatedUser.claimedEventRewardTime,
                collectedEventRewardTime: updatedUser.collectedEventRewardTime
            }
        });

    } catch (error) {
        console.error("[API/REVEAL-REWARD] Error revealing reward:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});


app.post('/api/collect-reward', async (req, res) => {
    const { walletAddress } = req.body;
    const now = new Date();

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
        if (globalState && globalState.isPaused) { 
            return res.status(400).json({ message: "Reward collection is paused by admin." });
        }

        if (!globalState || !globalState.eventEndTime || now < globalState.eventEndTime) {
            return res.status(400).json({ message: "Reward collection is only available after the event ends." });
        }

        if (!user.claimedEventRewardTime || user.claimedEventRewardTime < globalState.eventStartTime) {
            return res.status(400).json({ message: "You must reveal your reward first!" });
        }

        if (user.collectedEventRewardTime && user.collectedEventRewardTime >= globalState.eventStartTime) {
            return res.status(400).json({ message: "You have already collected this event's reward." });
        }
        
        const rewardToCollectUSD = user.lastRevealedUSDAmount || 0;
        const ainAmountToCollect = rewardToCollectUSD > 0 ? (rewardToCollectUSD / AIN_USD_PRICE) : 0;

        if (ainAmountToCollect === 0) {
            return res.status(400).json({ message: "No AIN reward available to collect." });
        }

        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $inc: { AIN_Balance: ainAmountToCollect },
                $set: { collectedEventRewardTime: now }
            }
        );

        const updatedUser = await usersCollection.findOne({ walletAddress: userWalletAddress });

        res.status(200).json({
            message: `Successfully collected ${ainAmountToCollect.toFixed(4)} AIN!`,
            collectedAINAmount: ainAmountToCollect,
            user: {
                stakedUSDValue: updatedUser.stakedUSDValue,
                BXC_Balance: updatedUser.BXC_Balance,
                AIN_Balance: updatedUser.AIN_Balance,
                claimedEventRewardTime: updatedUser.claimedEventRewardTime,
                collectedEventRewardTime: updatedUser.collectedEventRewardTime
            }
        });

    } catch (error) {
        console.error("[API/COLLECT-REWARD] Error collecting reward:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});


app.post('/api/withdraw', async (req, res) => {
    const { walletAddress, token, amount } = req.body;
    const now = new Date();

    if (!walletAddress || token !== 'BXC') {
        return res.status(400).json({ message: "Wallet address and token type (BXC) are required." });
    }

    const userWalletAddress = walletAddress.toLowerCase();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const globalStateCollection = db.collection('globalState');

        let user = await usersCollection.findOne({ walletAddress: userWalletAddress });
        user = await calculateAndSaveBXC(user);
        const globalState = await globalStateCollection.findOne({});

        if (!user || user.BXC_Balance <= 0) {
            return res.status(400).json({ message: "No BXC balance to withdraw." });
        }
        if (globalState && globalState.isPaused) { 
            return res.status(400).json({ message: "BXC withdrawal is paused by admin." });
        }
        if (globalState && globalState.withdrawalsPaused) { 
            return res.status(400).json({ message: "All withdrawals are currently paused by admin." });
        }

        const withdrawAmount = (amount && amount > 0 && amount <= user.BXC_Balance) ? amount : user.BXC_Balance;

        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            { $inc: { BXC_Balance: -withdrawAmount } }
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
        console.error("[API/WITHDRAW] Error during BXC withdrawal:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});


app.post('/api/withdrawAIN', async (req, res) => {
    const { walletAddress, amount } = req.body;
    const now = new Date();

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

        if (!user || user.AIN_Balance <= 0) {
            return res.status(400).json({ message: "No AIN balance to withdraw." });
        }
        if (globalState && globalState.isPaused) { 
            return res.status(400).json({ message: "AIN withdrawal is paused by admin." });
        }
        if (globalState && globalState.withdrawalsPaused) { 
            return res.status(400).json({ message: "All withdrawals are currently paused by admin." });
        }

        const withdrawAmount = (amount && amount > 0 && amount <= user.AIN_Balance) ? amount : user.AIN_Balance;

        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            { $inc: { AIN_Balance: -withdrawAmount } }
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
        console.error("[API/WITHDRAW AIN] Error during AIN withdrawal:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});


app.post('/api/referral-copied', async (req, res) => {
    const { walletAddress } = req.body;
    const now = new Date();

    if (!walletAddress) {
        return res.status(400).json({ message: "Wallet address is required." });
    }

    const userWalletAddress = walletAddress.toLowerCase();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');
        const globalStateCollection = db.collection('globalState');

        let user = await usersCollection.findOne({ walletAddress: userWalletAddress });
        user = await calculateAndSaveBXC(user);
        const globalState = await globalStateCollection.findOne({});

        if (!user || user.slotsStaked === 0) {
            return res.status(400).json({ message: "Stake at least once to earn referral copy bonuses!" });
        }
        if (!globalState || !globalState.eventStartTime) {
            return res.status(400).json({ message: "Event has not started yet to earn copy bonuses." });
        }
        if (globalState && globalState.isPaused) { 
            return res.status(400).json({ message: "Referral bonus earning is paused by admin." });
        }

        if (user.lastReferralCopyBonusGiven && user.lastReferralCopyBonusGiven >= globalState.eventStartTime) {
             return res.status(400).json({ message: "You've already received the referral copy bonus for this event cycle." });
        }

        await usersCollection.updateOne(
            { walletAddress: userWalletAddress },
            {
                $inc: { BXC_Balance: REFERRAL_COPY_BXC_BONUS },
                $set: { lastReferralCopyBonusGiven: now }
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
        console.error("[API/REFERRAL-COPIED] Error awarding referral copy bonus:", error);
        res.status(500).json({ message: "Internal server error." });
    }
});

// --- ADMIN API ROUTES (Expanded) ---
app.post('/api/admin/status', async (req, res) => {
    const { walletAddress } = req.body;

    if (!walletAddress) {
        return res.status(400).json({ message: "Wallet address is required." });
    }

    if (isAdmin(walletAddress)) {
        res.status(200).json({ isAdmin: true, message: "Welcome, Admin!" });
    } else {
        res.status(403).json({ isAdmin: false, message: "Access Denied: Not an admin." });
    }
});

app.post('/api/admin/toggle-event-pause', async (req, res) => {
    const { walletAddress } = req.body;
    const now = new Date();

    if (!isAdmin(walletAddress)) {
        return res.status(403).json({ message: "Access Denied: Only admins can perform this action." });
    }

    try {
        const db = getDb();
        const globalStateCollection = db.collection('globalState');
        let globalState = await globalStateCollection.findOne({});

        if (!globalState) {
            return res.status(404).json({ message: "Global state not found. Event not initialized." });
        }

        let newIsPaused = !globalState.isPaused; 
        let newPauseStartTime = null;
        let newEventEndTime = globalState.eventEndTime;
        let message = `Event ${newIsPaused ? 'paused' : 'resumed'} successfully.`;

        if (newIsPaused) { 
            newPauseStartTime = now;
            console.log(`[ADMIN/TOGGLE-PAUSE] Admin paused event at: ${newPauseStartTime.toISOString()}`);
        } else { 
            if (globalState.pauseStartTime) {
                const pauseDurationMs = now.getTime() - globalState.pauseStartTime.getTime();
                newEventEndTime = new Date(globalState.eventEndTime.getTime() + pauseDurationMs);
                console.log(`[ADMIN/TOGGLE-PAUSE] Admin resumed event. Paused for ${pauseDurationMs / 1000} seconds. New event end time: ${newEventEndTime.toISOString()}`);
            } else {
                console.warn("[ADMIN/TOGGLE-PAUSE] Resuming event but no pauseStartTime recorded. Event time not adjusted.");
                message += " (Warning: No previous pause time to adjust end time.)";
            }
            newPauseStartTime = null; 
        }

        await globalStateCollection.updateOne(
            {},
            { $set: {
                isPaused: newIsPaused,
                pauseStartTime: newPauseStartTime,
                eventEndTime: newEventEndTime
            }}
        );

        res.status(200).json({
            message: message,
            isPaused: newIsPaused,
            eventEndTime: newEventEndTime 
        });

    } catch (error) {
        console.error("[ADMIN/TOGGLE-PAUSE] Error toggling event pause:", error);
        res.status(500).json({ message: "Internal server error toggling pause state." });
    }
});

// ADMIN ENDPOINT: POST /api/admin/set-event-duration
app.post('/api/admin/set-event-duration', async (req, res) => {
    const { walletAddress, durationHours } = req.body;
    const now = new Date();

    if (!isAdmin(walletAddress)) {
        return res.status(403).json({ message: "Access Denied: Only admins can perform this action." });
    }
    if (typeof durationHours !== 'number' || durationHours <= 0) {
        return res.status(400).json({ message: "Invalid durationHours. Must be a positive number." });
    }

    try {
        const db = getDb();
        const globalStateCollection = db.collection('globalState');

        const newEventStartTime = now;
        const newEventEndTime = new Date(now.getTime() + durationHours * 60 * 60 * 1000);

        await globalStateCollection.updateOne(
            {},
            { $set: {
                totalSlotsUsed: 0, 
                eventStartTime: newEventStartTime,
                eventEndTime: newEventEndTime,
                isPaused: false, 
                pauseStartTime: null,
                lastResetTime: now,
                eventDurationHours: durationHours, // Store the set duration
                totalAinRewarded: 0, 
            }},
            { upsert: true }
        );

        const usersCollection = db.collection('users');
        await usersCollection.updateMany(
            {}, 
            { $set: { 
                claimedEventRewardTime: null, 
                collectedEventRewardTime: null, 
                lastRevealedUSDAmount: 0,
            } }
        );

        console.log(`[ADMIN/SET-EVENT-DURATION] New event cycle set for ${durationHours} hours. Ends at: ${newEventEndTime.toISOString()}.`);
        res.status(200).json({
            message: `New event cycle set for ${durationHours} hours. Ends at: ${newEventEndTime}.`,
            eventStartTime: newEventStartTime,
            eventEndTime: newEventEndTime
        });

    } catch (error) {
        console.error("[ADMIN/SET-EVENT-DURATION] Error setting event time:", error);
        res.status(500).json({ message: "Internal server error setting event time." });
    }
});

// ADMIN ENDPOINT: POST /api/admin/toggle-withdrawals-pause
app.post('/api/admin/toggle-withdrawals-pause', async (req, res) => {
    const { walletAddress } = req.body;

    if (!isAdmin(walletAddress)) {
        return res.status(403).json({ message: "Access Denied: Only admins can perform this action." });
    }

    try {
        const db = getDb();
        const globalStateCollection = db.collection('globalState');
        let globalState = await globalStateCollection.findOne({});

        if (!globalState) {
            return res.status(404).json({ message: "Global state not found. Event not initialized." });
        }

        let newWithdrawalsPaused = !globalState.withdrawalsPaused; 
        
        await globalStateCollection.updateOne(
            {},
            { $set: {
                withdrawalsPaused: newWithdrawalsPaused
            }}
        );
        console.log(`[ADMIN/TOGGLE-WITHDRAWALS] All withdrawals are now ${newWithdrawalsPaused ? 'paused' : 'resumed'}.`);
        res.status(200).json({
            message: `All withdrawals are now ${newWithdrawalsPaused ? 'paused' : 'resumed'} by admin.`,
            withdrawalsPaused: newWithdrawalsPaused
        });

    } catch (error) {
        console.error("[ADMIN/TOGGLE-WITHDRAWALS] Error toggling withdrawals pause:", error);
        res.status(500).json({ message: "Internal server error toggling withdrawal pause state." });
    }
});

// ADMIN ENDPOINT: POST /api/admin/users-leaderboard (Enhanced for Feature 4)
app.post('/api/admin/users-leaderboard', async (req, res) => {
    const { walletAddress, sortBy = 'referralCount', limit = 100 } = req.body;

    if (!isAdmin(walletAddress)) {
        return res.status(403).json({ message: "Access Denied: Only admins can view user data." });
    }

    try {
        const db = getDb();
        const usersCollection = db.collection('users');

        const sortCriteria = {};
        const validSortBys = ['referralCount', 'BXC_Balance', 'AIN_Balance', 'stakedUSDValue', 'createdAt']; 
        if (validSortBys.includes(sortBy)) {
            sortCriteria[sortBy] = -1; 
            if (sortBy === 'createdAt') { 
                 sortCriteria[sortBy] = -1; 
            }
        } else {
            sortCriteria.referralCount = -1; 
        }

        const users = await usersCollection.find({})
                                        .project({ 
                                            walletAddress: 1, 
                                            referralCode: 1,
                                            referralCount: 1, 
                                            BXC_Balance: 1, 
                                            AIN_Balance: 1, 
                                            stakedUSDValue: 1,
                                            createdAt: 1 
                                        })
                                        .sort(sortCriteria)
                                        .limit(parseInt(limit))
                                        .toArray();

        res.status(200).json({
            message: "User leaderboard fetched successfully.",
            users: users
        });

    } catch (error) {
        console.error("[ADMIN/LEADERBOARD] Error fetching users leaderboard:", error);
        res.status(500).json({ message: "Internal server error fetching user data." });
    }
});

// NEW ADMIN ENDPOINT: POST /api/admin/set-staking-wallet (Feature 2)
app.post('/api/admin/set-staking-wallet', async (req, res) => {
    const { walletAddress, newStakingAddress } = req.body;

    if (!isAdmin(walletAddress)) {
        return res.status(403).json({ message: "Access Denied: Only admins can perform this action." });
    }
    if (!newStakingAddress || !/^0x[a-fA-F0-9]{40}$/.test(newStakingAddress)) {
        return res.status(400).json({ message: "Invalid Ethereum wallet address format." });
    }

    try {
        const db = getDb();
        const globalStateCollection = db.collection('globalState');
        
        await globalStateCollection.updateOne(
            {},
            { $set: { stakingRecipientAddress: newStakingAddress.toLowerCase() } },
            { upsert: true }
        );
        console.log(`[ADMIN/SET-STAKING-WALLET] Staking wallet address updated to: ${newStakingAddress.toLowerCase()}.`);
        res.status(200).json({
            message: `Staking wallet address updated to: ${newStakingAddress.toLowerCase()}.`,
            stakingRecipientAddress: newStakingAddress.toLowerCase()
        });

    } catch (error) {
        console.error("[ADMIN/SET-STAKING-WALLET] Error setting staking wallet:", error);
        res.status(500).json({ message: "Internal server error setting staking wallet." });
    }
});

// NEW ADMIN ENDPOINT: POST /api/admin/set-stake-amount (Feature 5)
app.post('/api/admin/set-stake-amount', async (req, res) => {
    const { walletAddress, newStakeAmount } = req.body;

    if (!isAdmin(walletAddress)) {
        return res.status(403).json({ message: "Access Denied: Only admins can perform this action." });
    }
    if (typeof newStakeAmount !== 'number' || newStakeAmount <= 0) {
        return res.status(400).json({ message: "Invalid stake amount. Must be a positive number." });
    }

    try {
        const db = getDb();
        const globalStateCollection = db.collection('globalState');
        
        await globalStateCollection.updateOne(
            {},
            { $set: { initialStakeAmountUSD: newStakeAmount } },
            { upsert: true }
        );
        console.log(`[ADMIN/SET-STAKE-AMOUNT] Initial stake amount updated to $${newStakeAmount.toFixed(2)}.`);
        res.status(200).json({
            message: `Initial stake amount updated to $${newStakeAmount.toFixed(2)}.`,
            initialStakeAmountUSD: newStakeAmount
        });

    } catch (error) {
        console.error("[ADMIN/SET-STAKE-AMOUNT] Error setting stake amount:", error);
        res.status(500).json({ message: "Internal server error setting stake amount." });
    }
});

// NEW ADMIN ENDPOINT: POST /api/admin/set-max-slots (Feature 6)
app.post('/api/admin/set-max-slots', async (req, res) => {
    const { walletAddress, newMaxSlots } = req.body;

    if (!isAdmin(walletAddress)) {
        return res.status(403).json({ message: "Access Denied: Only admins can perform this action." });
    }
    if (typeof newMaxSlots !== 'number' || newMaxSlots <= 0 || !Number.isInteger(newMaxSlots)) {
        return res.status(400).json({ message: "Invalid max slots. Must be a positive integer." });
    }

    try {
        const db = getDb();
        const globalStateCollection = db.collection('globalState');
        
        await globalStateCollection.updateOne(
            {},
            { $set: { maxStakeSlots: newMaxSlots } },
            { upsert: true }
        );
        console.log(`[ADMIN/SET-MAX-SLOTS] Maximum stake slots updated to ${newMaxSlots}.`);
        res.status(200).json({
            message: `Maximum stake slots updated to ${newMaxSlots}.`,
            maxStakeSlots: newMaxSlots
        });

    } catch (error) {
        console.error("[ADMIN/SET-MAX-SLOTS] Error setting max slots:", error);
        res.status(500).json({ message: "Internal server error setting max slots." });
    }
});

// NEW ADMIN ENDPOINT: POST /api/admin/set-ain-reward-pool (Feature 3)
app.post('/api/admin/set-ain-reward-pool', async (req, res) => {
    const { walletAddress, newMaxAinRewardPool } = req.body;

    if (!isAdmin(walletAddress)) {
        return res.status(403).json({ message: "Access Denied: Only admins can perform this action." });
    }
    if (typeof newMaxAinRewardPool !== 'number' || newMaxAinRewardPool < 0) {
        return res.status(400).json({ message: "Invalid AIN reward pool amount. Must be a non-negative number." });
    }

    try {
        const db = getDb();
        const globalStateCollection = db.collection('globalState');
        
        await globalStateCollection.updateOne(
            {},
            { $set: { maxAinRewardPool: newMaxAinRewardPool } },
            { upsert: true }
        );
        console.log(`[ADMIN/SET-AIN-POOL] Max AIN reward pool set to ${newMaxAinRewardPool} AIN.`);
        res.status(200).json({
            message: `Max AIN reward pool set to ${newMaxAinRewardPool} AIN.`,
            maxAinRewardPool: newMaxAinRewardPool
        });

    } catch (error) {
        console.error("[ADMIN/SET-AIN-POOL] Error setting AIN reward pool:", error);
        res.status(500).json({ message: "Internal server error setting AIN reward pool." });
    }
});

// NEW ADMIN ENDPOINT: POST /api/admin/fund-user (Feature 7)
app.post('/api/admin/fund-user', async (req, res) => {
    const { walletAddress: adminWalletAddress, targetWalletAddress, tokenType, amount } = req.body;

    if (!isAdmin(adminWalletAddress)) {
        return res.status(403).json({ message: "Access Denied: Only admins can perform this action." });
    }
    if (!targetWalletAddress || !/^0x[a-fA-F0-9]{40}$/.test(targetWalletAddress)) {
        return res.status(400).json({ message: "Invalid target wallet address format." });
    }
    if (!['BXC', 'AIN'].includes(tokenType)) {
        return res.status(400).json({ message: "Invalid token type. Must be 'BXC' or 'AIN'." });
    }
    if (typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ message: "Invalid amount. Must be a positive number." });
    }

    const userToFundAddress = targetWalletAddress.toLowerCase();

    try {
        const db = getDb();
        const usersCollection = db.collection('users');

        const updateField = tokenType === 'BXC' ? 'BXC_Balance' : 'AIN_Balance';
        
        const result = await usersCollection.updateOne(
            { walletAddress: userToFundAddress },
            { $inc: { [updateField]: amount } },
            { upsert: true } 
        );

        if (result.matchedCount === 0 && result.upsertedCount === 0) {
             return res.status(404).json({ message: `User ${userToFundAddress} not found and could not be created.` });
        }
        console.log(`[ADMIN/FUND-USER] Successfully funded ${userToFundAddress} with ${amount.toFixed(4)} ${tokenType}.`);
        res.status(200).json({
            message: `Successfully funded ${userToFundAddress} with ${amount.toFixed(4)} ${tokenType}.`,
            targetWallet: userToFundAddress,
            tokenType: tokenType,
            fundedAmount: amount
        });

    } catch (error) {
        console.error("[ADMIN/FUND-USER] Error funding user:", error);
        res.status(500).json({ message: "Internal server error funding user." });
    }
});


// --- Server Listener for Fly.io ---
connectToMongo().then(() => {
    app.listen(port, () => {
        console.log(`Backend server running on port ${port}`);
    });
}).catch(err => {
    console.error("FATAL: Failed to start server due to MongoDB connection or initialization error:", err);
    process.exit(1);
});

// --- Robust Error Handling for Uncaught Exceptions ---
process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
