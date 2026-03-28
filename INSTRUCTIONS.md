# Sherpa Rescue Instructions

Use this tool to turn a valid unspent Sherpa Avalanche note into a withdrawal transaction and broadcast it.

## What You Need

- A Sherpa note such as `sherpa-avax-100-43114-0x...`
- A recipient address you control on Avalanche C-Chain
- A private key for a wallet with enough AVAX to pay gas
- Either Docker, or Node.js 18+ with Rust/Cargo

Keep your note and private key secret. This tool only supports the Avalanche Sherpa pools listed in `config/instances.json`.

## Docker

You can either pull the image directly:

```bash
docker pull tcrypt/sherpa-rescue
```

Or build it yourself after checking out the repository:

```bash
git clone https://github.com/tcrypt25519/tyler-smith/Sherpa-Cash.git
cd Sherpa-Cash/rescue/canonical-withdraw-kit
make docker
```

Run the commands from a directory where you want output files saved.

### 1. Generate `withdrawal.json`

```bash
docker run --rm \
  -v "$PWD:/work" \
  tcrypt/sherpa-rescue \
  'sherpa-avax-100-43114-0xYOUR_NOTE_HERE' \
  '0xYOUR_WALLET_ADDRESS'
```

This writes:

```text
./rescue-output/withdrawal.json
```

### 2. Broadcast

```bash
export SHERPA_PRIVATE_KEY='0xYOUR_PRIVATE_KEY'

docker run --rm \
  -v "$PWD:/work" \
  -e SHERPA_PRIVATE_KEY \
  tcrypt/sherpa-rescue \
  broadcast
```

Useful extras:

- Add `--rpc 'https://your-rpc-here'` to either command to override the default RPC.
- Add `--force-tree` to the withdraw step if you need a fresh Merkle tree rebuild.

## Direct npm / Node + Rust

If you do not want Docker:

```bash
git clone https://github.com/tcrypt25519/tyler-smith/Sherpa-Cash.git
cd Sherpa-Cash/rescue/canonical-withdraw-kit
npm install
```

Generate the withdrawal package:

```bash
node cli.js withdraw \
  --note 'sherpa-avax-100-43114-0xYOUR_NOTE_HERE' \
  --recipient '0xYOUR_WALLET_ADDRESS' \
  --out-dir ./rescue-output \
  --progress
```

Broadcast it:

```bash
export SHERPA_PRIVATE_KEY='0xYOUR_PRIVATE_KEY'

node cli.js broadcast \
  --withdrawal ./rescue-output/withdrawal.json
```

## Success

The withdraw step should end by printing:

- where `withdrawal.json` was written
- the pool and verifier addresses
- `On-chain verification: true`

The broadcast step should print the Avalanche transaction hash.

## Common Failures

`The note has invalid format`

Your note is malformed.

`The note has already been spent`

That note was already withdrawn on-chain.

`Computed root is not known by the contract`

Retry the withdraw step with `--force-tree`.

RPC timeouts or scan failures

Retry the same command, or pass `--rpc` with a better Avalanche C-Chain RPC endpoint.

Broadcast failures

Make sure the sender wallet has AVAX for gas and retry.
