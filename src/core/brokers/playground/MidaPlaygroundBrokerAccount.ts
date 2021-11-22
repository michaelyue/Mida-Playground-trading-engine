import {
    MidaBrokerAccount,
    MidaBrokerAccountType,
    MidaBrokerErrorType,
    MidaError,
    MidaBrokerOrder,
    MidaSymbolTick,
    MidaBrokerOrderStatusType,
    MidaBrokerOrderDirectives,
    MidaBrokerOrderType,
    MidaSymbolPeriod,
    MidaSymbolPriceType,
    MidaSymbol,
} from "@reiryoku/mida";
import { MidaPlaygroundBrokerAccountParameters } from "#brokers/playground/MidaPlaygroundBrokerAccountParameters";

export class MidaPlaygroundBrokerAccount extends MidaBrokerAccount {
    private _localDate: Date;
    private _balance: number;
    private _idsCounter: number;
    private readonly _orders: Map<string, MidaBrokerOrder>;
    private _globalLeverage: number;
    private _negativeBalanceProtection: boolean;
    private _fixedOrderCommission: number;
    private _marginCallLevel: number;
    private _stopOutLevel: number;
    private readonly _localSymbols: Map<string, MidaSymbol>;
    private readonly _localTicks: Map<string, MidaSymbolTick[]>;
    private readonly _lastTicks: Map<string, MidaSymbolTick>;
    private readonly _localPeriods: Map<string, MidaSymbolPeriod[]>;
    private readonly _lastPeriods: Map<string, MidaSymbolPeriod>;
    private readonly _watchedSymbols: Set<string>;

    public constructor ({
        id,
        ownerName,
        broker,
        localDate,
        currency = "USD",
        balance = 100000,
        negativeBalanceProtection = false,
        fixedOrderCommission = 0,
        marginCallLevel = 100,
        stopOutLevel = 50,
    }: MidaPlaygroundBrokerAccountParameters) {
        super({
            id,
            ownerName,
            type: MidaBrokerAccountType.DEMO,
            currency,
            globalLeverage: 0,
            isHedged: true,
            broker,
        });

        this._localDate = new Date(localDate || 0);
        this._balance = balance;
        this._idsCounter = 0;
        this._orders = new Map();
        this._globalLeverage = 1 / 500;
        this._negativeBalanceProtection = negativeBalanceProtection;
        this._fixedOrderCommission = fixedOrderCommission;
        this._marginCallLevel = marginCallLevel;
        this._stopOutLevel = stopOutLevel;
        this._localSymbols = new Map();
        this._localTicks = new Map();
        this._lastTicks = new Map();
        this._localPeriods = new Map();
        this._lastPeriods = new Map();
        this._watchedSymbols = new Set();
    }

    public get localDate (): Date {
        return new Date(this._localDate);
    }

    public set localDate (value: Date) {
        this._localDate = new Date(value);
    }

    public get globalLeverage (): number {
        return this._globalLeverage;
    }

    public set globalLeverage (value: number) {
        this._globalLeverage = value;
    }

    public get negativeBalanceProtection (): boolean {
        return this._negativeBalanceProtection;
    }

    public set negativeBalanceProtection (value: boolean) {
        this._negativeBalanceProtection = value;
    }

    public get fixedOrderCommission (): number {
        return this._fixedOrderCommission;
    }

    public set fixedOrderCommission (value: number) {
        this._fixedOrderCommission = Math.abs(value || 0);
    }

    public get marginCallLevel (): number {
        return this._marginCallLevel;
    }

    public set marginCallLevel (value: number) {
        this._marginCallLevel = value;
    }

    public get stopOutLevel (): number {
        return this._stopOutLevel;
    }

    public set stopOutLevel (value: number) {
        this._stopOutLevel = value;
    }

    public async getBalance (): Promise<number> {
        return this._balance;
    }

    public async getEquity (): Promise<number> {
        const orders: MidaBrokerOrder[] = await this.getOpenOrders();
        const profits: number[] = await Promise.all(orders.map((order: MidaBrokerOrder): Promise<number> => order.getNetProfit()));

        return this._balance + profits.reduce((a: number, b: number) => a + b, 0);
    }

    public async getUsedMargin (): Promise<number> {
        // throw new Error();
        return 0;
    }

    public async getOrders (): Promise<MidaBrokerOrder[]> {
        return [ ...this._orders.values(), ];
    }

    public async getOrder (id: string): Promise<MidaBrokerOrder | undefined> {
        return this._orders.get(id);
    }

    public async getOrderGrossProfit (id: string): Promise<number> {
        await this._assertOrderExists(id);

        const order: MidaBrokerOrder = this._orders.get(id) as MidaBrokerOrder;

        const openPrice: number | undefined = order.openPrice;

        if (openPrice === undefined) {
            throw new Error();
        }

        let closePrice: number | undefined;

        if (order.status === MidaBrokerOrderStatusType.OPEN) {
            if (order.type === MidaBrokerOrderType.SELL) {
                closePrice = await this.getSymbolAsk(order.symbol);
            }
            else if (order.type === MidaBrokerOrderType.BUY) {
                closePrice = await this.getSymbolBid(order.symbol);
            }
            else {
                throw new Error();
            }
        }
        else if (order.status === MidaBrokerOrderStatusType.CLOSED) {
            closePrice = order.closePrice;
        }
        else {
            throw new Error();
        }

        if (closePrice === undefined) {
            throw new Error();
        }

        if (order.type === MidaBrokerOrderType.SELL) {
            return (openPrice - closePrice) * order.lots * 100000;
        }
        else if (order.type === MidaBrokerOrderType.BUY) {
            return (closePrice - openPrice) * order.lots * 100000;
        }

        throw new Error();
    }

    public async getOrderNetProfit (id: string): Promise<number> {
        await this._assertOrderExists(id);

        const tasks: Promise<number>[] = [ this.getOrderGrossProfit(id), this.getOrderSwaps(id), this.getOrderCommission(id), ];
        const [ grossProfit, swaps, commission, ]: number[] = await Promise.all(tasks);

        return grossProfit + swaps - Math.abs(commission);
    }

    public async getOrderSwaps (id: string): Promise<number> {
        await this._assertOrderExists(id);

        return 0;
    }

    public async getOrderCommission (id: string): Promise<number> {
        await this._assertOrderExists(id);

        return this._fixedOrderCommission;
    }

    public async placeOrder (directives: MidaBrokerOrderDirectives): Promise<MidaBrokerOrder> {
        await this._assertSymbolExists(directives.symbol);

        const symbol: string = directives.symbol;
        const isBuyOrder: boolean = directives.type === MidaBrokerOrderType.BUY;
        const isMarketOrder: boolean = !Number.isFinite(directives.stop) && !Number.isFinite(directives.limit);

        const order: MidaBrokerOrder = new MidaBrokerOrder({
            id: (++this._idsCounter).toString(),
            brokerAccount: this,
            requestDirectives: directives,
            requestDate: this._localDate,
            creationDate: this._localDate,
            openDate: isMarketOrder ? this._localDate : undefined,
            creationPrice: isBuyOrder ? (await this.getSymbolAsk(symbol)) : (await this.getSymbolBid(symbol)),
            openPrice: isMarketOrder ? (isBuyOrder ? (await this.getSymbolAsk(symbol)) : (await this.getSymbolBid(symbol))) : undefined,
        });

        this._orders.set(order.id, order);

        return order;
    }

    public async cancelOrder (id: string): Promise<void> {
        await this._assertOrderExists(id);

        const order: MidaBrokerOrder = this._orders.get(id) as MidaBrokerOrder;

        if (order.status !== MidaBrokerOrderStatusType.PENDING) {
            throw new Error();
        }

        let cancelPrice: number | undefined;

        if (order.type === MidaBrokerOrderType.SELL) {
            cancelPrice = await this.getSymbolAsk(order.symbol);
        }
        else if (order.type === MidaBrokerOrderType.BUY) {
            cancelPrice = await this.getSymbolBid(order.symbol);
        }
        else {
            throw new Error();
        }

        if (cancelPrice === undefined) {
            throw new Error();
        }

        this.notifyListeners("order-cancel", {
            id: order.id,
            cancelDate: new Date(this._localDate),
            cancelPrice,
        });
    }

    public async closeOrder (id: string): Promise<void> {
        await this._assertOrderExists(id);

        const order: MidaBrokerOrder = this._orders.get(id) as MidaBrokerOrder;

        if (order.status !== MidaBrokerOrderStatusType.OPEN) {
            throw new Error();
        }

        let closePrice: number | undefined;

        if (order.type === MidaBrokerOrderType.SELL) {
            closePrice = await this.getSymbolAsk(order.symbol);
        }
        else if (order.type === MidaBrokerOrderType.BUY) {
            closePrice = await this.getSymbolBid(order.symbol);
        }
        else {
            throw new Error();
        }

        if (closePrice === undefined) {
            throw new Error();
        }

        this._balance += await order.getNetProfit();

        this.notifyListeners("order-close", {
            id: order.id,
            closeDate: new Date(this._localDate),
            closePrice,
        });
    }

    public async getOrderStopLoss (id: string): Promise<number | undefined> {
        await this._assertOrderExists(id);

        const order: MidaBrokerOrder | undefined = this._orders.get(id);

        if (!order) {
            throw new Error();
        }

        return order.stopLoss;
    }

    public async setOrderStopLoss (id: string, stopLoss: number): Promise<void> {
        await this._assertOrderExists(id);

        const order: MidaBrokerOrder | undefined = this._orders.get(id);

        if (!order) {
            throw new Error();
        }

        this.notifyListeners("order-directives", {
            id: order.id,
            stopLoss,
        });
    }

    public async clearOrderStopLoss (id: string): Promise<void> {
        await this._assertOrderExists(id);

        const order: MidaBrokerOrder | undefined = this._orders.get(id);

        if (!order) {
            throw new Error();
        }

        this.notifyListeners("order-directives", {
            id: order.id,
            stopLoss: undefined,
        });
    }

    public async getOrderTakeProfit (id: string): Promise<number | undefined> {
        await this._assertOrderExists(id);

        const order: MidaBrokerOrder | undefined = this._orders.get(id);

        if (!order) {
            throw new Error();
        }

        return order.takeProfit;
    }

    public async setOrderTakeProfit (id: string, takeProfit: number): Promise<void> {
        await this._assertOrderExists(id);

        const order: MidaBrokerOrder | undefined = this._orders.get(id);

        if (!order) {
            throw new Error();
        }

        this.notifyListeners("order-directives", {
            id: order.id,
            takeProfit,
        });
    }

    public async clearOrderTakeProfit (id: string): Promise<void> {
        await this._assertOrderExists(id);

        const order: MidaBrokerOrder | undefined = this._orders.get(id);

        if (!order) {
            throw new Error();
        }

        this.notifyListeners("order-directives", {
            id: order.id,
            takeProfit: undefined,
        });
    }

    public async getSymbols (): Promise<string[]> {
        return [ ...this._localSymbols.keys(), ];
    }

    public async getSymbol (symbol: string): Promise<MidaSymbol | undefined> {
        return this._localSymbols.get(symbol);
    }

    public async isSymbolMarketOpen (symbol: string): Promise<boolean> {
        await this._assertSymbolExists(symbol);

        throw new Error();
    }

    public async getSymbolPeriods (symbol: string, timeframe: number, priceType?: MidaSymbolPriceType): Promise<MidaSymbolPeriod[]> {
        await this._assertSymbolExists(symbol);

        return [];
    }

    public async getSymbolLastTick (symbol: string): Promise<MidaSymbolTick | undefined> {
        await this._assertSymbolExists(symbol);

        return this._lastTicks.get(symbol);
    }

    public async getSymbolBid (symbol: string): Promise<number> {
        const lastTick: MidaSymbolTick | undefined = await this.getSymbolLastTick(symbol);

        if (!lastTick) {
            throw new Error();
        }

        return lastTick.bid;
    }

    public async getSymbolAsk (symbol: string): Promise<number> {
        const lastTick: MidaSymbolTick | undefined = await this.getSymbolLastTick(symbol);

        if (!lastTick) {
            throw new Error();
        }

        return lastTick.ask;
    }

    public async watchSymbolTicks (symbol: string): Promise<void> {
        await this._assertSymbolExists(symbol);

        this._watchedSymbols.add(symbol);
    }

    public async logout (): Promise<void> {
        throw new Error();
    }

    public async registerSymbol (symbol: MidaSymbol): Promise<void> {
        this._localSymbols.set(symbol.toString(), symbol);
    }

    /**
     * Used to elapse a given amount of time.
     * @param amount Amount of time to elapse in seconds.
     */
    public async elapseTime (amount: number): Promise<MidaSymbolTick[]> {
        const previousDate: Date = this._localDate;
        const actualDate: Date = new Date(this._localDate.valueOf() + amount * 1000);
        const elapsedTicks: MidaSymbolTick[] = [];

        for (const symbol of this._localSymbols.keys()) {
            const ticks: MidaSymbolTick[] = this._localTicks.get(symbol) || [];

            for (const tick of ticks) {
                if (tick.date > previousDate && tick.date <= actualDate) {
                    elapsedTicks.push(tick);
                }
            }
        }

        elapsedTicks.sort((a: MidaSymbolTick, b: MidaSymbolTick): number => a.date.valueOf() - b.date.valueOf());

        for (const tick of elapsedTicks) {
            this._localDate = new Date(tick.date);

            this._lastTicks.set(tick.symbol, tick);
            await this._onTick(tick);
        }

        this._localDate = actualDate;

        return elapsedTicks;
    }

    public deposit (amount: number): void {
        this._balance += amount;
    }

    public withdraw (amount: number): void {
        this._balance -= amount;
    }

    public async loadTicks (ticks: MidaSymbolTick[]): Promise<void> {
        const symbol: string = ticks[0].symbol;

        await this._assertSymbolExists(symbol);

        const localTicks: MidaSymbolTick[] = this._localTicks.get(symbol) || [];
        const updatedTicks: MidaSymbolTick[] = localTicks.concat(ticks);

        updatedTicks.sort((a: MidaSymbolTick, b: MidaSymbolTick): number => a.date.valueOf() - b.date.valueOf());

        this._localTicks.set(symbol, updatedTicks);
    }

    public getSymbolTicks (symbol: string): MidaSymbolTick[] | undefined {
        return this._localTicks.get(symbol);
    }

    private async _assertSymbolExists (symbol: string): Promise<void> {
        if (!this._localSymbols.has(symbol)) {
            throw new MidaError({ type: MidaBrokerErrorType.INVALID_SYMBOL, });
        }
    }

    private async _assertOrderExists (id: string): Promise<void> {
        if (!this._orders.has(id)) {
            throw new MidaError({ type: MidaBrokerErrorType.ORDER_NOT_FOUND, });
        }
    }

    private async _openPendingOrder (id: string): Promise<void> {
        const order: MidaBrokerOrder | undefined = this._orders.get(id);

        if (!order) {
            throw new Error();
        }

        if (order.status !== MidaBrokerOrderStatusType.PENDING) {
            throw new Error();
        }

        let openPrice: number | undefined;

        if (order.type === MidaBrokerOrderType.SELL) {
            openPrice = await this.getSymbolBid(order.symbol);
        }
        else if (order.type === MidaBrokerOrderType.BUY) {
            openPrice = await this.getSymbolAsk(order.symbol);
        }
        else {
            throw new Error();
        }

        if (openPrice === undefined) {
            throw new Error();
        }

        this.notifyListeners("order-open", {
            id: order.id,
            openDate: new Date(this._localDate),
            openPrice,
        });
    }

    private async _onTick (tick: MidaSymbolTick): Promise<void> {
        const tasks: Promise<void>[] = [ this._updatePendingOrders(tick), this._updateOpenOrders(tick), ];

        await Promise.all(tasks);

        if (this._watchedSymbols.has(tick.symbol)) {
            this.notifyListeners("tick", { tick, });
        }

        // <margin-call>
        const marginLevel: number = await this.getMarginLevel();

        if (Number.isFinite(marginLevel) && marginLevel <= this._marginCallLevel) {
            this.notifyListeners("margin-call", { marginLevel, });
        }
        // </margin-call>
    }

    // tslint:disable-next-line:cyclomatic-complexity
    private async _updatePendingOrders (tick: MidaSymbolTick): Promise<void> {
        const orders: MidaBrokerOrder[] = await this.getPendingOrders();

        for (const order of orders) {
            // <limit>
            if (order.limit !== undefined) {
                if (
                    (order.type === MidaBrokerOrderType.SELL && tick.bid >= order.limit)
                    || (order.type === MidaBrokerOrderType.BUY && tick.ask <= order.limit)
                ) {
                    await this._openPendingOrder(order.id);
                }
            }
            // </limit>

            // <stop>
            if (order.stop !== undefined) {
                if (
                    (order.type === MidaBrokerOrderType.SELL && tick.bid <= order.stop)
                    || (order.type === MidaBrokerOrderType.BUY && tick.ask >= order.stop)
                ) {
                    await this._openPendingOrder(order.id);
                }
            }
            // </stop>
        }
    }

    // tslint:disable-next-line:cyclomatic-complexity
    private async _updateOpenOrders (tick: MidaSymbolTick): Promise<void> {
        const orders: MidaBrokerOrder[] = await this.getOpenOrders();

        for (const order of orders) {
            // <stop-loss>
            if (order.stopLoss !== undefined) {
                if (
                    (order.type === MidaBrokerOrderType.SELL && tick.ask >= order.stopLoss)
                    || (order.type === MidaBrokerOrderType.BUY && tick.bid <= order.stopLoss)
                ) {
                    await order.close();
                }
            }
            // </stop-loss>

            // <take-profit>
            if (order.takeProfit !== undefined) {
                if (
                    (order.type === MidaBrokerOrderType.SELL && tick.ask <= order.takeProfit)
                    || (order.type === MidaBrokerOrderType.BUY && tick.bid >= order.takeProfit)
                ) {
                    await order.close();
                }
            }
            // </take-profit>

            // <stop-out>
            const marginLevel: number = await this.getMarginLevel();

            if (Number.isFinite(marginLevel) && marginLevel <= this._stopOutLevel) {
                await order.close();

                this.notifyListeners("stop-out", {
                    id: order.id,
                    marginLevel,
                });
            }
            // </stop-out>

            // <negative-balance-protection>
            const equity: number = await this.getEquity();

            if (this._negativeBalanceProtection && equity < 0) {
                await order.close();
            }
            // </negative-balance-protection>
        }
    }
}