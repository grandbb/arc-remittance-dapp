# ArcFX Remittance

ArcFX is a self-custodial USDC/EURC exchange and remittance interface for Arc. Mainnet uses the existing Uniswap V3 USDC/EURC 0.05% pool. No Circle API key, new contract deployment, or liquidity deposit is required. Testnet retains the separate owner-operated inventory contract.

## Existing Mainnet liquidity

- Pool: `0x6fd5f2fb831940dcd61a98c5b3acb7d8c6f3bfc1`
- SwapRouter02: `0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77`
- QuoterV2: `0x7dfd4f31be6814d2906bde155c3e1b146eac1468`
- Factory: `0xf0db7b58379503491d857db50ac9ece64c653918`

Deployment source: [Uniswap SDK Arc addresses](https://github.com/Uniswap/sdks/blob/main/sdks/sdk-core/src/addresses.ts). The app checks the factory registration, token pair, router and quoter factory addresses, deployed code and active liquidity before using this route. Quotes are simulated through QuoterV2 and include pool fees and price impact. Swaps use exact input with 0.5% slippage protection and a five-minute on-chain deadline, and send output directly to the recipient. This is a single verified pool route, not a best-price aggregator.

Run `npm run check:liquidity` to inspect current balances and quotes without signing a transaction. Pool balances are a snapshot, not a guarantee of executable depth for arbitrary amounts.

## How it works

1. The wallet connects to the configured Arc network.
2. The app simulates a quote against the existing Uniswap pool.
3. The user approves the input token when required.
4. One on-chain transaction swaps the tokens and sends the output directly to the recipient.

Quotes expire after five minutes and transactions include a 0.5% minimum-output guard. Mainnet approval is limited to the input amount for SwapRouter02. A simulation and gas-balance check run before requesting the swap signature.

## Requirements

- Node.js 22.13 or newer for the development tools
- An EVM wallet such as MetaMask or Rabby
- Mainnet liquidity is supplied by the existing Uniswap pool
- USDC for Arc gas and the input stablecoin for the transfer

No Circle account, StableFX entitlement, or API key is required.

## Local setup

```bash
npm install
copy .env.example .env
```

For Mainnet, use:

```dotenv
ARC_NETWORK=mainnet
PORT=3000
```

Then run:

```bash
npm start
```

Open `http://localhost:3000`.

## Optional Testnet inventory contract deployment

These steps apply only to `ARC_NETWORK=testnet`. Set `ARC_REMITTANCE_ADDRESS` to the resulting contract. Mainnet does not use this contract.

Compile the contracts with:

```bash
npm run compile
```

Deploy `ArcFXRemittance` with:

1. The USDC token address.
2. The EURC token address.
3. The initial EURC-to-USDC rate with 18-decimal precision.

The contract starts paused. After deployment, the owner must approve and call `addLiquidity` for both tokens, verify the rate, and then call `setPaused(false)`. Only the owner can add inventory. Withdrawals require the contract to be paused first. Ownership transfers use a two-step process: the current owner calls `transferOwnership`, then the new owner calls `acceptOwnership`.

The owner must keep `eurcToUsdcRate` current with `setEurcToUsdcRate`. Rates expire after one hour by default, and the owner can configure an expiry between five minutes and 24 hours with `setMaxRateAge`. This owner-managed rate is not a market oracle. Production operation therefore needs a monitored rate-publishing process and an owner wallet capable of pausing the contract when updates fail.

## Vercel deployment

Set these environment variables for the desired deployment environment:

```dotenv
ARC_NETWORK=mainnet
```

No secret or inventory contract address is needed for Mainnet. Deploy from the repository root using the existing `vercel.json` configuration.

## Tests

```bash
npm test
npm run demo
```

The tests compile the contracts and run transfers on a temporary local Hardhat chain. No real funds are used.

## Security notes

- Review and audit the contract before production deployment.
- Use a multisig or governed owner account for rate updates.
- Keep the contract paused until both token inventories and the initial rate have been verified.
- Monitor contract liquidity and pause the frontend if either side is insufficient.
- Verify the configured contract address and token addresses before funding.
- The frontend never asks for a seed phrase or private key.
- Smart-contract transactions are irreversible. Always test on Arc Testnet first.

## Network configuration

The server exposes public network configuration to the browser through `/api/config`. Supported values for `ARC_NETWORK` are `mainnet` and `testnet`. Token and RPC addresses are defined in `server.js`.

## License

MIT
