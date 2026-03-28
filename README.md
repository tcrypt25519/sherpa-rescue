# Canonical Withdraw Kit

This directory contains the recovered canonical artifacts and tooling needed to:

1. infer the correct Sherpa instance from a note
2. rebuild the Merkle tree from chain events
3. generate a witness
4. generate a proof with the recovered `phase2` params
5. verify the proof locally inside the Rust prover
6. verify the proof against the live on-chain verifier
7. emit ready-to-submit withdrawal calldata

Merkle tree snapshots live under `artifacts/roots/`. The CLI prefers an existing known root there and only tries to extend or rebuild the tree when that root has fallen out of the contract's root history.

## Requirements

- Node.js 18+
- Rust + Cargo

## Install

```bash
npm install
```

## Docker

Build the image from this directory:

```bash
docker build -t tcrypt/sherpa-rescue .
```

Run the default `withdraw` command:

```bash
docker run --rm tcrypt/sherpa-rescue \
  --note 'sherpa-avax-10-43114-0x...' \
  --recipient '0x1111111111111111111111111111111111111111'
```

Use the local wrapper script when you want to pass a note, recipient, and output directory in one command:

```bash
./run-withdraw.sh \
  'sherpa-avax-10-43114-0x...' \
  '0x1111111111111111111111111111111111111111'
```

The wrapper always writes results to `./recovery-output` on the host, mounted as `/work/recovery-output` in the container.

For a simple two-step Docker flow with a review pause in the middle, use the in-container wrapper script:

```bash
docker run --rm \
  -v "$PWD:/work" \
  tcrypt/sherpa-rescue \
  run-node-withdraw.sh create \
  'sherpa-avax-10-43114-0x...' \
  '0x1111111111111111111111111111111111111111'
```

Inspect `./recovery-output/withdrawal.json`, then send it:

```bash
docker run --rm \
  -e SHERPA_PRIVATE_KEY \
  -v "$PWD:/work" \
  tcrypt/sherpa-rescue \
  run-node-withdraw.sh send \
  'sherpa-avax-10-43114-0x...' \
  '0x1111111111111111111111111111111111111111'
```

Run an explicit subcommand if needed:

```bash
docker run --rm tcrypt/sherpa-rescue build-tree --all
```

Show CLI help:

```bash
docker run --rm tcrypt/sherpa-rescue --help
```

## Usage

If you are trying to recover funds and do not care about the internals, read `INSTRUCTIONS.md`.

Build or refresh the tree for a note's pool:

```bash
node cli.js build-tree \
  --note 'sherpa-avax-10-43114-0x...'
```

Build trees for all configured pools:

```bash
node cli.js build-tree --all
```

Build one specific pool without a note:

```bash
node cli.js build-tree --net-id 43114 --currency avax --amount 10
```

Show resumable in-progress scans:

```bash
node cli.js resume-status
```

Generate a withdrawal proof and calldata:

```bash
node cli.js withdraw \
  --note 'sherpa-avax-10-43114-0x...' \
  --recipient '0x1111111111111111111111111111111111111111' \
  --rpc 'https://api.avax.network/ext/bc/C/rpc'
```

Broadcast a generated `withdrawal.json`:

```bash
node cli.js broadcast \
  --withdrawal ./recovery-output/withdrawal.json
```

Optional flags:

- `--relayer <address>`: default zero address
- `--fee-wei <amount>`: default `0`
- `--refund-wei <amount>`: default `0`
- `--skip-spent-check`: useful for spent-note testing
- `--force-tree`: rebuild the tree even if a current cache exists
- `--block-step <n>`: default `2000`
- `--progress`: log batch 1, every 100th batch, and the final batch during tree scans
- `--retries <n>`: default `5`
- `--retry-delay-ms <ms>`: default `1500`
- `--out <path>`: explicit output JSON path for a single build
- `--all`: build every configured pool
- `--net-id <id>`: filter to a network
- `--currency <symbol>`: filter to a currency
- `--amount <value>`: filter to a denomination
- `--instance <address>`: filter to a specific deployed instance

## Output

The `withdraw` command writes a JSON file containing:

- resolved instance and verifier addresses
- refreshed tree metadata
- witness/proof/public input file paths
- Solidity proof bytes
- public inputs
- on-chain verification result
- encoded `withdraw(...)` calldata

## Notes

- Supported notes in this kit are Avalanche mainnet (`43114`) `avax` and `tsd` notes covered by `config/instances.json`.
- Bundled root snapshots are stored as `artifacts/roots/<netId>-<currency>-<amount>.json`.
- Interrupted scans leave resumable sidecars next to the target tree file as `*.progress.json` and `*.events.jsonl`; rerunning the same build resumes automatically.
- `resume-status` reports any resumable scans it finds under the kit directory.
- Proof generation uses the recovered canonical `phase2` params at `artifacts/result.params`.
- The historical JS proving-key exports were inconsistent; this kit intentionally uses the Rust `phase2` prover because that path is confirmed to produce proofs accepted by the live verifier.
- A first-time rebuild from deployment block can be slow on public RPC endpoints.
