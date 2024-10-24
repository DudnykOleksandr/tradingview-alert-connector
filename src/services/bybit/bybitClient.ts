import * as ccxt from 'ccxt';
import { dydxV4OrderParams, AlertObject, OrderResult } from '../../types';
import {
	_sleep,
	calculateProfit,
	doubleSizeIfReverseOrder
} from '../../helper';
import 'dotenv/config';
import { OrderSide, OrderType } from '@dydxprotocol/v4-client-js';
import { AbstractDexClient } from '../abstractDexClient';
import { Mutex } from 'async-mutex';

export class BybitClient extends AbstractDexClient {
	private client: ccxt.bybit;

	constructor() {
		super();

		if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_SECRET) {
			console.log('Bybit credentials are not set as environment variable');
		}

		this.client = new ccxt.bybit({
			apiKey: process.env.BYBIT_API_KEY,
			secret: process.env.BYBIT_SECRET
		});

		if (process.env.NODE_ENV !== 'production') this.client.setSandboxMode(true);
	}

	public async getIsAccountReady(): Promise<boolean> {
		try {
			// Fetched balance indicates connected wallet
			await this.client.fetchBalance();
			return true;
		} catch (e) {
			return false;
		}
	}

	private async buildOrderParams(alertMessage: AlertObject) {
		const orderSide =
			alertMessage.order == 'buy' ? OrderSide.BUY : OrderSide.SELL;

		const latestPrice = alertMessage.price;
		console.log('latestPrice', latestPrice);

		let orderSize: number;
		orderSize = alertMessage.size;

		orderSize = doubleSizeIfReverseOrder(alertMessage, orderSize);

		const market = alertMessage.market.replace(/_/g, '-');

		const orderParams: dydxV4OrderParams = {
			market,
			side: orderSide,
			size: Number(orderSize),
			price: Number(alertMessage.price)
		};
		console.log('orderParams for bybit', orderParams);
		return orderParams;
	}

	public async placeOrder(
		alertMessage: AlertObject,
		openedPositions: ccxt.Position[],
		mutex: Mutex
	) {
		const orderParams = await this.buildOrderParams(alertMessage);

		const market = orderParams.market;
		const type = OrderType.LIMIT;
		const side = orderParams.side;
		const mode = process.env.BYBIT_MODE || '';
		const direction = alertMessage.direction;

		if (side === OrderSide.BUY && mode.toLowerCase() === 'onlysell') return;

		const timeInForce = 'gtc';
		const slippagePercentage = parseFloat(alertMessage.slippagePercentage); // Get from alert
		const orderMode = alertMessage.orderMode || '';
		const newPositionSize = alertMessage.newPositionSize;
		const price =
			side == OrderSide.BUY
				? orderParams.price * ((100 + slippagePercentage) / 100)
				: orderParams.price * ((100 - slippagePercentage) / 100);

		let size = orderParams.size;

		if (
			(side === OrderSide.SELL && direction === 'long') ||
			(side === OrderSide.BUY && direction === 'short')
		) {
			const position = openedPositions.find((el) => el.symbol === market);

			if (!position) {
				console.log('order is ignored because position not exists');
				return;
			}

			const profit = calculateProfit(orderParams.price, position.entryPrice);
			const minimumProfit =
				alertMessage.minProfit ??
				parseFloat(process.env.MINIMUM_PROFIT_PERCENT);

			if (
				(direction === 'long' && profit < minimumProfit) ||
				(direction === 'short' && -1 * profit < minimumProfit)
			) {
				console.log(
					`Order is ignored because profit level not reached: current profit ${profit}, direction ${direction}`
				);
				return;
			}

			const sum = Math.abs(position.contracts);

			size =
				orderMode === 'full' || newPositionSize == 0
					? sum
					: Math.min(size, sum);
		} else if (orderMode === 'full' || newPositionSize == 0) {
			const position = openedPositions.find((el) => el.symbol === market);
			if (!position) {
				if (newPositionSize == 0) {
					console.log(
						'ignore this order because new position size is 0 and current position not exists'
					);
					return;
				}
			} else {
				if (
					(side === OrderSide.SELL && position.contracts > 0) ||
					(side === OrderSide.BUY && position.contracts < 0)
				)
					size = Math.abs(position.contracts);
			}
		}

		const postOnly = false;
		const reduceOnly = false;

		const fillWaitTime =
			parseInt(process.env.FILL_WAIT_TIME_SECONDS) * 1000 || 300 * 1000; // 5 minutes by default

		let positionIdx: number;
		if (direction === 'flat') positionIdx = 0;
		if (direction === 'long') positionIdx = 1;
		if (direction === 'short') positionIdx = 2;

		const clientId = this.generateRandomHexString(32);
		console.log('Client ID: ', clientId);

		// For cancelling if needed
		let orderId: string;

		// This solution fixes problem of two parallel calls in exchange, which is not possible
		// const release = await mutex.acquire();

		try {
			const result = await this.client.createOrder(
				market,
				type,
				side.toLowerCase(),
				size,
				price,
				{
					clientOrderId: clientId,
					timeInForce,
					postOnly,
					reduceOnly,
					position_idx: positionIdx
				}
			);
			console.log('[Bybit] Transaction Result: ', result);
			orderId = result.id;
		} catch (e) {
			console.error(e);
		} finally {
			// release();
		}

		await _sleep(fillWaitTime);

		const isFilled = await this.isOrderFilled(orderId, market);
		if (!isFilled) {
			// const release = await mutex.acquire();

			try {
				await this.client.cancelOrder(orderId, market, {
					clientOrderId: clientId
				});
				console.log(`Bybit Order ID ${orderId} canceled`);
			} catch (e) {
				console.log(e);
			} finally {
				// release();
			}
		}
		const orderResult: OrderResult = {
			side: orderParams.side,
			size: orderParams.size,
			orderId: String(clientId)
		};

		return orderResult;
	}

	private generateRandomHexString(size: number): string {
		return `0x${[...Array(size)]
			.map(() => Math.floor(Math.random() * 16).toString(16))
			.join('')}`;
	}

	private isOrderFilled = async (
		orderId: string,
		market: string
	): Promise<boolean> => {
		try {
			const order = await this.client.fetchOpenOrder(orderId, market);

			console.log('Bybit Order ID: ', order.id);

			return order.status == 'closed';
		} catch (e) {
			console.log(e);
			return false;
		}
	};

	public getOpenedPositions = async (): Promise<ccxt.Position[]> => {
		return this.client.fetchPositions();
	};
}
