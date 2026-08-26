(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PaperEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const today = () => new Date().toISOString().slice(0, 10);
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const currencyOf = item => item && (item.market === "US" || item.currency === "USD") ? "USD" : "KRW";
  const cashKey = currency => currency === "USD" ? "cashUSD" : "cashKRW";
  const initialKey = currency => currency === "USD" ? "initialUSD" : "initialKRW";
  const roundQty = value => Math.max(0, Math.floor(number(value)));

  function createAccount(krw, usd) {
    return {
      version: 1,
      initialKRW: Math.max(0, number(krw)), initialUSD: Math.max(0, number(usd)),
      cashKRW: Math.max(0, number(krw)), cashUSD: Math.max(0, number(usd)),
      watchlist: [], positions: [], trades: [], updatedAt: new Date().toISOString()
    };
  }

  function normalizeAccount(raw, krw, usd) {
    const base = createAccount(krw, usd), source = raw && typeof raw === "object" ? raw : {};
    return Object.assign(base, source, {
      watchlist: Array.isArray(source.watchlist) ? source.watchlist : [],
      positions: Array.isArray(source.positions) ? source.positions : [],
      trades: Array.isArray(source.trades) ? source.trades : []
    });
  }

  function changeCapital(account, krw, usd) {
    const nextKRW = Math.max(0, number(krw)), nextUSD = Math.max(0, number(usd));
    account.cashKRW = Math.max(0, number(account.cashKRW) + nextKRW - number(account.initialKRW));
    account.cashUSD = Math.max(0, number(account.cashUSD) + nextUSD - number(account.initialUSD));
    account.initialKRW = nextKRW; account.initialUSD = nextUSD;
    account.updatedAt = new Date().toISOString();
    return account;
  }

  function register(account, item, strategy) {
    const ticker = String(item.ticker || "").toUpperCase();
    if (!ticker) throw new Error("티커가 없습니다.");
    if (account.watchlist.some(row => row.ticker === ticker) || account.positions.some(row => row.ticker === ticker)) return false;
    const chosenStrategy = strategy || "TURTLE", domestic = item.domesticTrend || {};
    const signalNow = chosenStrategy === "PULLBACK_KR" ? !!domestic.buyReady : !!item.perfect;
    account.watchlist.push({
      ticker, code: item.code || ticker, name: item.name || ticker, market: item.market || "KR",
      currency: currencyOf(item), strategy: chosenStrategy, state: signalNow ? "PENDING" : "WAITING",
      registeredDate: item.date || today(), signalDate: signalNow ? item.date : "", lastDate: item.date || "", snapshot: snapshot(item)
    });
    account.updatedAt = new Date().toISOString();
    return true;
  }

  function unregister(account, ticker) {
    const before = account.watchlist.length;
    account.watchlist = account.watchlist.filter(row => row.ticker !== ticker);
    account.updatedAt = new Date().toISOString();
    return before !== account.watchlist.length;
  }

  function snapshot(item) {
    const d = item.domesticTrend || {};
    return { price:number(item.price), open:number(item.open), high:number(item.high), low:number(item.low), n:number(item.n), entry1:number(item.entry1), exit1:number(item.exit1), ma5:number(d.ma5), ma10:number(d.ma10), breakoutLevel:number(d.breakoutLevel), phase:item.phase || d.status || "" };
  }

  function unitQuantity(account, item, riskPct) {
    const currency = currencyOf(item), capital = number(account[initialKey(currency)]), n = number(item.n), price = number(item.price);
    if (!capital || !n || !price) return 0;
    const riskQty = Math.floor(capital * Math.max(.001, number(riskPct) || 1) / 100 / n);
    return Math.max(0, Math.min(riskQty, Math.floor(number(account[cashKey(currency)]) / price)));
  }

  function fillPrice(item, trigger) {
    const open = number(item.open) || number(item.price), level = number(trigger);
    return level > 0 ? Math.max(open, level) : open;
  }

  function addTrade(account, position, side, qty, price, reason, date) {
    const amount = qty * price, currency = position.currency, key = cashKey(currency);
    account[key] += side === "BUY" ? -amount : amount;
    account.trades.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`, date:date || today(), ticker:position.ticker, name:position.name, strategy:position.strategy, side, qty, price, amount, currency, reason });
    account.trades = account.trades.slice(0, 500);
  }

  function enter(account, watch, item, settings) {
    const qty = unitQuantity(account, item, settings.riskPct);
    if (!qty) { watch.state = "NO_CASH"; return false; }
    const price = fillPrice(item, 0), d = item.domesticTrend || {};
    const position = {
      ticker:watch.ticker, code:watch.code, name:item.name || watch.name, market:item.market || watch.market,
      currency:watch.currency, strategy:watch.strategy, qty, unitQty:qty, stage:1, avgPrice:price,
      entryPrice:price, entryDate:item.date, n:number(item.n), nextEntry:number(item.entry1) + .5 * number(item.n),
      stop:watch.strategy === "PULLBACK_KR" ? Math.max(number(d.breakoutLevel), number(item.low)) : price - 2 * number(item.n),
      breakoutLevel:number(d.breakoutLevel), partialTaken:false, lastDate:item.date, lastPrice:number(item.price)
    };
    addTrade(account, position, "BUY", qty, price, watch.strategy === "PULLBACK_KR" ? "눌림 매수 신호 다음 시가" : "터틀 돌파 신호 다음 시가", item.date);
    account.positions.push(position);
    return true;
  }

  function exitPosition(account, position, qty, price, reason, date) {
    const sellQty = Math.min(position.qty, Math.max(0, roundQty(qty)));
    if (!sellQty) return;
    addTrade(account, position, "SELL", sellQty, price, reason, date);
    position.qty -= sellQty; position.lastPrice = price; position.lastDate = date;
  }

  function updateTurtle(account, position, item) {
    const open = number(item.open) || number(item.price), low = number(item.low) || number(item.price), high = number(item.high) || number(item.price);
    const exitLine = number(item.exit1), stop = number(position.stop);
    if (stop && low <= stop) {
      exitPosition(account, position, position.qty, open < stop ? open : stop, "-2N 통합 손절", item.date); return;
    }
    if (exitLine && low <= exitLine) {
      exitPosition(account, position, position.qty, open < exitLine ? open : exitLine, "10일 최저가 청산", item.date); return;
    }
    while (position.stage < 4 && high >= position.nextEntry) {
      const price = fillPrice(item, position.nextEntry), affordable = Math.floor(number(account[cashKey(position.currency)]) / price);
      const qty = Math.min(position.unitQty, affordable);
      if (!qty) break;
      const oldAmount = position.avgPrice * position.qty;
      addTrade(account, position, "BUY", qty, price, `${position.stage + 1}차 +0.5N 추가매수`, item.date);
      position.qty += qty; position.stage += 1; position.avgPrice = (oldAmount + price * qty) / position.qty;
      position.stop = price - 2 * position.n; position.nextEntry += .5 * position.n;
    }
    position.lastPrice = number(item.price); position.lastDate = item.date;
  }

  function updatePullback(account, position, item) {
    const d = item.domesticTrend || {}, open = number(item.open) || number(item.price), low = number(item.low) || number(item.price), close = number(item.price);
    if (position.stop && low <= position.stop) {
      exitPosition(account, position, position.qty, open < position.stop ? open : position.stop, "돌파선/매수봉 저가 손절", item.date); return;
    }
    if (number(d.ma10) && close < number(d.ma10)) {
      exitPosition(account, position, position.qty, close, "10일선 이탈 전량 청산", item.date); return;
    }
    if (!position.partialTaken && close > position.avgPrice && number(d.ma5) && close < number(d.ma5)) {
      const qty = Math.max(1, Math.floor(position.qty / 2));
      exitPosition(account, position, qty, close, "5일선 이탈 50% 익절", item.date);
      position.partialTaken = true;
    }
    position.lastPrice = close; position.lastDate = item.date;
  }

  function update(account, items, settings) {
    const map = Object.fromEntries((items || []).filter(item => item && !item.error).map(item => [String(item.ticker).toUpperCase(), item]));
    const entered = [];
    account.watchlist.forEach(watch => {
      const item = map[watch.ticker]; if (!item || !item.date || item.date <= (watch.lastDate || "")) return;
      const d = item.domesticTrend || {};
      if (watch.state === "PENDING") {
        if (item.date > watch.signalDate && enter(account, watch, item, settings)) entered.push(watch.ticker);
      } else {
        const signal = watch.strategy === "PULLBACK_KR" ? d.buyReady : item.perfect;
        if (signal) { watch.state = "PENDING"; watch.signalDate = item.date; }
      }
      watch.lastDate = item.date; watch.snapshot = snapshot(item);
    });
    if (entered.length) account.watchlist = account.watchlist.filter(row => !entered.includes(row.ticker));
    account.positions.slice().forEach(position => {
      const item = map[position.ticker];
      if (!item || !item.date || item.date <= (position.lastDate || "")) return;
      if (position.strategy === "PULLBACK_KR") updatePullback(account, position, item);
      else updateTurtle(account, position, item);
    });
    account.positions = account.positions.filter(position => position.qty > 0);
    account.updatedAt = new Date().toISOString();
    return account;
  }

  function manualExit(account, ticker, price, date) {
    const position = account.positions.find(row => row.ticker === ticker);
    if (!position) return false;
    exitPosition(account, position, position.qty, number(price) || position.lastPrice || position.avgPrice, "사용자 수동 청산", date || today());
    account.positions = account.positions.filter(row => row.qty > 0);
    return true;
  }

  function valuation(account) {
    const result = { KRW:{initial:number(account.initialKRW),cash:number(account.cashKRW),market:0,total:0,pnl:0}, USD:{initial:number(account.initialUSD),cash:number(account.cashUSD),market:0,total:0,pnl:0} };
    account.positions.forEach(position => { result[position.currency].market += position.qty * number(position.lastPrice || position.avgPrice); });
    Object.values(result).forEach(row => { row.total=row.cash+row.market; row.pnl=row.total-row.initial; });
    return result;
  }

  return { createAccount, normalizeAccount, changeCapital, register, unregister, update, manualExit, valuation, unitQuantity, snapshot };
});
