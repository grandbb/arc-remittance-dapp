# ArcFX Remittance

ArcFX is a USDC/EURC exchange and remittance interface for Arc Mainnet. It uses Circle StableFX for live RFQ pricing and payment-versus-payment settlement instead of the prototype's owner-controlled exchange rate.

The browser connects to the user's EVM wallet, verifies every EIP-712 payload against the selected Arc network and official Permit2/token addresses, and signs the quote and funding instructions. A small Node.js server keeps the Circle API key private, validates requests, creates idempotency keys, and proxies the supported StableFX operations.

## Arc Mainnet configuration

| Item | Value |
| --- | --- |
| Chain ID | `5042` |
| RPC | `https://rpc.mainnet.arc.io` |
| Explorer | `https://explorer.arc.io` |
| Native gas asset | USDC |
| USDC ERC-20 interface | `0x3600000000000000000000000000000000000000` |
| EURC | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| StableFX escrow | `0xe2E5F173576B513d994073CCbDaCBE027d43DFe6` |

USDC and EURC use 6 decimals through their ERC-20 interfaces. Arc's native gas accounting uses the same USDC balance with 18-decimal precision. The UI reads token decimals from each contract and treats the native and ERC-20 USDC views as one asset.

## Requirements

- Node.js 20 or newer
- An EIP-1193 wallet with Arc support, such as MetaMask or Rabby
- A StableFX API key issued by Circle to an approved institution
- USDC/EURC on Arc and enough USDC remaining for gas

StableFX is permissioned. Contact your Circle representative to obtain production access; a normal Circle developer API key may not have StableFX permissions.

## Run

```bash
npm ci
copy .env.example .env
npm start
```

Edit `.env` before starting:

```dotenv
ARC_NETWORK=mainnet
CIRCLE_API_KEY=YOUR_STABLEFX_API_KEY
CIRCLE_API_BASE_URL=https://api.circle.com
PORT=3000
```

Open `http://localhost:3000`. Do not open `index.html` directly because all StableFX calls must pass through the server.

## Deploy to Vercel

The repository includes a Vercel serverless entrypoint and production routing configuration. Configure `ARC_NETWORK`, `CIRCLE_API_BASE_URL`, and `CIRCLE_API_KEY` in the Vercel project environment, then deploy from the repository root:

```bash
npx vercel --prod
```

For Circle's testing environment, change the network and API together:

```dotenv
ARC_NETWORK=testnet
CIRCLE_API_BASE_URL=https://api-sandbox.circle.com
CIRCLE_API_KEY=YOUR_TEST_STABLEFX_API_KEY
```

The server will use Arc Testnet chain ID `5042002` and the official testnet EURC/StableFX addresses. Mixing a sandbox quote with Mainnet is rejected in the browser before signing.

## User flow

1. Connect a wallet and switch to the configured Arc network.
2. Choose USDC or EURC, enter an amount and the recipient wallet.
3. Request a tradable StableFX quote from the server.
4. Review the received amount, rate, fee and expiry.
5. If needed, approve the selected token for the official Permit2 contract.
6. Sign the quote, create the trade, sign the funding payload and submit funding.
7. The app polls the StableFX trade until settlement completes or reaches a terminal state.

The API key never reaches the browser. The server only accepts the USDC/EURC pair, validates amounts and addresses, limits request size and rate, uses request timeouts, adds per-request tracing IDs, and validates a stable per-attempt idempotency key for safe trade retries.

## Test and verify

```bash
npm test
npm run compile
npm run demo
```

The server tests verify official mainnet configuration, payload normalization, API-key isolation, input validation and the disabled-without-credentials behavior. The original Solidity pool and local demo remain only as an offline reference and are not used by the production interface. They have not been audited and must not be deployed for real funds.

## Production checklist

- Terminate TLS at a trusted reverse proxy and set `ALLOWED_ORIGINS` to the deployed UI origin.
- Store `CIRCLE_API_KEY` in a managed secret store and rotate it according to your organization's policy.
- Register StableFX webhooks, verify Circle's webhook signature, and persist trade state in a database for recovery after process restarts.
- Add user authentication, sanctions/compliance screening, transaction limits and an operational review trail required for your jurisdiction.
- Monitor Arc RPC health and StableFX error rates. Use a managed Arc RPC provider for production failover.
- Complete an independent security review before accepting customer funds.

## Official documentation

- [Connect to Arc](https://docs.arc.io/arc/references/connect-to-arc)
- [Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses)
- [Arc gas and fees](https://docs.arc.io/arc/references/gas-and-fees)
- [Circle StableFX overview](https://developers.circle.com/stablefx)
- [StableFX taker quickstart](https://developers.circle.com/stablefx/quickstarts/fx-trade-taker)

## License

MIT
