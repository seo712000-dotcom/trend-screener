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
      version: 2,
      initialKRW: Math.max(0, number(krw)), initialUSD: Math.max(0, number(usd)),
      cashKRW: Math.max(0, number(krw)), cashUSD: Math.max(0, number(usd)),
      watchlist: [], positions: [], trades: [], updatedAt: new Date().toISOString()
    };
  }

  function normalizeAccount(raw, krw, usd) {
    const base = createAccount(krw, usd), source = raw && typeof raw === "object" ? raw : {};
    return Object.assign(base, source, {
      watchlist: (Array.isArray(source.watchlist) ? source.watchlist : []).map(row => Object.assign({}, row, { autoTrade:row.autoTrade === true })),
      positions: (Array.isArray(source.positions) ? source.positions : []).map(row => Object.assign({}, row, { autoTrade:row.autoTrade === true })),
      trades: normalizeTrades(source.trades)
    });
  }

  function normalizeTrades(trades) {
    const rows = (Array.isArray(trades) ? trades : []).map(row => Object.assign({}, row));
    const lots = {};
    rows.slice().reverse().forEach(trade => {
      const key = `${trade.currency || "KRW"}:${String(trade.ticker || "").toUpperCase()}`;
      const lot = lots[key] || (lots[key] = { qty: 0, cost: 0 });
      const qty = roundQty(trade.qty), price = number(trade.price);
      if (trade.side === "BUY") {
        lot.qty += qty; lot.cost += qty * price;
        if (trade.realizedPnl === undefined) trade.realizedPnl = null;
        return;
      }
      if (trade.side !== "SELL") return;
      const storedAvg = number(trade.avgPrice), hasBasis = lot.qty > 0 || storedAvg > 0;
      const avgPrice = lot.qty > 0 ? lot.cost / lot.qty : storedAvg;
      if (trade.realizedPnl === undefined || trade.realizedPnl === null) trade.realizedPnl = hasBasis ? (price - avgPrice) * qty : null;
      const soldQty = Math.min(qty, lot.qty);
      lot.cost = Math.max(0, lot.cost - avgPrice * soldQty);
      lot.qty = Math.max(0, lot.qty - soldQty);
    });
    return rows;
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
    const chosenStrategy = strategy || "TURTLE", domestic = item.domesticTrend || {}, kiwoom = item.kiwoomPdf || {};
    const signalNow = chosenStrategy === "PULLBACK_KR" ? !!domestic.buyReady : chosenStrategy === "KIWOOM_PDF" ? !!kiwoom.allPass : !!item.perfect;
    account.watchlist.push({
      ticker, code: item.code || ticker, name: item.name || ticker, market: item.market || "KR",
      currency: currencyOf(item), strategy: chosenStrategy, state: signalNow ? "PENDING" : "WAITING",
      autoTrade:false, currentSignal:signalNow ? "매수 신호" : "관찰", registeredDate: item.date || today(), signalDate: signalNow ? item.date : "", lastDate: item.date || "", snapshot: snapshot(item)
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
    const d = item.domesticTrend || {}, k = item.kiwoomPdf || {};
    return { price:number(item.price), open:number(item.open), high:number(item.high), low:number(item.low), n:number(item.n), entry1:number(item.entry1), exit1:number(item.exit1), ma5:number(d.ma5), ma10:number(d.ma10), breakoutLevel:number(d.breakoutLevel), kiwoomPass:!!k.allPass, phase:item.phase || d.status || k.status || "" };
  }

  function unitQuantity(account, item, riskPct) {
    const currency = currencyOf(item), capital = number(account[initialKey(currency)]), n = number(item.n), price = number(item.price);
    if (!capital || !n || !price) return 0;
    // 위험금액 = 수량 × 손절폭(2N)이므로 1 Unit도 2N 기준으로 계산한다.
    const riskQty = Math.floor(capital * Math.max(.001, number(riskPct) || 1) / 100 / (2 * n));
    return Math.max(0, Math.min(riskQty, Math.floor(number(account[cashKey(currency)]) / price)));
  }

  function fillPrice(item, trigger) {
    const open = number(item.open) || number(item.price), level = number(trigger);
    return level > 0 ? Math.max(open, level) : open;
  }

  function addTrade(account, position, side, qty, price, reason, date) {
    const amount = qty * price, currency = position.currency, key = cashKey(currency), avgPrice = number(position.avgPrice);
    account[key] += side === "BUY" ? -amount : amount;
    account.trades.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`, date:date || today(), ticker:position.ticker, code:position.code, name:position.name, market:position.market, strategy:position.strategy, side, qty, price, amount, currency, avgPrice, realizedPnl:side === "SELL" ? (price - avgPrice) * qty : null, reason });
    account.trades = account.trades.slice(0, 500);
  }

  function enter(account, watch, item, settings) {
    const qty = unitQuantity(account, item, settings.riskPct);
    if (!qty) { watch.state = "NO_CASH"; return false; }
    const price = fillPrice(item, 0), d = item.domesticTrend || {};
    const isPullback = watch.strategy === "PULLBACK_KR", isKiwoom = watch.strategy === "KIWOOM_PDF";
    const position = {
      ticker:watch.ticker, code:watch.code, name:watch.name || item.name, market:item.market || watch.market,
      currency:watch.currency, strategy:watch.strategy, qty, unitQty:qty, stage:1, avgPrice:price,
      autoTrade:watch.autoTrade === true, currentSignal:"매수 완료", trendExitPending:false,
      entryPrice:price, entryDate:item.date, n:number(item.n), nextEntry:isKiwoom ? price + number(item.n) : number(item.entry1) + .5 * number(item.n),
      stop:isPullback ? Math.max(number(d.breakoutLevel), number(item.low)) : price - 2 * number(item.n),
      breakoutLevel:number(d.breakoutLevel), partialTaken:false, lastDate:item.date, lastPrice:number(item.price)
    };
    addTrade(account, position, "BUY", qty, price, isPullback ? "눌림 매수 신호 다음 시가" : isKiwoom ? "PDF 조건 충족 다음 시가" : "터틀 돌파 신호 다음 시가", item.date);
    account.positions.push(position);
    return true;
  }

  function exitPosition(account, position, qty, price, reason, date) {
    const sellQty = Math.min(position.qty, Math.max(0, roundQty(qty)));
    if (!sellQty) return;
    addTrade(account, position, "SELL", sellQty, price, reason, date);
    position.qty -= sellQty; position.lastPrice = price; position.lastDate = date;
  }

  function rejectionCandle(item, line) {
    const open = number(item.open), high = number(item.high), low = number(item.low), close = number(item.price), range = high - low;
    const wickRatio = range > 0 ? (Math.min(open, close) - low) / range : 0;
    const closeLocation = range > 0 ? (close - low) / range : 0;
    return { breached:line > 0 && low <= line, recovered:line > 0 && close >= line, wickRatio, closeLocation, rejection:line > 0 && low <= line && close >= line && wickRatio >= .35 && closeLocation >= .6 };
  }

  function handleTrendExit(account, position, item, exitLine) {
    if (!exitLine) return false;
    const close = number(item.price), candle = rejectionCandle(item, exitLine);
    position.exitLine = exitLine;
    if (position.trendExitPending) {
      if (close < exitLine) {
        position.currentSignal = "전량 매도 완료";
        exitPosition(account, position, position.qty, close, "10일선 다음 날 미회복 전량 청산", item.date);
      } else {
        position.trendExitPending = false;
        position.currentSignal = candle.rejection ? "꼬리반등·보유" : "추세회복·보유";
        position.signalNote = candle.rejection ? `아래꼬리 ${Math.round(candle.wickRatio*100)}% · 종가위치 ${Math.round(candle.closeLocation*100)}%` : "10일 청산선 종가 회복";
        position.lastPrice = close; position.lastDate = item.date;
      }
      return true;
    }
    if (close < exitLine) {
      const qty = Math.max(1, Math.floor(position.qty / 2));
      exitPosition(account, position, qty, close, "10일선 종가 이탈 50% 축소", item.date);
      if (position.qty > 0) {
        position.trendExitPending = true;
        position.currentSignal = "청산 확인 대기";
        position.signalNote = "다음 거래일 종가가 10일 청산선을 회복하지 못하면 전량 청산";
      }
      return true;
    }
    if (candle.breached) {
      position.currentSignal = candle.rejection ? "꼬리반등·보유" : "청산선 회복·보유";
      position.signalNote = candle.rejection ? `아래꼬리 ${Math.round(candle.wickRatio*100)}% · 종가위치 ${Math.round(candle.closeLocation*100)}%` : "장중 이탈 후 종가 회복";
      position.lastPrice = close; position.lastDate = item.date;
      return true;
    }
    return false;
  }

  function positionSignal(position, item) {
    const d = item.domesticTrend || {}, open = number(item.open) || number(item.price), high = number(item.high) || number(item.price), low = number(item.low) || number(item.price), close = number(item.price);
    const stop = number(position.stop), exitLine = number(item.exit1), n = number(position.n) || number(item.n);
    if (stop && low <= stop) return { text:"손절 신호", note:`-2N 손절선 ${stop}` };
    if (position.strategy === "PULLBACK_KR") {
      if (number(d.ma10) && close < number(d.ma10)) return { text:"전량 매도 신호", note:"종가가 10일선 아래" };
      if (!position.partialTaken && close > position.avgPrice && number(d.ma5) && close < number(d.ma5)) return { text:"50% 익절 신호", note:"수익 구간에서 5일선 이탈" };
    } else {
      const candle = rejectionCandle({ open, high, low, price:close }, exitLine);
      if (position.trendExitPending) return close < exitLine ? { text:"전량 매도 신호", note:"10일 청산선 다음 날 미회복" } : { text:candle.rejection ? "꼬리반등·보유" : "추세회복·보유", note:"10일 청산선 회복" };
      if (exitLine && close < exitLine) return { text:"50% 축소 신호", note:"10일 청산선 아래 종가 마감" };
      if (candle.breached) return { text:candle.rejection ? "꼬리반등·보유" : "청산선 회복·보유", note:candle.rejection ? `아래꼬리 ${Math.round(candle.wickRatio*100)}%` : "장중 이탈 후 종가 회복" };
      const maxStage = position.strategy === "KIWOOM_PDF" ? 5 : 4;
      if (position.stage < maxStage && number(position.nextEntry) && high >= number(position.nextEntry)) return { text:"추가매수 신호", note:`다음 진입가 ${position.nextEntry}` };
    }
    if (n && close >= number(position.avgPrice) + 2 * n) return { text:"익절권·추세보유", note:"평균가 대비 +2N 이상 · 자동 익절은 하지 않음" };
    return { text:"보유", note:"손절·청산 조건 미충족" };
  }

  function updateTurtle(account, position, item) {
    const open = number(item.open) || number(item.price), low = number(item.low) || number(item.price), high = number(item.high) || number(item.price);
    const exitLine = number(item.exit1), stop = number(position.stop);
    if (stop && low <= stop) {
      exitPosition(account, position, position.qty, open < stop ? open : stop, "-2N 통합 손절", item.date); return;
    }
    if (handleTrendExit(account, position, item, exitLine)) return;
    let added = false;
    while (position.stage < 4 && high >= position.nextEntry) {
      const price = fillPrice(item, position.nextEntry), affordable = Math.floor(number(account[cashKey(position.currency)]) / price);
      const qty = Math.min(position.unitQty, affordable);
      if (!qty) break;
      const oldAmount = position.avgPrice * position.qty;
      addTrade(account, position, "BUY", qty, price, `${position.stage + 1}차 +0.5N 추가매수`, item.date);
      position.qty += qty; position.stage += 1; position.avgPrice = (oldAmount + price * qty) / position.qty;
      position.stop = price - 2 * position.n; position.nextEntry += .5 * position.n;
      added = true;
    }
    const signal = positionSignal(position, item); position.currentSignal = added ? "추가매수 완료" : signal.text; position.signalNote = added ? `${position.stage}차 진입 완료` : signal.note;
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
    let tookProfit = false;
    if (!position.partialTaken && close > position.avgPrice && number(d.ma5) && close < number(d.ma5)) {
      const qty = Math.max(1, Math.floor(position.qty / 2));
      exitPosition(account, position, qty, close, "5일선 이탈 50% 익절", item.date);
      position.partialTaken = true;
      position.currentSignal = "50% 익절 완료"; position.signalNote = "수익 구간에서 5일선 이탈";
      tookProfit = true;
    }
    if (!tookProfit) { const signal = positionSignal(position, item); position.currentSignal = signal.text; position.signalNote = signal.note; }
    position.lastPrice = close; position.lastDate = item.date;
  }

  function updateKiwoom(account, position, item) {
    const open = number(item.open) || number(item.price), low = number(item.low) || number(item.price), high = number(item.high) || number(item.price);
    const exitLine = number(item.exit1), stop = number(position.stop);
    if (stop && low <= stop) {
      exitPosition(account, position, position.qty, open < stop ? open : stop, "-2N 통합 손절", item.date); return;
    }
    if (handleTrendExit(account, position, item, exitLine)) return;
    let added = false;
    while (position.stage < 5 && high >= position.nextEntry) {
      const price = fillPrice(item, position.nextEntry), affordable = Math.floor(number(account[cashKey(position.currency)]) / price);
      const qty = Math.min(position.unitQty, affordable);
      if (!qty) break;
      const oldAmount = position.avgPrice * position.qty;
      addTrade(account, position, "BUY", qty, price, `${position.stage + 1}차 +1N 추가매수`, item.date);
      position.qty += qty; position.stage += 1; position.avgPrice = (oldAmount + price * qty) / position.qty;
      position.n = number(item.n) || position.n; position.stop = price - 2 * position.n; position.nextEntry = price + position.n;
      added = true;
    }
    const signal = positionSignal(position, item); position.currentSignal = added ? "추가매수 완료" : signal.text; position.signalNote = added ? `${position.stage}차 진입 완료` : signal.note;
    position.lastPrice = number(item.price); position.lastDate = item.date;
  }

  function update(account, items, settings) {
    const map = Object.fromEntries((items || []).filter(item => item && !item.error).map(item => [String(item.ticker).toUpperCase(), item]));
    const entered = [];
    account.watchlist.forEach(watch => {
      const item = map[watch.ticker]; if (!item || !item.date || item.date <= (watch.lastDate || "")) return;
      const d = item.domesticTrend || {}, k = item.kiwoomPdf || {};
      const signal = watch.strategy === "PULLBACK_KR" ? d.buyReady : watch.strategy === "KIWOOM_PDF" ? k.allPass : item.perfect;
      if (watch.autoTrade === true) {
        if (watch.state === "PENDING") {
          if (item.date > watch.signalDate && enter(account, watch, item, settings)) entered.push(watch.ticker);
        } else {
          if (signal) { watch.state = "PENDING"; watch.signalDate = item.date; }
        }
      }
      watch.currentSignal = watch.autoTrade === true ? (watch.state === "PENDING" ? "매수 예약" : "관찰") : (signal ? "매수 신호" : "관찰");
      watch.lastDate = item.date; watch.snapshot = snapshot(item);
    });
    if (entered.length) account.watchlist = account.watchlist.filter(row => !entered.includes(row.ticker));
    account.positions.slice().forEach(position => {
      const item = map[position.ticker];
      if (!item || !item.date || item.date <= (position.lastDate || "")) return;
      if (position.autoTrade === true) {
        if (position.strategy === "PULLBACK_KR") updatePullback(account, position, item);
        else if (position.strategy === "KIWOOM_PDF") updateKiwoom(account, position, item);
        else updateTurtle(account, position, item);
      } else {
        const signal = positionSignal(position, item); position.currentSignal = signal.text; position.signalNote = signal.note;
        position.lastPrice = number(item.price); position.lastDate = item.date;
      }
    });
    account.positions = account.positions.filter(position => position.qty > 0);
    account.updatedAt = new Date().toISOString();
    return account;
  }

  /** 누락된 거래일을 오래된 날짜부터 재생하며 날짜별 중복 처리는 update가 차단합니다. */
  function updateHistory(account, items, settings) {
    const ordered = (items || []).filter(item => item && !item.error && item.date)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.ticker).localeCompare(String(b.ticker)));
    const byDate = new Map();
    ordered.forEach(item => { if (!byDate.has(item.date)) byDate.set(item.date, []); byDate.get(item.date).push(item); });
    byDate.forEach(dayItems => update(account, dayItems, settings));
    return account;
  }

  function manualExit(account, ticker, price, date) {
    const position = account.positions.find(row => row.ticker === ticker);
    if (!position) return false;
    exitPosition(account, position, position.qty, number(price) || position.lastPrice || position.avgPrice, "사용자 수동 청산", date || today());
    account.positions = account.positions.filter(row => row.qty > 0);
    return true;
  }

  function setAutoTrade(account, ticker, enabled) {
    const target = account.watchlist.find(row => row.ticker === ticker) || account.positions.find(row => row.ticker === ticker);
    if (!target) return false;
    target.autoTrade = enabled === true;
    if (account.watchlist.includes(target) && target.autoTrade) {
      target.state = "WAITING"; target.signalDate = ""; target.currentSignal = "관찰";
    }
    account.updatedAt = new Date().toISOString();
    return true;
  }

  function manualBuy(account, ticker, priceValue, qtyValue, date) {
    const price = number(priceValue), qty = roundQty(qtyValue);
    if (!price || !qty) throw new Error("체결가와 수량을 확인하세요.");
    let position = account.positions.find(row => row.ticker === ticker);
    const watch = account.watchlist.find(row => row.ticker === ticker);
    const source = position || watch;
    if (!source) throw new Error("등록된 종목을 찾을 수 없습니다.");
    const currency = source.currency || currencyOf(source), available = Math.floor(number(account[cashKey(currency)]) / price);
    if (qty > available) throw new Error("가상 현금이 부족합니다.");
    if (!position) {
      const snap = watch.snapshot || {}, n = number(snap.n), isPullback = watch.strategy === "PULLBACK_KR", isKiwoom = watch.strategy === "KIWOOM_PDF";
      position = {
        ticker:watch.ticker, code:watch.code, name:watch.name, market:watch.market, currency, strategy:watch.strategy,
        autoTrade:false, currentSignal:"수동 매수 완료", trendExitPending:false, qty, unitQty:qty, stage:1, avgPrice:price, entryPrice:price, entryDate:date || today(), n,
        nextEntry:isKiwoom ? price + n : isPullback ? 0 : price + .5 * n,
        stop:isPullback ? Math.max(number(snap.breakoutLevel), number(snap.low)) : price - 2 * n,
        breakoutLevel:number(snap.breakoutLevel), partialTaken:false, lastDate:date || today(), lastPrice:price
      };
      addTrade(account, position, "BUY", qty, price, "사용자 수동 매수", date || today());
      account.positions.push(position);
      account.watchlist = account.watchlist.filter(row => row.ticker !== ticker);
    } else {
      const oldAmount = position.avgPrice * position.qty;
      addTrade(account, position, "BUY", qty, price, "사용자 수동 추가매수", date || today());
      position.qty += qty;
      position.avgPrice = (oldAmount + price * qty) / position.qty;
      if (position.strategy !== "PULLBACK_KR") position.stage = Math.min(position.strategy === "KIWOOM_PDF" ? 5 : 4, number(position.stage) + 1);
      if (position.n) {
        position.stop = Math.max(number(position.stop), price - 2 * position.n);
        position.nextEntry = price + (position.strategy === "KIWOOM_PDF" ? 1 : .5) * position.n;
      }
      position.currentSignal = "수동 추가매수 완료"; position.signalNote = `${qty}주 직접 체결`;
      position.lastPrice = price; position.lastDate = date || today();
    }
    account.updatedAt = new Date().toISOString();
    return position;
  }

  function manualSell(account, ticker, priceValue, qtyValue, date) {
    const position = account.positions.find(row => row.ticker === ticker), price = number(priceValue), qty = roundQty(qtyValue);
    if (!position) throw new Error("보유 종목을 찾을 수 없습니다.");
    if (!price || !qty || qty > position.qty) throw new Error("체결가와 매도수량을 확인하세요.");
    exitPosition(account, position, qty, price, "사용자 수동 매도", date || today());
    if (position.qty > 0) { position.currentSignal = "수동 부분매도 완료"; position.signalNote = `${qty}주 직접 매도`; }
    account.positions = account.positions.filter(row => row.qty > 0);
    account.updatedAt = new Date().toISOString();
    return true;
  }

  function valuation(account) {
    const result = { KRW:{initial:number(account.initialKRW),cash:number(account.cashKRW),market:0,total:0,pnl:0}, USD:{initial:number(account.initialUSD),cash:number(account.cashUSD),market:0,total:0,pnl:0} };
    account.positions.forEach(position => { result[position.currency].market += position.qty * number(position.lastPrice || position.avgPrice); });
    Object.values(result).forEach(row => { row.total=row.cash+row.market; row.pnl=row.total-row.initial; });
    return result;
  }

  return { createAccount, normalizeAccount, changeCapital, register, unregister, update, updateHistory, manualExit, manualBuy, manualSell, setAutoTrade, valuation, unitQuantity, snapshot };
});
