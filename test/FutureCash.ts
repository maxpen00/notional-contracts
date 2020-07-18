import chai from "chai";
import { solidity } from "ethereum-waffle";
import {
    fixture,
    wallets,
    fixtureLoader,
    provider,
    CURRENCY,
    fastForwardToMaturity,
    fastForwardToTime
} from "./fixtures";
import { Wallet } from "ethers";
import { WeiPerEther, AddressZero } from "ethers/constants";

import { Erc20 as ERC20 } from "../typechain/Erc20";
import { FutureCash } from "../typechain/FutureCash";
import { ErrorDecoder, ErrorCodes } from "../scripts/errorCodes";
import { Escrow } from "../typechain/Escrow";
import { Portfolios } from "../typechain/Portfolios";
import { TestUtils, BLOCK_TIME_LIMIT } from "./testUtils";
import { parseEther } from "ethers/utils";
import { Iweth } from '../typechain/Iweth';

chai.use(solidity);
const { expect } = chai;

describe("Future Cash", () => {
    let dai: ERC20;
    let owner: Wallet;
    let wallet: Wallet;
    let wallet2: Wallet;
    let rateAnchor: number;
    let futureCash: FutureCash;
    let escrow: Escrow;
    let portfolios: Portfolios;
    let t: TestUtils;
    let maturities: number[];
    let weth: Iweth;

    beforeEach(async () => {
        owner = wallets[0];
        wallet = wallets[1];
        wallet2 = wallets[2];
        let objs = await fixtureLoader(fixture);

        dai = objs.erc20;
        futureCash = objs.futureCash;
        escrow = objs.escrow;
        portfolios = objs.portfolios;
        weth = objs.weth;

        await dai.transfer(wallet.address, WeiPerEther.mul(10_000));
        await dai.transfer(wallet2.address, WeiPerEther.mul(10_000));

        await dai.connect(owner).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet).approve(escrow.address, WeiPerEther.mul(100_000_000));
        await dai.connect(wallet2).approve(escrow.address, WeiPerEther.mul(100_000_000));

        rateAnchor = 1_050_000_000;
        await futureCash.setRateFactors(rateAnchor, 100);

        // Set the blockheight to the beginning of the next period
        maturities = await futureCash.getActiveMaturities();
        await fastForwardToMaturity(provider, maturities[1]);
        maturities = await futureCash.getActiveMaturities();

        t = new TestUtils(escrow, futureCash, portfolios, dai, owner, objs.chainlink, objs.weth);
    });

    afterEach(async () => {
        expect(await t.checkEthBalanceIntegrity([owner, wallet, wallet2])).to.be.true;
        expect(await t.checkBalanceIntegrity([owner, wallet, wallet2])).to.be.true;
        expect(await t.checkCashIntegrity([owner, wallet, wallet2])).to.be.true;
        expect(await t.checkMarketIntegrity([owner, wallet, wallet2])).to.be.true;
    });

    describe("adding liquidity tokens", async () => {
        it("should not allow add liquidity on invalid maturities", async () => {
            await escrow.deposit(dai.address, WeiPerEther.mul(30));
            // add liquidity
            await expect(
                futureCash.addLiquidity(maturities[0] - 10, WeiPerEther.mul(10), WeiPerEther.mul(10), BLOCK_TIME_LIMIT)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.MARKET_INACTIVE));
            await expect(
                futureCash.addLiquidity(maturities[0] - 20, WeiPerEther.mul(10), WeiPerEther.mul(10), BLOCK_TIME_LIMIT)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.MARKET_INACTIVE));
            await expect(
                futureCash.addLiquidity(maturities[3] + 20, WeiPerEther.mul(10), WeiPerEther.mul(10), BLOCK_TIME_LIMIT)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.MARKET_INACTIVE));
        });

        it("does not allow setting rate factors to zero", async () => {
            await expect(futureCash.setRateFactors(0, 0)).to.be.revertedWith(
                ErrorDecoder.encodeError(ErrorCodes.INVALID_RATE_FACTORS)
            );
        });

        it("should allow add liquidity", async () => {
            await escrow.deposit(dai.address, WeiPerEther.mul(30));
            await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(5), WeiPerEther.mul(10), BLOCK_TIME_LIMIT);

            // Free collateral should not have changed
            expect(await t.isCollateralized(owner)).to.be.true;

            expect(await t.hasLiquidityToken(wallet, maturities[0], WeiPerEther.mul(5), WeiPerEther.mul(10)));
            expect(await escrow.currencyBalances(dai.address, owner.address)).to.equal(WeiPerEther.mul(25));
        });

        it("should allow adding liquidity even after all liquidity has been removed", async () => {
            await t.setupLiquidity();
            await futureCash.removeLiquidity(maturities[0], WeiPerEther.mul(10_000), BLOCK_TIME_LIMIT);
            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));

            await expect(
                futureCash
                    .connect(wallet)
                    .addLiquidity(maturities[0], WeiPerEther.mul(100), WeiPerEther.mul(100), BLOCK_TIME_LIMIT)
            ).to.not.be.reverted;
        });

        it("should prevent adding liquidity under slippage", async () => {
            await t.setupLiquidity();

            await expect(
                futureCash
                    .connect(wallet)
                    .addLiquidity(maturities[0], WeiPerEther.mul(100), WeiPerEther.mul(50), BLOCK_TIME_LIMIT)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.OVER_MAX_FUTURE_CASH));
        });

        it("should not allow add liquidity if there is insufficient balance", async () => {
            await escrow.deposit(dai.address, WeiPerEther.mul(5));
            await expect(
                futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), BLOCK_TIME_LIMIT)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_BALANCE));
        });

        it("should not allow liquidity to start with a negative interest rate", async () => {
            await escrow.deposit(dai.address, WeiPerEther.mul(30));
            await expect(
                futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.div(1_000), BLOCK_TIME_LIMIT)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.UINT256_SUBTRACTION_UNDERFLOW));
        });

        it("should not allow users to add liquidity to invalid periods", async () => {
            await portfolios.updateFutureCashGroup(1, 0, 20, 1e9, CURRENCY.DAI, futureCash.address, AddressZero);
            await escrow.deposit(dai.address, WeiPerEther.mul(30));
            await expect(
                futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), BLOCK_TIME_LIMIT)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.MARKET_INACTIVE));
        });

        it("should allow liquidity to roll", async () => {
            await escrow.deposit(dai.address, WeiPerEther.mul(40));
            await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(10), WeiPerEther.mul(10), BLOCK_TIME_LIMIT);
            await futureCash.addLiquidity(maturities[1], WeiPerEther.mul(10), WeiPerEther.mul(10), BLOCK_TIME_LIMIT);
            await futureCash.addLiquidity(maturities[2], WeiPerEther.mul(10), WeiPerEther.mul(10), BLOCK_TIME_LIMIT);
            await futureCash.addLiquidity(maturities[3], WeiPerEther.mul(10), WeiPerEther.mul(10), BLOCK_TIME_LIMIT);

            // Take futureCash to change the liquidity amounts
            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(10));
            await futureCash.connect(wallet).takeFutureCash(maturities[1], WeiPerEther, BLOCK_TIME_LIMIT, 0);
            await futureCash.connect(wallet).takeFutureCash(maturities[2], WeiPerEther, BLOCK_TIME_LIMIT, 0);
            await futureCash.connect(wallet).takeFutureCash(maturities[3], WeiPerEther, BLOCK_TIME_LIMIT, 0);

            await fastForwardToMaturity(provider, maturities[1]);
            maturities = await futureCash.getActiveMaturities();
            await futureCash.addLiquidity(maturities[3], WeiPerEther.mul(10), WeiPerEther.mul(10), BLOCK_TIME_LIMIT);
        });
    });

    describe("market liquidity limits", async () => {
        it("should prevent trading when there is no liquidity", async () => {
            await expect(
                futureCash.takeCollateral(maturities[0], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, 60_000_000)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.EXCHANGE_RATE_UNDERFLOW));
            await expect(
                futureCash.takeFutureCash(maturities[0], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, 40_000_000)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.EXCHANGE_RATE_UNDERFLOW));
        });

        it("should not take more future cash than available", async () => {
            await t.setupLiquidity(owner, 0.5, WeiPerEther.mul(10));
            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(10000));
            await expect(
                futureCash
                    .connect(wallet)
                    .takeFutureCash(maturities[0], WeiPerEther.mul(20), BLOCK_TIME_LIMIT, 60_000_000)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_LACK_OF_LIQUIDITY));
        });

        it.skip("should not take more collateral than available", async () => {
            await escrow.deposit(dai.address, WeiPerEther.mul(10));
            await futureCash.addLiquidity(maturities[0], WeiPerEther.mul(5), WeiPerEther.mul(2), BLOCK_TIME_LIMIT);
            await escrow.connect(wallet).depositEth({ value: WeiPerEther.mul(10000) });
            await expect(
                futureCash
                    .connect(wallet)
                    .takeCollateral(maturities[0], WeiPerEther.mul(2), BLOCK_TIME_LIMIT, 4_000_000_000)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_LACK_OF_LIQUIDITY));
        });
    });

    describe("removing liquidity tokens", async () => {
        it("should allow remove liquidity", async () => {
            await t.setupLiquidity(owner, 0.5, WeiPerEther.mul(10));

            await futureCash.removeLiquidity(maturities[0], WeiPerEther.mul(5), BLOCK_TIME_LIMIT);
            expect(await t.isCollateralized(owner)).to.be.true;
            expect(await t.hasLiquidityToken(owner, maturities[0], WeiPerEther.mul(5), WeiPerEther.mul(5))).to.be.true;
        });

        it("should allow not allow remove liquidity if the account does not have liquidty tokens", async () => {
            await t.setupLiquidity(owner, 0.5, WeiPerEther.mul(10));

            // This wallet does not have any liquidity tokens
            await expect(
                futureCash.connect(wallet).removeLiquidity(maturities[0], WeiPerEther.mul(5), BLOCK_TIME_LIMIT)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_BALANCE));
        });

        it("should not allow you to remove more liquidity tokens than you have", async () => {
            await t.setupLiquidity(owner, 0.5, WeiPerEther.mul(10));
            await t.setupLiquidity(wallet, 0.5, WeiPerEther.mul(10));

            await expect(
                futureCash.removeLiquidity(maturities[0], WeiPerEther.mul(15), BLOCK_TIME_LIMIT)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_BALANCE));
        });
    });

    // take dai //
    describe("take collateral", async () => {
        it("should allow users to take collateral for future cash", async () => {
            await t.setupLiquidity();

            // Deposit ETH as collateral for a loan.
            await escrow.connect(wallet).depositEth({ value: WeiPerEther });
            let freeCollateral = (await portfolios.freeCollateralView(wallet.address))[0];
            const blockTime = await fastForwardToTime(provider);
            const daiBalance = await futureCash.getFutureCashToCollateralAtTime(
                maturities[0],
                WeiPerEther.mul(25),
                blockTime
            );

            // Deposit 25 dai in future cash, collateralized by an ETH
            await futureCash
                .connect(wallet)
                .takeCollateral(maturities[0], WeiPerEther.mul(25), BLOCK_TIME_LIMIT, 60_000_000);

            expect(await t.hasCashPayer(wallet, maturities[0], WeiPerEther.mul(25))).to.be.true;
            expect(await escrow.currencyBalances(dai.address, wallet.address)).to.equal(daiBalance);

            const freeCollateralAfter = (await portfolios.freeCollateralView(wallet.address))[0];
            expect(freeCollateral.sub(freeCollateralAfter)).to.be.above(0);
        });

        it("should not allow users to take dai for future cash if they do not have collateral", async () => {
            await t.setupLiquidity();

            await expect(
                futureCash
                    .connect(wallet)
                    .takeCollateral(maturities[0], WeiPerEther.mul(25), BLOCK_TIME_LIMIT, 60_000_000)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_FREE_COLLATERAL));
        });

        it.skip("should not allow users to take dai for future cash on an invalid maturity", async () => {
            await t.setupLiquidity();

            await portfolios.updateFutureCashGroup(1, 0, 20, 1e9, 2, futureCash.address, AddressZero);

            await escrow.connect(wallet).depositEth({ value: WeiPerEther });
            await expect(
                futureCash
                    .connect(wallet)
                    .takeCollateral(maturities[0], WeiPerEther.mul(25), BLOCK_TIME_LIMIT, 60_000_000)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.MARKET_INACTIVE));
        });

        it("should not allow users to trade more collateral than the limit", async () => {
            await t.setupLiquidity();

            await futureCash.setMaxTradeSize(WeiPerEther.mul(100));
            await escrow.connect(wallet).depositEth({ value: WeiPerEther.mul(100) });
            await expect(
                futureCash
                    .connect(wallet)
                    .takeCollateral(maturities[0], WeiPerEther.mul(105), BLOCK_TIME_LIMIT, 60_000_000)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_TOO_LARGE));
        });
    });

    // take future cash //
    describe("take future cash", async () => {
        it("should allow users to take future cash for dai", async () => {
            await t.setupLiquidity();

            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(100));
            await futureCash
                .connect(wallet)
                .takeFutureCash(maturities[0], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, 40_000_000);

            expect(await t.hasCashReceiver(wallet, maturities[0], WeiPerEther.mul(100))).to.be.true;
            expect((await portfolios.freeCollateralView(wallet.address))[0]).to.equal(0);
        });

        it("should not allow users to take future cash for dai if they do not have collateral", async () => {
            await t.setupLiquidity();

            await expect(
                futureCash
                    .connect(wallet)
                    .takeFutureCash(maturities[0], WeiPerEther.mul(25), BLOCK_TIME_LIMIT, 40_000_000)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.INSUFFICIENT_BALANCE));
        });

        it.skip("should not allow users to take future cash for dai on an invalid maturity", async () => {
            await t.setupLiquidity();

            await portfolios.updateFutureCashGroup(1, 0, 20, 1e9, 2, futureCash.address, AddressZero);

            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(25));
            await expect(
                futureCash
                    .connect(wallet)
                    .takeFutureCash(maturities[0], WeiPerEther.mul(25), BLOCK_TIME_LIMIT, 40_000_000)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.MARKET_INACTIVE));
        });

        it("should not allow users to trade more future cash than the limit", async () => {
            await t.setupLiquidity();

            await futureCash.setMaxTradeSize(WeiPerEther.mul(100));
            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
            await expect(
                futureCash
                    .connect(wallet)
                    .takeFutureCash(maturities[0], WeiPerEther.mul(105), BLOCK_TIME_LIMIT, 40_000_000)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_TOO_LARGE));
        });
    });

    // settle account //
    it("should settle accounts to cash", async () => {
        await t.setupLiquidity();

        await escrow.connect(wallet2).depositEth({ value: WeiPerEther.mul(5) });
        await futureCash
            .connect(wallet2)
            .takeCollateral(maturities[0], WeiPerEther.mul(500), BLOCK_TIME_LIMIT, 60_000_000);

        await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(100));
        await futureCash
            .connect(wallet)
            .takeFutureCash(maturities[0], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, 40_000_000);

        await fastForwardToMaturity(provider, maturities[1]);

        await portfolios.settleAccount(wallet.address);
        await portfolios.settleAccountBatch([wallet2.address, owner.address]);

        expect(await portfolios.getAssets(owner.address)).to.have.lengthOf(0);
        expect(await portfolios.getAssets(wallet.address)).to.have.lengthOf(0);
        expect(await portfolios.getAssets(wallet2.address)).to.have.lengthOf(0);

        // Liquidity provider has earned some interest on liquidity
        expect(
            (await escrow.cashBalances(CURRENCY.DAI, owner.address)).add(
                await escrow.currencyBalances(dai.address, owner.address)
            )
        ).to.be.above(WeiPerEther.mul(10_000));
        expect(await escrow.currencyBalances(weth.address, owner.address)).to.equal(0);

        // This is the negative balance owed as a fixed rate loan ("takeCollateral")
        expect(await escrow.cashBalances(CURRENCY.DAI, wallet2.address)).to.equal(WeiPerEther.mul(-500));
        expect(await escrow.currencyBalances(weth.address, wallet2.address)).to.equal(WeiPerEther.mul(5));

        // This is the lending amount, should be above what they put in
        expect(await escrow.cashBalances(CURRENCY.DAI, wallet.address)).to.equal(WeiPerEther.mul(100));
        // There is some residual left in dai balances.
        expect(await escrow.currencyBalances(dai.address, wallet.address)).to.be.above(0);
        expect(await escrow.currencyBalances(weth.address, wallet.address)).to.equal(0);
    });

    // price methods //
    describe("pricing methods", async () => {
        it("should revert if trying to get price past a maturity", async () => {
            await expect(
                futureCash.getCollateralToFutureCashAtTime(maturities[0], parseEther("1"), maturities[0] + 10)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.CANNOT_GET_PRICE_FOR_MATURITY));

            await expect(
                futureCash.getCollateralToFutureCashAtTime(maturities[0], parseEther("1"), maturities[0] + 10)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.CANNOT_GET_PRICE_FOR_MATURITY));
        });

        it("should return a higher rate after someone has purchased dai (borrowed)", async () => {
            await t.setupLiquidity();

            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
            const periodSize = await futureCash.G_PERIOD_SIZE();
            const impliedRateBefore = (await futureCash.markets(maturities[0])).lastImpliedRate;
            const blockTime = await fastForwardToTime(provider);
            const cash = await futureCash.getFutureCashToCollateralAtTime(
                maturities[0],
                WeiPerEther.mul(200),
                blockTime
            );
            expect(cash).to.be.below(WeiPerEther.mul(200));

            await futureCash
                .connect(wallet)
                .takeCollateral(maturities[0], WeiPerEther.mul(200), BLOCK_TIME_LIMIT, 60_000_000);

            const impliedRateAfter = (await futureCash.markets(maturities[0])).lastImpliedRate;
            const tradeImpliedRate = WeiPerEther.mul(200)
                .mul(1e9)
                .div(cash)
                .sub(1e9)
                .mul(periodSize)
                .div(maturities[0] - blockTime);
            // console.log(`Exchange Rate: ${exchangeRate}`);
            // console.log(`Implied Rate Before: ${impliedRateBefore}`);
            // console.log(`Implied Rate After: ${impliedRateAfter}`);
            // console.log(`Trade Implied Rate: ${tradeImpliedRate.toString()}`);

            // This should be impliedRateBefore < impliedRateAfter < tradeExchangeRate
            expect(impliedRateBefore).to.be.below(impliedRateAfter);
            expect(impliedRateAfter).to.be.below(tradeImpliedRate);
            expect(await escrow.currencyBalances(dai.address, wallet.address)).to.equal(
                WeiPerEther.mul(1000).add(cash)
            );
        });

        it("should return a lower rate after someone has purchased future cash (lending)", async () => {
            await t.setupLiquidity();

            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
            const periodSize = await futureCash.G_PERIOD_SIZE();
            const impliedRateBefore = (await futureCash.markets(maturities[0])).lastImpliedRate;
            const blockTime = await fastForwardToTime(provider);
            const cash = await futureCash.getCollateralToFutureCashAtTime(
                maturities[0],
                WeiPerEther.mul(200),
                blockTime
            );
            expect(cash).to.be.below(WeiPerEther.mul(200));

            await futureCash
                .connect(wallet)
                .takeFutureCash(maturities[0], WeiPerEther.mul(200), BLOCK_TIME_LIMIT, 40_000_000);

            expect(await escrow.currencyBalances(dai.address, wallet.address)).to.equal(
                WeiPerEther.mul(1000).sub(cash)
            );

            const impliedRateAfter = (await futureCash.markets(maturities[0])).lastImpliedRate;
            const tradeImpliedRate = WeiPerEther.mul(200)
                .mul(1e9)
                .div(cash)
                .sub(1e9)
                .mul(periodSize)
                .div(maturities[0] - blockTime);

            // console.log(`Implied Rate Before: ${impliedRateBefore}`);
            // console.log(`Implied Rate After: ${impliedRateAfter}`);
            // console.log(`Trade Implied Rate: ${tradeImpliedRate.toString()}`);
            // This should be impliedRateBefore > impliedRateAfter > tradeExchangeRate
            expect(impliedRateBefore).to.be.above(impliedRateAfter);
            expect(impliedRateAfter).to.be.above(tradeImpliedRate);
        });

        it("should return the spot exchange rate which converts to the last implied rate", async () => {
            await t.setupLiquidity(owner, 0.5, WeiPerEther.mul(100));

            // The rate will be calculated at the next block...
            const blockTime = await (await provider.getBlock("latest")).timestamp;
            const rateMantissa = await futureCash.INSTRUMENT_PRECISION();
            const periodSize = await futureCash.G_PERIOD_SIZE();
            const lastImpliedRate = (await futureCash.markets(maturities[0])).lastImpliedRate;
            const spotRate = (await futureCash.getRate(maturities[0]))[0];
            expect(Math.trunc(((spotRate - rateMantissa) * periodSize) / (maturities[0] - blockTime))).to.equal(
                lastImpliedRate
            );
        });

        it("should revert if too much dai is taken", async () => {
            await t.setupLiquidity(owner, 0.5, WeiPerEther.mul(100));

            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
            // At 85 future cash the exchange rate explodes and gets too expensive.
            expect(await futureCash.getFutureCashToCollateral(maturities[0], WeiPerEther.mul(85))).to.equal(0);
            await expect(
                futureCash
                    .connect(wallet)
                    .takeCollateral(maturities[0], WeiPerEther.mul(85), BLOCK_TIME_LIMIT, 60_000_000)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_LACK_OF_LIQUIDITY));
        });

        it("should revert if too much future cash is taken", async () => {
            await t.setupLiquidity(owner, 0.5, WeiPerEther.mul(100));

            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
            expect(await futureCash.getCollateralToFutureCash(maturities[0], WeiPerEther.mul(100))).to.equal(0);
            await expect(
                futureCash
                    .connect(wallet)
                    .takeFutureCash(maturities[0], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, 40_000_000)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_LACK_OF_LIQUIDITY));
        });

        it("should revert if a block limit is hit when taking dai", async () => {
            await t.setupLiquidity();

            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
            let block = await provider.getBlock("latest");
            await expect(
                futureCash
                    .connect(wallet)
                    .takeCollateral(maturities[0], WeiPerEther.mul(200), block.timestamp - 1, 60_000_000)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_MAX_TIME));
        });

        it("should revert if a block limit is hit when taking future cash", async () => {
            await t.setupLiquidity();

            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
            let block = await provider.getBlock("latest");
            await expect(
                futureCash
                    .connect(wallet)
                    .takeFutureCash(maturities[0], WeiPerEther.mul(200), block.timestamp - 1, 40_000_000)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_MAX_TIME));
        });

        it("should revert if a price limit is hit when taking dai", async () => {
            await t.setupLiquidity();

            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
            await expect(
                futureCash
                    .connect(wallet)
                    .takeCollateral(maturities[0], WeiPerEther.mul(200), BLOCK_TIME_LIMIT, 40_000_000)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_SLIPPAGE));
        });

        it("should revert if a price limit is hit when taking future cash", async () => {
            await t.setupLiquidity();

            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(1000));
            await expect(
                futureCash
                    .connect(wallet)
                    .takeFutureCash(maturities[0], WeiPerEther.mul(200), BLOCK_TIME_LIMIT, 60_000_000)
            ).to.be.revertedWith(ErrorDecoder.encodeError(ErrorCodes.TRADE_FAILED_SLIPPAGE));
        });

        it("returns a rate of 1 for past maturities", async () => {
            expect(await futureCash.getRate(40)).to.eql([1e9, true]);
        });

        it("returns market rates", async () => {
            await t.setupLiquidity(owner, 0.5, WeiPerEther.mul(10), [0, 1, 2]);
            expect(await futureCash.getMarketRates()).to.have.lengthOf(4);
        });
    });

    describe("transaction fees", async () => {
        it("should not charge transaction fees for adding and removing liquidity", async () => {
            await escrow.setReserveAccount(wallet2.address);
            await futureCash.setFee(10_000, 10_000);

            await t.setupLiquidity();
            // No fees for liquidity
            expect(await escrow.currencyBalances(dai.address, wallet2.address)).to.equal(0);

            await futureCash.removeLiquidity(maturities[0], WeiPerEther.mul(5000), BLOCK_TIME_LIMIT);
            // No fees for liquidity
            expect(await escrow.currencyBalances(dai.address, wallet2.address)).to.equal(0);
        });

        it("should allow transaction fees to be set and accrue to reserves for cash receiver", async () => {
            await escrow.setReserveAccount(wallet2.address);
            await futureCash.setFee(10_000, 10_000);

            await t.setupLiquidity();
            await escrow.connect(wallet).deposit(dai.address, WeiPerEther.mul(100));

            await futureCash.connect(wallet).takeFutureCash(maturities[0], WeiPerEther.mul(100), BLOCK_TIME_LIMIT, 0);
            const collateralAmount = WeiPerEther.mul(100).sub(
                await escrow.currencyBalances(dai.address, wallet.address)
            );
            expect(await escrow.currencyBalances(dai.address, wallet2.address)).to.equal(
                collateralAmount.mul(10_000).div(WeiPerEther)
            );
        });

        it("should allow transaction fees to be set and accrue to reserves for cash payer", async () => {
            await escrow.setReserveAccount(wallet2.address);
            await futureCash.setFee(10_000, 10_000);

            await t.setupLiquidity();
            const [, collateral] = await t.borrowAndWithdraw(wallet, WeiPerEther.mul(100), 1.5, 0, 70_000_000);

            expect(await escrow.currencyBalances(dai.address, wallet2.address)).to.equal(
                collateral.mul(10_000).div(WeiPerEther)
            );
        });
    });
});
