const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } = require('@solana/web3.js');

// CONFIG - CHANGE THESE
const SOLANA_NETWORK = 'devnet'; // 'mainnet-beta' for real money
const GAME_WALLET_SECRET = process.env.GAME_WALLET_SECRET; // Your game wallet private key
const MIN_DEPOSIT = 0.01; // Minimum deposit in SOL
const SOL_TO_CREDITS = 100; // 1 SOL = $100 game credits

// Connect to Solana
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
  // Generate new wallet if none exists (for testing)
  gameWallet = Keypair.generate();
  console.log('Generated new game wallet:', gameWallet.publicKey.toString());
  console.log('Save this secret key:', JSON.stringify(Array.from(gameWallet.secretKey)));
}

// Store pending deposits (in production, use a database)
const pendingDeposits = new Map();

class SolanaWallet {
  constructor() {
    this.gameWalletAddress = gameWallet.publicKey.toString();
  }

  // Get game wallet address for deposits
  getDepositAddress() {
    return this.gameWalletAddress;
  }

  // Check if a transaction is a valid deposit
  async checkDeposit(txSignature, playerId) {
    try {
      const tx = await connection.getTransaction(txSignature);
      
      if (!tx) return { valid: false, error: 'Transaction not found' };
      
      // Check if transaction was to game wallet
      const accounts = tx.transaction.message.accountKeys;
      const destination = accounts[1]?.toString();
      
      if (destination !== this.gameWalletAddress) {
        return { valid: false, error: 'Not sent to game wallet' };
      }

      // Get amount
      const amount = tx.meta.postBalances[1] - tx.meta.preBalances[1];
      const solAmount = amount / LAMPORTS_PER_SOL;

      if (solAmount < MIN_DEPOSIT) {
        return { valid: false, error: 'Below minimum deposit' };
      }

      // Calculate credits
      const credits = solAmount * SOL_TO_CREDITS;

      return {
        valid: true,
        solAmount,
        credits,
        txSignature
      };

    } catch (err) {
      console.error('Check deposit error:', err);
      return { valid: false, error: err.message };
    }
  }

  // Process withdrawal
  async withdraw(playerAddress, solAmount) {
    try {
      const recipient = new PublicKey(playerAddress);
      const lamports = solAmount * LAMPORTS_PER_SOL;

      // Check game wallet balance
      const balance = await connection.getBalance(gameWallet.publicKey);
      if (balance < lamports + 5000) { // 5000 for fees
        return { success: false, error: 'Insufficient game funds' };
      }

      // Create transaction
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: gameWallet.publicKey,
          toPubkey: recipient,
          lamports,
        })
      );

      // Sign and send
      const signature = await connection.sendTransaction(transaction, [gameWallet]);
      await connection.confirmTransaction(signature);

      return {
        success: true,
        signature,
        solAmount
      };

    } catch (err) {
      console.error('Withdraw error:', err);
      return { success: false, error: err.message };
    }
  }

  // Get game wallet balance
  async getGameBalance() {
    const balance = await connection.getBalance(gameWallet.publicKey);
    return balance / LAMPORTS_PER_SOL;
  }
}

module.exports = SolanaWallet;
