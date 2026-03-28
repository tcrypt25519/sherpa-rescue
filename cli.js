#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { Command } = require('commander')
const Web3 = require('web3')
const snarkjs = require('snarkjs')
const Circuit = require('snarkjs/src/circuit')
const { stringifyBigInts, unstringifyBigInts } = require('snarkjs/src/stringifybigint')
const circomlib = require('circomlib')

const MerkleTree = require('./lib/MerkleTree')
const instances = require('./config/instances.json')

const ROOT = __dirname
const ROOTS_DIR = path.join(ROOT, 'artifacts', 'roots')
const DEFAULT_RPC = 'https://api.avax.network/ext/bc/C/rpc'
const DEFAULT_BLOCK_STEP = 2000
const DEFAULT_RETRIES = 5
const DEFAULT_RETRY_DELAY_MS = 1500
const PROGRESS_LOG_EVERY_BATCHES = 100
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const bigInt = snarkjs.bigInt

const verifierAbi = [
  {
    constant: false,
    inputs: [
      { name: 'proof', type: 'bytes' },
      { name: 'input', type: 'uint256[6]' },
    ],
    name: 'verifyProof',
    outputs: [{ name: '', type: 'bool' }],
    payable: false,
    stateMutability: 'nonpayable',
    type: 'function',
  },
]

const sherpaAbi = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'bytes32', name: 'commitment', type: 'bytes32' },
      { indexed: false, internalType: 'uint32', name: 'leafIndex', type: 'uint32' },
      { indexed: false, internalType: 'uint256', name: 'timestamp', type: 'uint256' },
    ],
    name: 'Deposit',
    type: 'event',
  },
  {
    constant: true,
    inputs: [],
    name: 'levels',
    outputs: [{ internalType: 'uint32', name: '', type: 'uint32' }],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: true,
    inputs: [{ internalType: 'bytes32', name: '_root', type: 'bytes32' }],
    name: 'isKnownRoot',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: true,
    inputs: [{ internalType: 'bytes32', name: '_nullifierHash', type: 'bytes32' }],
    name: 'isSpent',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'verifier',
    outputs: [{ internalType: 'contract IVerifier', name: '', type: 'address' }],
    payable: false,
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: false,
    inputs: [
      { internalType: 'bytes', name: '_proof', type: 'bytes' },
      { internalType: 'bytes32', name: '_root', type: 'bytes32' },
      { internalType: 'bytes32', name: '_nullifierHash', type: 'bytes32' },
      { internalType: 'address payable', name: '_recipient', type: 'address' },
      { internalType: 'address payable', name: '_relayer', type: 'address' },
      { internalType: 'uint256', name: '_fee', type: 'uint256' },
      { internalType: 'uint256', name: '_refund', type: 'uint256' },
    ],
    name: 'withdraw',
    outputs: [],
    payable: true,
    stateMutability: 'payable',
    type: 'function',
  },
]

function pedersenHash(data) {
  return circomlib.babyJub.unpackPoint(circomlib.pedersenHash.hash(data))[0]
}

function toHex(number, length = 32) {
  const str = number instanceof Buffer ? number.toString('hex') : bigInt(number).toString(16)
  return '0x' + str.padStart(length * 2, '0')
}

function mkdirp(target) {
  fs.mkdirSync(target, { recursive: true })
}

function writeJson(target, value) {
  fs.writeFileSync(target, JSON.stringify(value, null, 2))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseNote(noteString) {
  const noteRegex = /sherpa-(?<currency>\w+)-(?<amount>[\d.]+)-(?<netId>\d+)-0x(?<note>[0-9a-fA-F]{124})/g
  const match = noteRegex.exec(noteString)
  if (!match) {
    throw new Error('The note has invalid format')
  }

  const buf = Buffer.from(match.groups.note, 'hex')
  const nullifier = bigInt.leBuff2int(buf.slice(0, 31))
  const secret = bigInt.leBuff2int(buf.slice(31, 62))
  const deposit = createDeposit({ nullifier, secret })

  return {
    currency: match.groups.currency.toLowerCase(),
    amount: match.groups.amount,
    netId: Number(match.groups.netId),
    deposit,
    note: noteString,
  }
}

function createDeposit({ nullifier, secret }) {
  const deposit = { nullifier, secret }
  deposit.preimage = Buffer.concat([deposit.nullifier.leInt2Buff(31), deposit.secret.leInt2Buff(31)])
  deposit.commitment = pedersenHash(deposit.preimage)
  deposit.commitmentHex = toHex(deposit.commitment)
  deposit.nullifierHash = pedersenHash(deposit.nullifier.leInt2Buff(31))
  deposit.nullifierHex = toHex(deposit.nullifierHash)
  return deposit
}

function resolveInstance(parsedNote) {
  const network = instances[String(parsedNote.netId)]
  if (!network) {
    throw new Error(`Unsupported netId ${parsedNote.netId}`)
  }
  const currencyConfig = network.currencies[parsedNote.currency]
  if (!currencyConfig) {
    throw new Error(`Unsupported currency ${parsedNote.currency} on netId ${parsedNote.netId}`)
  }
  const instance = currencyConfig[parsedNote.amount]
  if (!instance) {
    throw new Error(`Unsupported amount ${parsedNote.amount} for ${parsedNote.currency} on netId ${parsedNote.netId}`)
  }
  return {
    verifier: network.verifier,
    netId: parsedNote.netId,
    currency: parsedNote.currency,
    amount: parsedNote.amount,
    ...instance,
  }
}

function listConfiguredInstances() {
  const all = []
  for (const [netId, network] of Object.entries(instances)) {
    for (const [currency, currencyConfig] of Object.entries(network.currencies)) {
      for (const [amount, instance] of Object.entries(currencyConfig)) {
        all.push({
          verifier: network.verifier,
          netId: Number(netId),
          currency,
          amount,
          ...instance,
        })
      }
    }
  }
  return all
}

function matchesFilter(value, expected) {
  if (expected === undefined || expected === null || expected === '') {
    return true
  }
  return String(value).toLowerCase() === String(expected).toLowerCase()
}

function selectInstances(options) {
  const all = listConfiguredInstances()
  const selected = all.filter((instanceConfig) => {
    if (!matchesFilter(instanceConfig.netId, options.netId)) {
      return false
    }
    if (!matchesFilter(instanceConfig.currency, options.currency)) {
      return false
    }
    if (!matchesFilter(instanceConfig.amount, options.amount)) {
      return false
    }
    if (!matchesFilter(instanceConfig.address, options.instance)) {
      return false
    }
    return true
  })
  if (selected.length === 0) {
    throw new Error('No configured instances matched the requested filters')
  }
  return selected
}

function createProgressLogger(label) {
  return ({ start, end, batchIndex, totalBatches, batchEvents, totalEvents }) => {
    const shouldLog =
      batchIndex === 1 ||
      batchIndex === totalBatches ||
      batchIndex % PROGRESS_LOG_EVERY_BATCHES === 0
    if (!shouldLog) {
      return
    }
    const percent = ((batchIndex / totalBatches) * 100).toFixed(1)
    console.log(
      `[progress] ${label} batch ${batchIndex}/${totalBatches} (${percent}%) blocks ${start}-${end} events ${batchEvents} totalEvents ${totalEvents}`,
    )
  }
}

function normalizeDepositEvent(event) {
  if (event && event.returnValues) {
    return {
      commitment: event.returnValues.commitment,
      leafIndex: Number(event.returnValues.leafIndex),
      blockNumber: Number(event.blockNumber),
      txHash: event.transactionHash,
    }
  }
  return {
    commitment: event.commitment,
    leafIndex: Number(event.leafIndex),
    blockNumber: Number(event.blockNumber),
    txHash: event.txHash,
  }
}

function getScanSidecarPaths(treePath) {
  return {
    progressPath: `${treePath}.progress.json`,
    eventsPath: `${treePath}.events.jsonl`,
  }
}

function removeIfExists(target) {
  if (fs.existsSync(target)) {
    fs.unlinkSync(target)
  }
}

function appendEvents(eventsPath, batch) {
  if (!batch || batch.length === 0) {
    return
  }
  const lines = batch
    .map((event) => JSON.stringify({
      commitment: event.returnValues.commitment,
      leafIndex: Number(event.returnValues.leafIndex),
      blockNumber: Number(event.blockNumber),
      txHash: event.transactionHash,
    }))
    .join('\n') + '\n'
  fs.appendFileSync(eventsPath, lines)
}

function loadEventScan(eventsPath) {
  if (!fs.existsSync(eventsPath)) {
    return []
  }
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function buildScanProgress({
  mode,
  instanceConfig,
  fromBlock,
  toBlock,
  lastProcessedBlock,
  totalEvents,
  eventsPath,
}) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode,
    chainId: instanceConfig.netId,
    currency: instanceConfig.currency,
    amount: instanceConfig.amount,
    instance: instanceConfig.address,
    verifier: instanceConfig.verifier,
    fromBlock,
    toBlock,
    lastProcessedBlock,
    totalEvents,
    eventsFile: eventsPath,
  }
}

function readScanProgress(progressPath, instanceConfig, mode, eventsPath, fromBlock) {
  if (!fs.existsSync(progressPath) || !fs.existsSync(eventsPath)) {
    return null
  }
  const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'))
  if (progress.mode !== mode) {
    return null
  }
  if (String(progress.instance).toLowerCase() !== String(instanceConfig.address).toLowerCase()) {
    return null
  }
  if (Number(progress.chainId) !== Number(instanceConfig.netId)) {
    return null
  }
  if (String(progress.currency).toLowerCase() !== String(instanceConfig.currency).toLowerCase()) {
    return null
  }
  if (String(progress.amount) !== String(instanceConfig.amount)) {
    return null
  }
  if (Number(progress.fromBlock) !== Number(fromBlock)) {
    return null
  }
  if (!progress.eventsFile) {
    return null
  }
  if (path.resolve(progress.eventsFile) !== path.resolve(eventsPath)) {
    return null
  }
  return progress
}

async function scanDeposits({
  contract,
  instanceConfig,
  treePath,
  fromBlock,
  toBlock,
  blockStep,
  retries,
  retryDelayMs,
  showProgress,
  mode,
}) {
  const { progressPath, eventsPath } = getScanSidecarPaths(treePath)
  const progressLogger = showProgress
    ? createProgressLogger(`${mode} ${instanceConfig.netId}-${instanceConfig.currency}-${instanceConfig.amount}`)
    : null

  let progress = readScanProgress(progressPath, instanceConfig, mode, eventsPath, fromBlock)
  let start = fromBlock
  let totalEvents = 0

  if (!progress) {
    removeIfExists(progressPath)
    removeIfExists(eventsPath)
    writeJson(progressPath, buildScanProgress({
      mode,
      instanceConfig,
      fromBlock,
      toBlock,
      lastProcessedBlock: fromBlock - 1,
      totalEvents: 0,
      eventsPath,
    }))
  } else {
    start = Number(progress.lastProcessedBlock) + 1
    totalEvents = Number(progress.totalEvents) || 0
    progress.toBlock = toBlock
    progress.generatedAt = new Date().toISOString()
    writeJson(progressPath, progress)
    if (showProgress) {
      console.log(
        `[progress] resuming ${mode} ${describeInstance(instanceConfig)} from block ${start} to ${toBlock} after ${totalEvents} events`,
      )
    }
  }

  const totalBatches = start <= toBlock
    ? Math.ceil((toBlock - start + 1) / blockStep)
    : 0
  let completedBatches = 0

  while (start <= toBlock) {
    const end = Math.min(start + blockStep - 1, toBlock)
    let batch
    let attempt = 0
    while (attempt < retries) {
      attempt += 1
      try {
        batch = await contract.getPastEvents('Deposit', { fromBlock: start, toBlock: end })
        break
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        if (attempt >= retries) {
          throw new Error(`RPC failed for blocks ${start}-${end} after ${retries} attempts: ${message}`)
        }
        if (showProgress) {
          console.log(`[progress] attempt ${attempt}/${retries} failed for blocks ${start}-${end}: ${message}`)
        }
        await sleep(retryDelayMs)
      }
    }

    appendEvents(eventsPath, batch)
    totalEvents += batch.length
    completedBatches += 1

    writeJson(progressPath, buildScanProgress({
      mode,
      instanceConfig,
      fromBlock,
      toBlock,
      lastProcessedBlock: end,
      totalEvents,
      eventsPath,
    }))

    if (progressLogger) {
      progressLogger({
        start,
        end,
        batchIndex: completedBatches,
        totalBatches,
        batchEvents: batch.length,
        totalEvents,
      })
    }
    start = end + 1
  }

  return { events: loadEventScan(eventsPath), progressPath, eventsPath }
}

function finalizeScanFiles(progressPath, eventsPath) {
  removeIfExists(progressPath)
  removeIfExists(eventsPath)
}

function findFilesRecursive(rootDir, suffix) {
  const results = []
  const stack = [rootDir]
  const skippedDirs = new Set(['node_modules', 'target', '.git'])
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (skippedDirs.has(entry.name)) {
          continue
        }
        stack.push(fullPath)
        continue
      }
      if (entry.isFile() && fullPath.endsWith(suffix)) {
        results.push(fullPath)
      }
    }
  }
  return results.sort()
}

function formatPercent(numerator, denominator) {
  if (!denominator || denominator <= 0) {
    return '0.0'
  }
  return ((numerator / denominator) * 100).toFixed(1)
}

async function resumeStatusCommand() {
  const progressFiles = findFilesRecursive(ROOT, '.progress.json')
  if (progressFiles.length === 0) {
    console.log('No resumable scans found.')
    return
  }

  for (const progressPath of progressFiles) {
    try {
      const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'))
      const totalBlocks = Math.max(0, Number(progress.toBlock) - Number(progress.fromBlock) + 1)
      const processedBlocks = Math.max(0, Number(progress.lastProcessedBlock) - Number(progress.fromBlock) + 1)
      const percent = formatPercent(processedBlocks, totalBlocks)
      console.log(`${progress.mode || 'scan'} ${progress.chainId}-${progress.currency}-${progress.amount}`)
      console.log(`  instance ${progress.instance}`)
      console.log(`  blocks ${progress.fromBlock}-${progress.toBlock}`)
      console.log(`  last processed ${progress.lastProcessedBlock}`)
      console.log(`  progress ${processedBlocks}/${totalBlocks} blocks (${percent}%)`)
      console.log(`  events ${progress.totalEvents || 0}`)
      console.log(`  file ${progressPath}`)
    } catch (error) {
      console.log(`invalid progress file ${progressPath}: ${error.message || error}`)
    }
  }
}

async function buildTree({ web3, instanceConfig, treePath, blockStep, showProgress, retries, retryDelayMs }) {
  const sherpa = new web3.eth.Contract(sherpaAbi, instanceConfig.address)
  const levels = Number(await sherpa.methods.levels().call())
  const latestBlock = await web3.eth.getBlockNumber()
  if (showProgress) {
    console.log(
      `[progress] scanning ${describeInstance(instanceConfig)} from block ${instanceConfig.deploymentBlock} to ${latestBlock}`,
    )
  }
  const { events, progressPath, eventsPath } = await scanDeposits({
    contract: sherpa,
    instanceConfig,
    treePath,
    fromBlock: Number(instanceConfig.deploymentBlock),
    toBlock: latestBlock,
    blockStep: Number(blockStep),
    retries: Number(retries),
    retryDelayMs: Number(retryDelayMs),
    showProgress,
    mode: 'build',
  })

  const sorted = events
    .map((event) => normalizeDepositEvent(event))
    .sort((left, right) => left.leafIndex - right.leafIndex)

  const leaves = sorted.length === 0 ? [] : new Array(sorted[sorted.length - 1].leafIndex + 1)
  const indexByCommitment = {}

  for (const event of sorted) {
    if (leaves[event.leafIndex] !== undefined) {
      throw new Error(`Duplicate leaf index ${event.leafIndex}`)
    }
    leaves[event.leafIndex] = event.commitment
    indexByCommitment[event.commitment.toLowerCase()] = event.leafIndex
  }

  const missingIndex = leaves.findIndex((leaf) => leaf === undefined)
  if (missingIndex !== -1) {
    throw new Error(`Missing leaf ${missingIndex}; event log scan is incomplete`)
  }

  const tree = new MerkleTree(levels, leaves, 'sherpa')
  const root = await tree.root()
  const rootHex = toHex(root)
  const isKnownRoot = await sherpa.methods.isKnownRoot(rootHex).call()
  if (!isKnownRoot) {
    throw new Error('Computed root is not known by the contract')
  }

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    chainId: instanceConfig.netId,
    currency: instanceConfig.currency,
    amount: instanceConfig.amount,
    instance: instanceConfig.address,
    verifier: instanceConfig.verifier,
    levels,
    fromBlock: Number(instanceConfig.deploymentBlock),
    toBlock: latestBlock,
    totalLeaves: leaves.length,
    root: root.toString(),
    rootHex,
    leaves,
    indexByCommitment,
  }

  writeJson(treePath, output)
  finalizeScanFiles(progressPath, eventsPath)
  return output
}

function getSeedTreePath(instanceConfig) {
  return path.join(ROOTS_DIR, `${instanceConfig.netId}-${instanceConfig.currency}-${instanceConfig.amount}.json`)
}

async function extendTree({ web3, instanceConfig, baseTree, treePath, blockStep, latestBlock, showProgress, retries, retryDelayMs }) {
  if (Number(baseTree.toBlock) >= Number(latestBlock)) {
    if (!fs.existsSync(treePath)) {
      writeJson(treePath, baseTree)
    }
    return baseTree
  }

  const sherpa = new web3.eth.Contract(sherpaAbi, instanceConfig.address)
  if (showProgress) {
    console.log(
      `[progress] extending ${describeInstance(instanceConfig)} from block ${Number(baseTree.toBlock) + 1} to ${latestBlock}`,
    )
  }
  const { events, progressPath, eventsPath } = await scanDeposits({
    contract: sherpa,
    instanceConfig,
    treePath,
    fromBlock: Number(baseTree.toBlock) + 1,
    toBlock: latestBlock,
    blockStep: Number(blockStep),
    retries: Number(retries),
    retryDelayMs: Number(retryDelayMs),
    showProgress,
    mode: 'extend',
  })

  if (events.length === 0) {
    const updated = Object.assign({}, baseTree, {
      generatedAt: new Date().toISOString(),
      toBlock: latestBlock,
    })
    writeJson(treePath, updated)
    finalizeScanFiles(progressPath, eventsPath)
    return updated
  }

  const leaves = baseTree.leaves.slice()
  const indexByCommitment = Object.assign({}, baseTree.indexByCommitment)
  const sorted = events
    .map((event) => normalizeDepositEvent(event))
    .sort((left, right) => left.leafIndex - right.leafIndex)

  for (const event of sorted) {
    if (leaves[event.leafIndex] !== undefined) {
      if (String(leaves[event.leafIndex]).toLowerCase() !== String(event.commitment).toLowerCase()) {
        throw new Error(`Leaf ${event.leafIndex} changed unexpectedly while extending the cached tree`)
      }
      continue
    }
    if (event.leafIndex !== leaves.length) {
      throw new Error(`Expected next leaf index ${leaves.length} but saw ${event.leafIndex}`)
    }
    leaves.push(event.commitment)
    indexByCommitment[event.commitment.toLowerCase()] = event.leafIndex
  }

  const tree = new MerkleTree(Number(baseTree.levels), leaves, 'sherpa')
  const root = await tree.root()
  const rootHex = toHex(root)
  const isKnownRoot = await sherpa.methods.isKnownRoot(rootHex).call()
  if (!isKnownRoot) {
    throw new Error('Extended tree root is not known by the contract')
  }

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    chainId: instanceConfig.netId,
    currency: instanceConfig.currency,
    amount: instanceConfig.amount,
    instance: instanceConfig.address,
    verifier: instanceConfig.verifier,
    levels: Number(baseTree.levels),
    fromBlock: Number(baseTree.fromBlock),
    toBlock: latestBlock,
    totalLeaves: leaves.length,
    root: root.toString(),
    rootHex,
    leaves,
    indexByCommitment,
  }

  writeJson(treePath, output)
  finalizeScanFiles(progressPath, eventsPath)
  return output
}

async function ensureTree({ web3, instanceConfig, treePath, forceTree, blockStep, showProgress, retries, retryDelayMs }) {
  const latestBlock = await web3.eth.getBlockNumber()
  const sherpa = new web3.eth.Contract(sherpaAbi, instanceConfig.address)
  if (!forceTree && fs.existsSync(treePath)) {
    const cached = JSON.parse(fs.readFileSync(treePath, 'utf8'))
    const cachedRootKnown = await sherpa.methods.isKnownRoot(cached.rootHex).call()
    if (cachedRootKnown) {
      console.log(`Using cached known root from block ${cached.toBlock}`)
      return cached
    }
    console.log(`Extending cached tree from block ${Number(cached.toBlock) + 1} to ${latestBlock}`)
    return extendTree({ web3, instanceConfig, baseTree: cached, treePath, blockStep, latestBlock, showProgress, retries, retryDelayMs })
  }

  const seedTreePath = getSeedTreePath(instanceConfig)
  if (!forceTree && seedTreePath && fs.existsSync(seedTreePath)) {
    const seedTree = JSON.parse(fs.readFileSync(seedTreePath, 'utf8'))
    const seedRootKnown = await sherpa.methods.isKnownRoot(seedTree.rootHex).call()
    if (seedRootKnown) {
      console.log(`Using bundled known root from block ${seedTree.toBlock}`)
      writeJson(treePath, seedTree)
      return seedTree
    }
    console.log(`Extending bundled seed tree from block ${Number(seedTree.toBlock) + 1} to ${latestBlock}`)
    return extendTree({ web3, instanceConfig, baseTree: seedTree, treePath, blockStep, latestBlock, showProgress, retries, retryDelayMs })
  }

  console.log(`Building tree from deployment block ${instanceConfig.deploymentBlock} to ${latestBlock}`)
  return buildTree({ web3, instanceConfig, treePath, blockStep, showProgress, retries, retryDelayMs })
}

function describeInstance(instanceConfig) {
  return `${instanceConfig.netId}-${instanceConfig.currency}-${instanceConfig.amount} @ ${instanceConfig.address}`
}

function resolveBuildTargets(options) {
  if (options.note) {
    if (options.all || options.netId || options.currency || options.amount || options.instance) {
      throw new Error('Use either --note or pool filters/--all, not both')
    }
    return [resolveInstance(parseNote(options.note))]
  }
  if (options.all || options.netId || options.currency || options.amount || options.instance) {
    return selectInstances(options)
  }
  throw new Error('build-tree requires either --note or one of --all/--net-id/--currency/--amount/--instance')
}

function addressToBigInt(web3, address) {
  return bigInt(web3.utils.toBN(address).toString(10))
}

function flattenProofToBytes(proofJson) {
  const flat = [
    proofJson.pi_a[0],
    proofJson.pi_a[1],
    proofJson.pi_b[0][1],
    proofJson.pi_b[0][0],
    proofJson.pi_b[1][1],
    proofJson.pi_b[1][0],
    proofJson.pi_c[0],
    proofJson.pi_c[1],
  ]
  return '0x' + flat.map((entry) => bigInt(entry).toString(16).padStart(64, '0')).join('')
}

function runCargoProve({ witnessPath, proofPath, publicPath }) {
  const phase2Dir = path.join(ROOT, 'phase2-bn254', 'phase2')
  const circuitPath = path.join(ROOT, 'artifacts', 'phase2-circuit.json')
  const paramsPath = path.join(ROOT, 'artifacts', 'result.params')
  const result = spawnSync(
    'cargo',
    [
      'run',
      '--release',
      '--quiet',
      '--bin',
      'prove',
      circuitPath,
      witnessPath,
      paramsPath,
      proofPath,
      publicPath,
    ],
    {
      cwd: phase2Dir,
      stdio: 'inherit',
      env: Object.assign({}, process.env, { RUSTFLAGS: '-Awarnings' }),
    },
  )
  if (result.status !== 0) {
    throw new Error(`cargo prove failed with exit code ${result.status}`)
  }
}

function sanitizeName(input) {
  return input.replace(/[^a-zA-Z0-9_.-]+/g, '-')
}

async function broadcastCommand(options) {
  const privateKey = options.privateKey || process.env.SHERPA_PRIVATE_KEY
  if (!privateKey) {
    throw new Error('Provide --private-key or set SHERPA_PRIVATE_KEY')
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('Private key must be a 0x-prefixed 32-byte hex string')
  }

  const withdrawalPath = path.resolve(options.withdrawal)
  if (!fs.existsSync(withdrawalPath)) {
    throw new Error(`withdrawal file not found: ${withdrawalPath}`)
  }

  const withdrawal = JSON.parse(fs.readFileSync(withdrawalPath, 'utf8'))
  if (!withdrawal || !withdrawal.tx || !withdrawal.tx.to || !withdrawal.tx.data) {
    throw new Error('withdrawal.json is missing tx.to or tx.data')
  }

  const web3 = new Web3(options.rpc)
  const account = web3.eth.accounts.privateKeyToAccount(privateKey)
  const sender = account.address
  const value = withdrawal.tx.value || '0'

  const tx = {
    from: sender,
    to: withdrawal.tx.to,
    data: withdrawal.tx.data,
    value,
  }

  const [chainId, nonce, gasPrice, estimatedGas] = await Promise.all([
    web3.eth.getChainId(),
    web3.eth.getTransactionCount(sender, 'pending'),
    options.gasPriceWei || web3.eth.getGasPrice(),
    options.gas || web3.eth.estimateGas(tx),
  ])

  const signed = await account.signTransaction({
    ...tx,
    chainId,
    nonce,
    gasPrice,
    gas: estimatedGas,
  })

  if (!signed.rawTransaction) {
    throw new Error('Failed to sign transaction')
  }

  const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction)
  console.log(`Broadcasted withdrawal transaction: ${receipt.transactionHash}`)
  console.log(`Note: ${withdrawal.note}`)
  console.log(`Contract: ${withdrawal.tx.to}`)
}

async function buildTreeCommand(options) {
  const web3 = new Web3(options.rpc)
  const selectedInstances = resolveBuildTargets(options)
  if (options.out && selectedInstances.length !== 1) {
    throw new Error('--out can only be used when building exactly one tree')
  }

  mkdirp(ROOTS_DIR)
  const failures = []
  for (const instanceConfig of selectedInstances) {
    const treePath = path.resolve(options.out || getSeedTreePath(instanceConfig))
    console.log(`Building ${describeInstance(instanceConfig)}`)
    try {
      mkdirp(path.dirname(treePath))
      const tree = await ensureTree({
        web3,
        instanceConfig,
        treePath,
        forceTree: Boolean(options.forceTree),
        blockStep: Number(options.blockStep),
        showProgress: Boolean(options.progress),
        retries: Number(options.retries),
        retryDelayMs: Number(options.retryDelayMs),
      })
      console.log(`  wrote ${treePath}`)
      console.log(`  leaves ${tree.totalLeaves}`)
      console.log(`  root ${tree.rootHex}`)
    } catch (error) {
      failures.push({ instanceConfig, error })
      console.error(`  failed: ${error.message || error}`)
    }
  }

  if (failures.length > 0) {
    const labels = failures.map(({ instanceConfig }) => describeInstance(instanceConfig)).join(', ')
    throw new Error(`Root sync failed for ${failures.length} instance(s): ${labels}`)
  }
}

async function withdrawCommand(options) {
  const parsedNote = parseNote(options.note)
  const instanceConfig = resolveInstance(parsedNote)
  const web3 = new Web3(options.rpc)
  const sherpa = new web3.eth.Contract(sherpaAbi, instanceConfig.address)

  const treePath = path.resolve(
    options.tree || getSeedTreePath(instanceConfig),
  )
  mkdirp(path.dirname(treePath))
  const treeData = await ensureTree({
    web3,
    instanceConfig,
    treePath,
    forceTree: Boolean(options.forceTree),
    blockStep: Number(options.blockStep),
    showProgress: Boolean(options.progress),
    retries: Number(options.retries),
    retryDelayMs: Number(options.retryDelayMs),
  })

  if (!options.skipSpentCheck) {
    const spent = await sherpa.methods.isSpent(parsedNote.deposit.nullifierHex).call()
    if (spent) {
      throw new Error('The note has already been spent')
    }
  }

  const leafIndex = treeData.indexByCommitment[parsedNote.deposit.commitmentHex.toLowerCase()]
  if (leafIndex === undefined) {
    throw new Error('Commitment not found in the Merkle tree')
  }

  const tree = new MerkleTree(Number(treeData.levels), treeData.leaves, 'sherpa')
  const pathData = await tree.path(leafIndex)
  const rootHex = toHex(pathData.root)
  const isKnownRoot = await sherpa.methods.isKnownRoot(rootHex).call()
  if (!isKnownRoot) {
    throw new Error('Computed root is not known by the contract')
  }

  const relayer = options.relayer || ZERO_ADDRESS
  const fee = bigInt(options.feeWei || '0')
  const refund = bigInt(options.refundWei || '0')
  const recipientBigInt = addressToBigInt(web3, options.recipient)
  const relayerBigInt = addressToBigInt(web3, relayer)

  const input = {
    root: pathData.root,
    nullifierHash: parsedNote.deposit.nullifierHash,
    recipient: recipientBigInt,
    relayer: relayerBigInt,
    fee,
    refund,
    nullifier: parsedNote.deposit.nullifier,
    secret: parsedNote.deposit.secret,
    pathElements: pathData.path_elements,
    pathIndices: pathData.path_index,
  }

  const circuitJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts', 'phase2-circuit.json'), 'utf8'))
  const circuit = new Circuit(circuitJson)
  const witness = circuit.calculateWitness(unstringifyBigInts(input))

  const runName = sanitizeName(`${parsedNote.netId}-${parsedNote.currency}-${parsedNote.amount}-${parsedNote.deposit.commitmentHex.slice(2, 10)}`)
  const outputDir = path.resolve(options.outDir || path.join(ROOT, 'cache', runName))
  mkdirp(outputDir)

  const inputPath = path.join(outputDir, 'phase2-input.json')
  const witnessPath = path.join(outputDir, 'phase2-witness.json')
  const proofPath = path.join(outputDir, 'phase2-proof.json')
  const publicPath = path.join(outputDir, 'phase2-public.json')
  const resultPath = path.join(outputDir, 'withdrawal.json')

  writeJson(inputPath, stringifyBigInts(input))
  writeJson(witnessPath, stringifyBigInts(witness))

  runCargoProve({ witnessPath, proofPath, publicPath })

  const proofJson = JSON.parse(fs.readFileSync(proofPath, 'utf8'))
  const publicSignals = JSON.parse(fs.readFileSync(publicPath, 'utf8'))
  const proofBytes = flattenProofToBytes(proofJson)

  const args = [
    toHex(input.root),
    toHex(input.nullifierHash),
    toHex(input.recipient, 20),
    toHex(input.relayer, 20),
    toHex(input.fee),
    toHex(input.refund),
  ]

  const expectedPublicSignals = [
    args[0],
    args[1],
    toHex(input.recipient),
    toHex(input.relayer),
    args[4],
    args[5],
  ]
  const normalizedPublicSignals = publicSignals.map((signal) => toHex(signal))
  if (JSON.stringify(normalizedPublicSignals) !== JSON.stringify(expectedPublicSignals)) {
    throw new Error('Public signals from the prover do not match the locally derived inputs')
  }

  const verifier = new web3.eth.Contract(verifierAbi, instanceConfig.verifier)
  const onchainVerified = await verifier.methods.verifyProof(proofBytes, args).call()
  if (!onchainVerified) {
    throw new Error('On-chain verifier returned false')
  }

  const calldata = sherpa.methods.withdraw(
    proofBytes,
    args[0],
    args[1],
    options.recipient,
    relayer,
    args[4],
    args[5],
  ).encodeABI()

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    note: parsedNote.note,
    chainId: parsedNote.netId,
    currency: parsedNote.currency,
    amount: parsedNote.amount,
    instance: instanceConfig.address,
    verifier: instanceConfig.verifier,
    treePath,
    proofFiles: {
      input: inputPath,
      witness: witnessPath,
      proof: proofPath,
      public: publicPath,
    },
    commitment: parsedNote.deposit.commitmentHex,
    nullifierHash: parsedNote.deposit.nullifierHex,
    leafIndex: Number(leafIndex),
    rootHex: args[0],
    proof: proofBytes,
    publicSignals: args,
    onchainVerified,
    tx: {
      to: instanceConfig.address,
      data: calldata,
      value: refund.toString(),
    },
  }

  writeJson(resultPath, output)

  console.log(`Withdrawal package written to ${resultPath}`)
  console.log(`Pool: ${output.tx.to}`)
  console.log(`Verifier: ${instanceConfig.verifier}`)
  console.log(`On-chain verification: ${onchainVerified}`)
}

async function main() {
  const program = new Command()
  program.name('canonical-withdraw-kit')

  program
    .command('build-tree')
    .option('--rpc <url>', 'RPC URL', DEFAULT_RPC)
    .option('--block-step <n>', 'Blocks per event batch', String(DEFAULT_BLOCK_STEP))
    .option('--retries <n>', 'Retries per RPC batch on failure', String(DEFAULT_RETRIES))
    .option('--retry-delay-ms <ms>', 'Delay between RPC retries in ms', String(DEFAULT_RETRY_DELAY_MS))
    .option('--force-tree', 'Force a fresh tree rebuild', false)
    .option('--progress', 'Log tree scan progress', false)
    .option('--note <note>', 'Sherpa note string')
    .option('--all', 'Build trees for all configured pools', false)
    .option('--net-id <id>', 'Filter by netId')
    .option('--currency <symbol>', 'Filter by currency')
    .option('--amount <value>', 'Filter by amount')
    .option('--instance <address>', 'Filter by instance address')
    .option('--out <path>', 'Output tree file path')
    .action((options) => {
      buildTreeCommand(options).catch((error) => {
        console.error(error.message || error)
        process.exit(1)
      })
    })

  program
    .command('withdraw')
    .requiredOption('--note <note>', 'Sherpa note string')
    .requiredOption('--recipient <address>', 'Withdrawal recipient')
    .option('--rpc <url>', 'RPC URL', DEFAULT_RPC)
    .option('--relayer <address>', 'Relayer address', ZERO_ADDRESS)
    .option('--fee-wei <amount>', 'Relayer fee in wei', '0')
    .option('--refund-wei <amount>', 'Refund in wei', '0')
    .option('--skip-spent-check', 'Skip the on-chain spent check', false)
    .option('--force-tree', 'Force a fresh tree rebuild', false)
    .option('--block-step <n>', 'Blocks per event batch', String(DEFAULT_BLOCK_STEP))
    .option('--retries <n>', 'Retries per RPC batch on failure', String(DEFAULT_RETRIES))
    .option('--retry-delay-ms <ms>', 'Delay between RPC retries in ms', String(DEFAULT_RETRY_DELAY_MS))
    .option('--progress', 'Log tree scan progress', false)
    .option('--tree <path>', 'Explicit Merkle tree path')
    .option('--out-dir <path>', 'Directory to write witness/proof/output files')
    .action((options) => {
      withdrawCommand(options).catch((error) => {
        console.error(error.message || error)
        process.exit(1)
      })
    })

  program
    .command('resume-status')
    .action(() => {
      resumeStatusCommand().catch((error) => {
        console.error(error.message || error)
        process.exit(1)
      })
    })

  program
    .command('broadcast')
    .requiredOption('--withdrawal <path>', 'Path to withdrawal.json')
    .option('--rpc <url>', 'RPC URL', DEFAULT_RPC)
    .option('--private-key <hex>', 'Sender private key, 0x-prefixed')
    .option('--gas <n>', 'Gas limit override')
    .option('--gas-price-wei <n>', 'Gas price in wei override')
    .action((options) => {
      broadcastCommand(options).catch((error) => {
        console.error(error.message || error)
        process.exit(1)
      })
    })

  await program.parseAsync(process.argv)
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
