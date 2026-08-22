# Contributing to ArcFX Remittance

Thanks for helping improve this testnet prototype. Bug reports, documentation fixes, tests, and focused contract or interface improvements are welcome.

## Local setup

Requirements: Node.js 20 or newer.

```bash
git clone https://github.com/grandbb/arc-remittance-dapp.git
cd arc-remittance-dapp
npm ci
npm test
npm run compile
```

## Pull requests

1. Fork the repository and create a short, descriptive branch.
2. Keep the change focused on one problem.
3. Add or update tests when contract behavior changes.
4. Run `npm test` and `npm run compile` before opening the pull request.
5. Explain the user-visible effect and any security assumptions.

Never commit private keys, seed phrases, funded account credentials, or production RPC secrets. This repository is for testnet and local-development use only.

## Good first contributions

- Add boundary tests for zero values and rate updates.
- Improve accessible labels and keyboard states in `index.html`.
- Add an optional minimum-output parameter with tests.
- Clarify setup or contract-flow documentation.

