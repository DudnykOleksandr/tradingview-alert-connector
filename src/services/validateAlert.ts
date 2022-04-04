import { AlertObject } from '../types';
import { Market } from '@dydxprotocol/v3-client';
import DYDXConnector from './client';

export const validateAlert = async (
	alertMessage: AlertObject
): Promise<boolean> => {
	// check correct alert JSON format
	if (!Object.keys(alertMessage).length) {
		console.error('Tradingview alert is not JSON format.');
		return false;
	}

	// check passphrase
	if (process.env.TRADINGVIEW_PASSPHRASE && !alertMessage.passphrase) {
		console.error('Passphrase is not set on alert message.');
		return false;
	}
	if (
		alertMessage.passphrase &&
		alertMessage.passphrase != process.env.TRADINGVIEW_PASSPHRASE
	) {
		console.error('Passphrase from tradingview alert does not match to config');
		return false;
	}

	// check strategy name
	if (!alertMessage.strategy) {
		console.error('Strategy field of tradingview alert must not be empty');
		return false;
	}

	// check orderSide
	if (alertMessage.order != 'buy' && alertMessage.order != 'sell') {
		console.error(
			'Side field of tradingview alert is not correct. Must be buy or sell'
		);
		return false;
	}

	//check position
	if (
		alertMessage.position != 'long' &&
		alertMessage.position != 'short' &&
		alertMessage.position != 'flat'
	) {
		console.error('Position field of tradingview alert is not correct.');
		return false;
	}

	//check reverse
	if (typeof alertMessage.reverse != 'boolean') {
		console.error(
			'Reverse field of tradingview alert is not correct. Must be true or false.'
		);
		return false;
	}

	// check market
	const market = Market[alertMessage.market as keyof typeof Market];
	if (!market) {
		console.error('Market field of tradingview alert is not correct.');
		return false;
	}

	const connector = await DYDXConnector.build();

	const markets = await connector.client.public.getMarkets(market);
	// console.log('markets', markets);

	const minOrderSize = parseFloat(markets.markets[market].minOrderSize);

	// check order size is greater than mininum order size
	if (alertMessage.size < minOrderSize) {
		console.error(
			'Order size of this strategy must be greater than mininum order size:',
			minOrderSize
		);
		return false;
	}

	return true;
};