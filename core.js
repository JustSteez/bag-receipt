// Bag Receipt core: reads one wallet's history for one token straight from Robinhood Chain RPC.
export const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'; // Uniswap v4 singleton
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const LOG_RANGE = 10_000_000; // max blocks per eth_getLogs on the public RPC
const MAX_TXS = 150;
const BATCH_SIZE = 10;
const BATCH_CONCURRENCY = 2;
const USDG_DECIMALS = 6;

export const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s).trim());
const pad32 = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const topicAddr = (t) => '0x' + t.slice(26).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUSY = 'The Robinhood Chain RPC is busy. Wait a few seconds and try again.';

/** POST a JSON-RPC payload, backing off when the public RPC rate-limits (429 / Cloudflare page). */
async function post(payload) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      const isJson = text.startsWith('{') || text.startsWith('[');
      if (isJson && res.status !== 429 && res.status < 500) return JSON.parse(text);
    } catch {
      // network blip: fall through to backoff
    }
    await sleep(1000 * 2 ** attempt);
  }
  throw new Error(BUSY);
}

let rpcId = 0;
export async function rpc(method, params) {
  const json = await post({ jsonrpc: '2.0', id: ++rpcId, method, params });
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

/** Run many calls as JSON-RPC batches, a few batches at a time, keeping request count low. */
export async function rpcMany(calls, onProgress = () => {}, { settle = false } = {}) {
  const batches = [];
  for (let i = 0; i < calls.length; i += BATCH_SIZE) batches.push(calls.slice(i, i + BATCH_SIZE));
  let done = 0;
  const results = await pool(batches, BATCH_CONCURRENCY, async (batch) => {
    const payload = batch.map(([method, params]) => ({ jsonrpc: '2.0', id: ++rpcId, method, params }));
    const json = await post(payload);
    const byId = new Map((Array.isArray(json) ? json : [json]).map((r) => [r.id, r]));
    const out = payload.map((p) => {
      const r = byId.get(p.id);
      if (!r) throw new Error(BUSY);
      if (r.error) {
        const err = new Error(`${p.method}: ${r.error.message}`);
        if (settle) return err;
        throw err;
      }
      return r.result;
    });
    done += batch.length;
    onProgress(done / calls.length);
    return out;
  });
  return results.flat();
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const hexToText = (h) => {
  const bytes = new Uint8Array((h.match(/.{2}/g) || []).map((b) => parseInt(b, 16)));
  return new TextDecoder().decode(bytes).replace(/\0/g, '').trim();
};

export function decodeString(hex) {
  if (!hex || hex === '0x') return '';
  const h = hex.slice(2);
  if (h.length === 64) return hexToText(h); // bytes32-style name/symbol
  const len = parseInt(h.slice(64, 128), 16);
  return hexToText(h.slice(128, 128 + len * 2));
}

export async function tokenMeta(token) {
  const call = (data) => rpc('eth_call', [{ to: token, data }, 'latest']).catch(() => '0x');
  const [name, symbol, decimals] = await Promise.all([call('0x06fdde03'), call('0x95d89b41'), call('0x313ce567')]);
  if (!decimals || decimals === '0x') throw new Error('That address is not an ERC-20 token on Robinhood Chain.');
  return { name: decodeString(name) || 'Unknown token', symbol: decodeString(symbol) || '???', decimals: parseInt(decimals, 16) };
}

export async function balanceOf(token, wallet) {
  const r = await rpc('eth_call', [{ to: token, data: '0x70a08231' + pad32(wallet).slice(2) }, 'latest']);
  return BigInt(r);
}

/** Every Transfer of `token` into or out of `wallet`, scanning the whole chain in 10M-block windows. */
export async function walletTransfers(token, wallet, onProgress = () => {}) {
  const latest = parseInt(await rpc('eth_blockNumber', []), 16);
  const w = pad32(wallet);
  const filter = (from, to, topics) => ({ address: token, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics });
  const windows = [];
  for (let from = 0; from <= latest; from += LOG_RANGE) {
    const to = Math.min(from + LOG_RANGE - 1, latest);
    windows.push([from, to, [TRANSFER, null, w]], [from, to, [TRANSFER, w]]);
  }
  const first = await rpcMany(windows.map(([f, t, tp]) => ['eth_getLogs', [filter(f, t, tp)]]), onProgress, { settle: true });

  // Busy wallets can exceed the RPC's 10k-logs-per-query cap: halve the window until it fits.
  const fetchSplit = async (from, to, topics, depth = 0) => {
    try {
      return await rpc('eth_getLogs', [filter(from, to, topics)]);
    } catch (err) {
      if (!/exceed|too many|more than 10000/i.test(err.message) || depth > 12 || to <= from) throw err;
      const mid = Math.floor((from + to) / 2);
      return [...await fetchSplit(from, mid, topics, depth + 1), ...await fetchSplit(mid + 1, to, topics, depth + 1)];
    }
  };
  const results = [];
  for (let i = 0; i < first.length; i++) {
    if (!(first[i] instanceof Error)) { results.push(first[i]); continue; }
    if (!/exceed|too many|more than 10000/i.test(first[i].message)) throw first[i];
    const [f, t, tp] = windows[i];
    const mid = Math.floor((f + t) / 2);
    results.push(await fetchSplit(f, mid, tp), await fetchSplit(mid + 1, t, tp));
  }
  const seen = new Set();
  return results.flat()
    .filter((l) => {
      const k = l.transactionHash + l.logIndex;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16));
}

/**
 * Turn one transaction into a receipt line, or null if the wallet's balance didn't change.
 * Price comes from the pool side of the same tx: WETH/USDG into a pool = what a buy cost,
 * WETH/USDG out of a pool = what a sell paid.
 */
const int256 = (word) => { const v = BigInt('0x' + word); return v >= 2n ** 255n ? v - 2n ** 256n : v; };

/** Native-ETH leg of Uniswap v4 swaps in this tx (ETH is always currency0). Positive = paid to the swapper. */
function v4EthDelta(logs, ethPoolIds) {
  return logs
    .filter((l) => l.address.toLowerCase() === POOL_MANAGER && l.topics[0] === V4_SWAP && ethPoolIds.has(l.topics[1].toLowerCase()))
    .reduce((sum, l) => sum + int256(l.data.slice(2, 66)), 0n);
}

export function classifyTx({ logs, tx, token, wallet, pools, ethPoolIds = new Set() }) {
  const tk = token.toLowerCase();
  const me = wallet.toLowerCase();
  const transfers = logs
    .filter((l) => l.topics[0] === TRANSFER && l.topics.length === 3)
    .map((l) => ({
      token: l.address.toLowerCase(),
      from: topicAddr(l.topics[1]),
      to: topicAddr(l.topics[2]),
      amount: BigInt(l.data === '0x' ? 0 : l.data),
    }));

  let delta = 0n;
  for (const t of transfers) {
    if (t.token !== tk) continue;
    if (t.to === me) delta += t.amount;
    if (t.from === me) delta -= t.amount;
  }
  if (delta === 0n) return null;

  const side = delta > 0n ? 'BUY' : 'SELL';
  // Tokens DexScreener doesn't list yet: treat whoever traded the token with this wallet as the pool.
  const counterparties = transfers
    .filter((t) => t.token === tk && (t.to === me || t.from === me))
    .map((t) => (t.to === me ? t.from : t.to));
  const known = transfers.some((t) => t.token === tk && (pools.has(t.from) || pools.has(t.to)));
  if (!known) pools = new Set([...pools, ...counterparties.filter((a) => !/^0x0{40}$/.test(a))]);
  const tokenHitsPool = transfers.some((t) => t.token === tk && (pools.has(t.from) || pools.has(t.to)));
  const quoteFlow = (quote) => transfers
    .filter((t) => t.token === quote)
    .filter((t) => (side === 'BUY' ? pools.has(t.to) && !pools.has(t.from) : pools.has(t.from) && !pools.has(t.to)))
    .reduce((sum, t) => sum + t.amount, 0n);

  const v4 = v4EthDelta(logs, ethPoolIds);
  const v4Eth = side === 'BUY' ? (v4 < 0n ? -v4 : 0n) : v4 > 0n ? v4 : 0n;
  let eth = (tokenHitsPool ? quoteFlow(WETH) : 0n) + v4Eth;
  const usdg = tokenHitsPool ? quoteFlow(USDG) : 0n;
  const sentByMe = tx.from.toLowerCase() === me;
  // A buy that sends ETH with the tx: the tx value is what the wallet paid (fees included).
  if (side === 'BUY' && usdg === 0n && sentByMe && BigInt(tx.value) > 0n) eth = BigInt(tx.value);

  const priced = eth > 0n || usdg > 0n;
  return {
    hash: tx.hash,
    block: parseInt(tx.blockNumber, 16),
    side: priced ? side : delta > 0n ? 'IN' : 'OUT',
    amount: delta < 0n ? -delta : delta,
    eth,
    usdg,
  };
}

const toNum = (v, decimals) => Number(v) / 10 ** decimals;

export function totals(lines, balance, decimals, market) {
  const sum = (side, key) => lines.filter((l) => l.side === side).reduce((a, l) => a + l[key], 0n);
  const ethUsd = market.ethUsd || 0;
  const spentEth = toNum(sum('BUY', 'eth'), 18);
  const gotEth = toNum(sum('SELL', 'eth'), 18);
  const spentUsd = spentEth * ethUsd + toNum(sum('BUY', 'usdg'), USDG_DECIMALS);
  const gotUsd = gotEth * ethUsd + toNum(sum('SELL', 'usdg'), USDG_DECIMALS);
  const holdingUsd = toNum(balance, decimals) * (market.priceUsd || 0);
  const pnlUsd = gotUsd + holdingUsd - spentUsd;
  return {
    buys: lines.filter((l) => l.side === 'BUY').length,
    sells: lines.filter((l) => l.side === 'SELL').length,
    spentEth, gotEth, spentUsd, gotUsd, holdingUsd, pnlUsd,
    roi: spentUsd > 0 ? pnlUsd / spentUsd : null,
    priced: ethUsd > 0,
    bagPriced: (market.priceUsd || 0) > 0,
  };
}

async function dexPairs(token) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
  if (!res.ok) return [];
  const json = await res.json();
  return (json.pairs || []).filter((p) => p.chainId === 'robinhood');
}

/** ETH price in USD from the deepest WETH pair on Robinhood Chain. */
export async function ethUsdPrice() {
  try {
    const pairs = await dexPairs(WETH);
    const best = pairs
      .filter((p) => p.baseToken.address.toLowerCase() === WETH && Number(p.priceUsd) > 0)
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return best ? Number(best.priceUsd) : 0;
  } catch {
    return 0;
  }
}

/** Live price and known pool addresses for the token, from DexScreener. */
export async function dexMarket(token) {
  const empty = { pools: new Set([POOL_MANAGER]), ethPoolIds: new Set(), priceUsd: 0, ethUsd: 0, pair: null };
  try {
    const pairs = await dexPairs(token);
    if (!pairs.length) return empty;
    const best = [...pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const NATIVE = '0x0000000000000000000000000000000000000000';
    const isEth = (a) => [WETH, NATIVE].includes(a.toLowerCase());
    const ethPair = pairs.find((p) => isEth(p.quoteToken.address) && Number(p.priceNative) > 0 && Number(p.priceUsd) > 0);
    const ethUsd = ethPair ? Number(ethPair.priceUsd) / Number(ethPair.priceNative) : 0;
    const ids = pairs.map((p) => p.pairAddress.toLowerCase());
    return {
      pools: new Set([POOL_MANAGER, ...ids.filter((a) => a.length === 42)]),
      ethPoolIds: new Set(pairs.filter((p) => p.quoteToken.address === NATIVE).map((p) => p.pairAddress.toLowerCase())),
      priceUsd: Number(best.priceUsd) || 0,
      ethUsd,
      pair: best,
    };
  } catch {
    return empty;
  }
}

export async function buildReceipt(tokenIn, walletIn, onStatus = () => {}) {
  const token = tokenIn.trim().toLowerCase();
  const wallet = walletIn.trim().toLowerCase();
  if (!isAddress(token)) throw new Error('Token address looks wrong. It should start with 0x and be 42 characters.');
  if (!isAddress(wallet)) throw new Error('Wallet address looks wrong. It should start with 0x and be 42 characters.');

  onStatus('Reading token…', 0.02);
  const [meta, found, ethUsd] = await Promise.all([tokenMeta(token), dexMarket(token), ethUsdPrice()]);
  const market = { ...found, ethUsd: ethUsd || found.ethUsd, listed: Boolean(found.pair) };

  const scanMsg = 'Scanning Robinhood Chain for your transfers…';
  onStatus(scanMsg, 0.05);
  const logs = await walletTransfers(token, wallet, (p) => onStatus(scanMsg, 0.05 + p * 0.55));
  if (!logs.length) throw new Error(`This wallet has never touched $${meta.symbol}.`);

  const hashes = [...new Set(logs.map((l) => l.transactionHash))];
  const truncated = hashes.length > MAX_TXS;
  const use = truncated ? hashes.slice(-MAX_TXS) : hashes;
  const txCalls = use.flatMap((h) => [['eth_getTransactionReceipt', [h]], ['eth_getTransactionByHash', [h]]]);
  const txData = await rpcMany(txCalls, (p) => onStatus(`Pricing ${use.length} trades…`, 0.6 + p * 0.3));
  const lines = use
    .map((_, i) => classifyTx({ logs: txData[i * 2].logs, tx: txData[i * 2 + 1], token, wallet, pools: market.pools, ethPoolIds: market.ethPoolIds }))
    .filter(Boolean);

  onStatus('Stamping dates…', 0.92);
  const blocks = [...new Set(lines.map((l) => l.block))];
  const blockData = await rpcMany(blocks.map((b) => ['eth_getBlockByNumber', ['0x' + b.toString(16), false]]));
  const stamps = new Map(blocks.map((b, i) => [b, parseInt(blockData[i].timestamp, 16)]));
  const dated = lines.map((l) => ({ ...l, time: stamps.get(l.block) }));
  const balance = await balanceOf(token, wallet);

  onStatus('Printing…', 1);
  return {
    token, wallet, meta, market, balance, truncated,
    lines: dated,
    totals: totals(dated, balance, meta.decimals, market),
  };
}
