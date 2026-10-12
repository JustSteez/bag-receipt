import { buildReceipt, isAddress } from './core.js';

const MAX_LINES = 16;
const $ = (id) => document.getElementById(id);
const form = $('form');
const ui = {
  token: $('token'), wallet: $('wallet'), print: $('print'), error: $('error'),
  printer: $('printer'), status: $('status'), progress: $('progress'),
  out: $('out'), receipt: $('receipt'),
};
let current = null;

/** Tiny DOM builder. Text always goes through textContent, so token names can't inject HTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const compact = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  if (abs >= 1) return n.toFixed(2);
  return small(n);
};
const small = (n) => n.toLocaleString('en-US', { maximumSignificantDigits: 3, maximumFractionDigits: 12 });
const eth = (n) => (n === 0 ? '0' : Math.abs(n) >= 1 ? n.toFixed(3) : small(n));
const usd = (n) => {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const body = abs >= 1e6 ? (abs / 1e6).toFixed(2) + 'M' : abs >= 1e3 ? abs.toLocaleString('en-US', { maximumFractionDigits: 0 }) : abs.toFixed(2);
  return `${sign}$${body}`;
};
const signedUsd = (n) => (n > 0 ? '+' : '') + usd(n);
const when = (t) => new Date(t * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const today = () => new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function verdict(t, balanceNum, truncated) {
  if (truncated) return { label: 'WHALE MODE', tone: 'flat' };
  if (!t.priced) return { label: 'PRINTED', tone: 'flat' };
  if (t.buys === 0 && balanceNum > 0) return { label: 'FREE BAG', tone: 'flat' };
  if (t.roi == null) return { label: 'NO TRADES', tone: 'flat' };
  if (t.roi >= 1) return { label: 'MOONED', tone: 'gain' };
  if (t.roi >= 0.05) return { label: 'IN PROFIT', tone: 'gain' };
  if (t.roi > -0.05) return { label: 'BREAK EVEN', tone: 'flat' };
  if (t.roi <= -0.9) return { label: 'REKT', tone: 'loss' };
  return { label: 'BAG HELD', tone: 'loss' };
}

/** A barcode whose bars are the bits of a tx hash, so every receipt's code is its own. */
function barcode(hex) {
  const bits = BigInt(hex).toString(2).padStart(256, '0').slice(0, 120);
  const bars = [];
  for (let i = 0; i < bits.length; i += 2) {
    const w = 1 + Number(bits[i]) + Number(bits[i + 1]);
    bars.push(el('i', { style: `width:${w}px;margin-right:${bits[i] === '1' ? 2 : 1}px` }));
  }
  return el('div', { class: 'barcode', 'aria-hidden': 'true' }, bars);
}

const row = (k, v, cls = '') => el('div', { class: `r-row ${cls}` }, el('span', { class: 'r-k' }, k), el('span', {}, v));

function renderReceipt(r) {
  const { meta, totals: t, lines } = r;
  const balanceNum = Number(r.balance) / 10 ** meta.decimals;
  const v = verdict(t, balanceNum, r.truncated);
  const shown = lines.slice(-MAX_LINES);
  const hidden = lines.length - shown.length;
  const qty = (l) => compact(Number(l.amount) / 10 ** meta.decimals);
  const cost = (l) => {
    if (l.usdg > 0n) return `${compact(Number(l.usdg) / 1e6)} USDG`;
    if (l.eth > 0n) return `${eth(Number(l.eth) / 1e18)} Ξ`;
    return l.side === 'IN' ? 'received' : 'sent';
  };

  const items = el('table', { class: 'r-items' },
    el('thead', {}, el('tr', {}, el('th', {}, 'DATE'), el('th', {}, ''), el('th', {}, 'QTY'), el('th', {}, 'PAID/GOT'))),
    el('tbody', {},
      hidden > 0 ? el('tr', {}, el('td', { class: 'r-more', colspan: '4' }, `… ${hidden} earlier line${hidden === 1 ? '' : 's'}`)) : null,
      shown.map((l) => el('tr', {},
        el('td', {}, when(l.time)),
        el('td', { class: `side ${l.side}` }, l.side),
        el('td', {}, qty(l)),
        el('td', {}, cost(l)),
      )),
    ),
  );

  const pnlClass = t.pnlUsd > 0.005 ? 'gain' : t.pnlUsd < -0.005 ? 'loss' : '';
  const ethPnl = t.gotEth - t.spentEth;

  const parts = [
    el('div', { class: 'r-center' },
      el('p', { class: 'r-store' }, 'BAG RECEIPT'),
      el('p', { class: 'r-sub' }, 'Robinhood Chain · chain 4663'),
      el('p', { class: 'r-sub' }, today()),
    ),
    el('hr', { class: 'r-rule' }),
    el('div', { class: 'r-token' }, `$${meta.symbol}`),
    row('Token', meta.name.length > 22 ? meta.name.slice(0, 21) + '…' : meta.name),
    row('CA', short(r.token)),
    row('Customer', short(r.wallet)),
    el('hr', { class: 'r-rule' }),
    items,
    el('hr', { class: 'r-rule' }),
    row(`Buys ×${t.buys}`, `${eth(t.spentEth)} Ξ · ${usd(t.spentUsd)}`),
    row(`Sells ×${t.sells}`, `${eth(t.gotEth)} Ξ · ${usd(t.gotUsd)}`),
    row('Still holding', balanceNum > 0 && !t.bagPriced ? `${compact(balanceNum)} · value n/a` : `${compact(balanceNum)} · ${usd(t.holdingUsd)}`),
    row('Net ETH flow', `${ethPnl >= 0 ? '+' : ''}${eth(ethPnl)} Ξ`),
    el('hr', { class: 'r-rule' }),
    el('div', { class: `stamp ${v.tone}` }, v.label),
    el('div', { class: 'r-row r-total' }, el('span', {}, 'TOTAL P&L'), el('span', {}, t.roi == null ? '—' : `${(t.roi * 100).toFixed(1)}%`)),
    el('p', { class: `r-big ${pnlClass}` }, t.priced ? signedUsd(t.pnlUsd) : 'price n/a'),
    el('p', { class: 'r-note' }, t.priced
      ? 'P&L = sells + bag value now − buys, at today’s ETH price.'
      : 'Could not load the ETH price, so USD values are missing.'),
    balanceNum > 0 && !t.bagPriced
      ? el('p', { class: 'r-note' }, 'No DEX market for this token yet, so the bag you still hold counts as $0.')
      : null,
    r.truncated ? el('p', { class: 'r-note' }, 'Very active wallet: only the latest 150 transactions are priced, so older buys are missing and P&L reads high.') : null,
    barcode(lines.at(-1)?.hash || r.token),
    el('div', { class: 'r-center' },
      el('p', { class: 'r-hash' }, short(lines.at(-1)?.hash || r.token)),
      el('p', { class: 'r-thanks' }, 'THANK YOU FOR YOUR LIQUIDITY'),
      el('p', { class: 'r-sub' }, 'bagreceipt.xyz · no refunds'),
    ),
  ];
  ui.receipt.replaceChildren(...parts.filter(Boolean));
}

function setError(msg) {
  ui.error.textContent = msg;
  ui.error.hidden = !msg;
}

function setBusy(busy) {
  ui.print.disabled = busy;
  ui.print.textContent = busy ? 'Printing…' : 'Print receipt';
  ui.printer.hidden = !busy;
}

function shareUrl(r) {
  const u = new URL(location.href);
  u.search = '';
  u.searchParams.set('t', r.token);
  u.searchParams.set('w', r.wallet);
  return u.toString();
}

async function run(token, wallet) {
  setError('');
  if (!isAddress(token)) return setError('Token address looks wrong. It should start with 0x and be 42 characters.');
  if (!isAddress(wallet)) return setError('Wallet address looks wrong. It should start with 0x and be 42 characters.');
  setBusy(true);
  ui.out.hidden = true;
  try {
    current = await buildReceipt(token, wallet, (msg, p) => {
      ui.status.textContent = msg;
      ui.progress.style.width = `${Math.round(p * 100)}%`;
    });
    renderReceipt(current);
    ui.out.hidden = false;
    history.replaceState(null, '', shareUrl(current));
    ui.out.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  } catch (err) {
    setError(err?.message || 'Something went wrong reading the chain. Try again.');
  } finally {
    setBusy(false);
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  run(ui.token.value.trim(), ui.wallet.value.trim());
});

$('download').addEventListener('click', async () => {
  if (!current) return;
  if (!window.htmlToImage) return setError('Image export did not load. Take a screenshot instead.');
  const btn = $('download');
  btn.disabled = true;
  try {
    await window.htmlToImage.toPng(ui.receipt, { pixelRatio: 1 }); // warm-up: Safari drops fonts on the first pass
    const url = await window.htmlToImage.toPng(ui.receipt, { pixelRatio: 2, cacheBust: true });
    const a = el('a', { href: url, download: `bag-receipt-${current.meta.symbol.replace(/[^\w-]/g, '') || 'token'}.png` });
    document.body.append(a);
    a.click();
    a.remove();
  } catch {
    setError('Could not render the image. Take a screenshot instead.');
  } finally {
    btn.disabled = false;
  }
});

$('share').addEventListener('click', () => {
  if (!current) return;
  const t = current.totals;
  const result = t.priced && t.roi != null ? `${signedUsd(t.pnlUsd)} (${(t.roi * 100).toFixed(1)}%)` : 'printed';
  const text = `My $${current.meta.symbol} bag receipt on Robinhood Chain: ${result} 🧾\n\nPrint yours:`;
  const intent = new URL('https://x.com/intent/post');
  intent.searchParams.set('text', text);
  intent.searchParams.set('url', shareUrl(current));
  window.open(intent.toString(), '_blank', 'noopener');
});

$('copy').addEventListener('click', async () => {
  if (!current) return;
  const btn = $('copy');
  try {
    await navigator.clipboard.writeText(shareUrl(current));
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = 'Copy link'; }, 1500);
});

const params = new URLSearchParams(location.search);
const pre = { t: params.get('t'), w: params.get('w') };
if (pre.t) ui.token.value = pre.t;
if (pre.w) ui.wallet.value = pre.w;
if (pre.t && pre.w) run(pre.t, pre.w);
