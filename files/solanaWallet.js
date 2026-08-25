const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const SOLANA_NETWORK = 'devnet'; // or 'mainnet-beta'
const GAME_WALLET_SECRET = process.env.GAME_WALLET_SECRET;

const connection = new Connection(
  `https://api.${SOLANA_NETWORK}.solana.com`,
  'confirmed'
);

// Game wallet (holds all deposits)
let gameWallet;
if (GAME_WALLET_SECRET) {
  const secretKey = Uint8Array.from(JSON.parse(GAME_WALLET_SECRET));
  gameWallet = Keypair.fromSecretKey(secretKey);
} else {
  gameWallet = Keypair.generate();
  console.log('Generated game wallet:', gameWallet.publicKey.toString());
  console.log('SECRET:', JSON.stringify(Array.from(gameWallet.secretKey)));
}

// Track player deposit addresses
const playerDepositAddresses = new Map(); // playerId -> { address, secret, balance }

class SolanaWallet {
  constructor() {
    this.gameWalletAddress = gameWallet.publicKey.toString();
    this.knownSignatures = new Set(); // Track processed transactions
    
    // Start watching for deposits
    this.startWatching();
  }

  getDepositAddress() {
    return this.gameWalletAddress;
  }

  // Generate unique deposit address for each player
  getPlayerDepositAddress(playerId) {
    if (playerDepositAddresses.has(playerId)) {
      return playerDepositAddresses.get(playerId).address;
    }

    // Create new address for this player
    const newWallet = Keypair.generate();
    const playerData = {
      address: newWallet.publicKey.toString(),
      secret: JSON.stringify(Array.from(newWallet.secretKey)),
      balance: 0,
      playerId: playerId
    };
    
    playerDepositAddresses.set(playerId, playerData);
    console.log(`Created deposit address for ${playerId}: ${playerData.address}`);
    
    return playerData.address;
  }

  // Watch blockchain for new deposits
  async startWatching() {
    console.log('Starting blockchain watcher...');
    
    setInterval(async () => {
      await this.checkForDeposits();
    }, 30000); // Check every 30 seconds
  }

  async checkForDeposits() {
    try {
      // Get recent transactions to game wallet
      const signatures = await connection.getSignaturesForAddress(
        gameWallet.publicKey,
        { limit: 50 }
      );

      for (const sigInfo of signatures) {
        if (this.knownSignatures.has(sigInfo.signature)) continue;
        
        const tx = await connection.getTransaction(sigInfo.signature);
        if (!tx || !tx.meta) continue;

        // Check if this is a deposit (incoming SOL)
        const preBalance = tx.meta.preBalances[0] || 0;
        const postBalance = tx.meta.postBalances[0] || 0;
        const amount = (postBalance - preBalance) / LAMPORTS_PER_SOL;

        if (amount > 0) {
          // Find which player this belongs to
          const fromAddress = tx.transaction.message.accountKeys[0]?.toString();
          await this.processDeposit(fromAddress, amount, sigInfo.signature);
        }

        this.knownSignatures.add(sigInfo.signature);
      }
    } catch (err) {
      console.error('Error checking deposits:', err);
    }
  }

  async processDeposit(fromAddress, amount, signature) {
    // Find player by matching deposit address
    let playerId = null;
    for (const [pid, data] of playerDepositAddresses) {
      if (data.address === fromAddress) {
        playerId = pid;
        break;
      }
    }

    if (!playerId) {
      console.log(`Unknown deposit from ${fromAddress}: ${amount} SOL`);
      return;
    }

    // Calculate credits (1 SOL = 100 credits)
    const credits = amount * 100;
    
    // Update player balance
    const playerData = playerDepositAddresses.get(playerId);
    playerData.balance += credits;
    playerData.solBalance = (playerData.solBalance || 0) + amount;
    
    console.log(`Auto-credited ${playerId}: ${amount} SOL = ${credits} credits`);
    
    // Here you would also update your game database
    // await db.updatePlayerBalance(playerId, credits);
  }

  // Get player balance
  getPlayerBalance(playerId) {
    const data = playerDepositAddresses.get(playerId);
    if (!data) return { sol: 0, credits: 0, address: this.getPlayerDepositAddress(playerId) };
    return {
      sol: data.solBalance || 0,
      credits: data.balance || 0,
      address: data.address
    };
  }

  // Process withdrawal
  async withdraw(playerAddress, solAmount) {
    try {
      const recipient = new PublicKey(playerAddress);
      const lamports = solAmount * LAMPORTS_PER_SOL;

      const balance = await connection.getBalance(gameWallet.publicKey);
      if (balance < lamports + 5000) {
        return { success: false, error: 'Insufficient game funds' };
      }

      const { Transaction, SystemProgram } = require('@solana/web3.js');
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: gameWallet.publicKey,
          toPubkey: recipient,
          lamports,
        })
      );

      const signature = await connection.sendTransaction(transaction, [gameWallet]);
      await connection.confirmTransaction(signature);

      return { success: true, signature, solAmount };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

module.exports = SolanaWallet;
