# Sherpa Rescue

Recover unspent Sherpa Cash notes by generating withdrawal transactions and broadcasting them on-chain.

## What You Need

- A Sherpa note: `sherpa-avax-{amount}-43114-0x...`
- A recipient address you control on Avalanche C-Chain
- A private key for a wallet with enough AVAX to pay gas
- Either Docker, or Node.js 18+ with Rust/Cargo

**Keep your note and private key secret.**

## What This Does

- Infers the correct Sherpa instance from your note
- Rebuilds the Merkle tree from chain events
- Generates a zk-SNARK witness and proof using recovered `phase2` params
- Verifies the proof locally and against the live on-chain verifier
- Emits ready-to-submit withdrawal calldata

## What This Supports

- **Only** Avalanche C-Chain Sherpa pools listed in `config/instances.json`
- Unspent notes in `sherpa-avax-{amount}-43114-0x...` format
- Recovery to any Avalanche C-Chain address you control

---

## Quick Start

### Option 1: Pre-built Docker (Fastest)

Pull and run directly:

```bash
docker pull tcrypt/sherpa-rescue
```

**Step 1: Generate withdrawal proof**

```bash
docker run --rm \
  -v "$PWD:/work" \
  tcrypt/sherpa-rescue \
  'sherpa-avax-100-43114-0xYOUR_NOTE_HERE' \
  '0xYOUR_WALLET_ADDRESS'
```

Writes `./rescue-output/withdrawal.json`.

**Step 2: Broadcast**

```bash
export SHERPA_PRIVATE_KEY='0xYOUR_PRIVATE_KEY'

docker run --rm \
  -v "$PWD:/work" \
  -e SHERPA_PRIVATE_KEY \
  tcrypt/sherpa-rescue \
  broadcast
```

Prints the Avalanche transaction hash on success.

---

### Option 2: Build Docker Yourself

```bash
git clone https://github.com/tcrypt25519/sherpa-rescue.git
cd sherpa-rescue
make docker
```

Then use the same commands as Option 1.

---

### Option 3: Direct npm + Rust

```bash
git clone https://github.com/tcrypt25519/sherpa-rescue.git
cd sherpa-rescue
npm install
```

**Step 1: Generate withdrawal proof**

```bash
node cli.js withdraw \
  --note 'sherpa-avax-100-43114-0xYOUR_NOTE_HERE' \
  --recipient '0xYOUR_WALLET_ADDRESS' \
  --out-dir ./rescue-output \
  --progress
```

**Step 2: Broadcast**

```bash
export SHERPA_PRIVATE_KEY='0xYOUR_PRIVATE_KEY'

node cli.js broadcast \
  --withdrawal ./rescue-output/withdrawal.json
```

---

## Common Issues

| Error | Solution |
|-------|----------|
| `The note has invalid format` | Your note is malformed |
| `The note has already been spent` | That note was already withdrawn |
| `Computed root is not known by the contract` | Retry with `--force-tree` |
| RPC timeouts/scan failures | Retry or pass `--rpc 'https://your-rpc'` |
| Broadcast fails | Ensure sender wallet has AVAX for gas |

## Additional Options

- `--rpc 'https://your-rpc'`: Override default RPC endpoint
- `--force-tree`: Force fresh Merkle tree rebuild
- `--progress`: Show batch progress during tree scans

See `node cli.js --help` for full options.

## Success Indicators

**Withdraw step** prints:
- Path to `withdrawal.json`
- Pool and verifier addresses
- `On-chain verification: true`

**Broadcast step** prints:
- Avalanche transaction hash
