// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ArcFXRemittance.sol";
import "../MockERC20.sol";

contract User {
    function approve(MockStablecoin token, address spender, uint256 amount) external {
        token.approve(spender, amount);
    }

    function remit(
        ArcFXRemittance pool,
        address fromToken,
        address toToken,
        uint256 amount,
        uint256 minOut,
        uint256 deadline,
        address recipient
    ) external returns (uint256) {
        return pool.swapAndRemit(fromToken, toToken, amount, minOut, deadline, recipient);
    }

    function setRate(ArcFXRemittance pool, uint256 rate) external {
        pool.setEurcToUsdcRate(rate);
    }
}

contract ArcFXRemittanceTest {
    MockStablecoin private usdc;
    MockStablecoin private eurc;
    ArcFXRemittance private pool;
    User private user;
    User private recipient;

    uint256 private constant UNIT = 1e6;

    function setUp() public {
        usdc = new MockStablecoin("Mock USD Coin", "mUSDC", 6);
        eurc = new MockStablecoin("Mock Euro Coin", "mEURC", 6);
        pool = new ArcFXRemittance(address(usdc), address(eurc), 1.08e18);
        user = new User();
        recipient = new User();

        usdc.mint(address(user), 1_000 * UNIT);
        eurc.approve(address(pool), 1_000 * UNIT);
        pool.addLiquidity(address(eurc), 1_000 * UNIT);
        user.approve(usdc, address(pool), type(uint256).max);
    }

    function testQuoteIncludesFee() public view {
        (uint256 amountOut, uint256 fee) =
            pool.getEstimatedOutput(address(usdc), address(eurc), 108 * UNIT);
        require(fee == 108_000, "wrong fee");
        require(amountOut == 99_900_000, "wrong output");
    }

    function testSwapTransfersExactQuotedAmount() public {
        (uint256 quote,) = pool.getEstimatedOutput(address(usdc), address(eurc), 108 * UNIT);
        uint256 returned = user.remit(
            pool,
            address(usdc),
            address(eurc),
            108 * UNIT,
            quote,
            block.timestamp,
            address(recipient)
        );
        require(returned == quote, "wrong return value");
        require(eurc.balanceOf(address(recipient)) == quote, "recipient underpaid");
        require(usdc.balanceOf(address(pool)) == 108 * UNIT, "input not received");
    }

    function testOnlyOwnerCanUpdateRate() public {
        (bool success,) = address(user).call(
            abi.encodeCall(User.setRate, (pool, 2e18))
        );
        require(!success, "non-owner changed rate");
    }

    function testSlippageProtection() public {
        (uint256 quote,) = pool.getEstimatedOutput(address(usdc), address(eurc), 108 * UNIT);
        (bool success,) = address(user).call(
            abi.encodeCall(
                User.remit,
                (pool, address(usdc), address(eurc), 108 * UNIT, quote + 1, block.timestamp, address(recipient))
            )
        );
        require(!success, "minAmountOut ignored");
    }

    function testExpiredTransactionReverts() public {
        (bool success,) = address(user).call(
            abi.encodeCall(
                User.remit,
                (pool, address(usdc), address(eurc), UNIT, 0, block.timestamp - 1, address(recipient))
            )
        );
        require(!success, "expired swap succeeded");
    }

    function testZeroRecipientReverts() public {
        (bool success,) = address(user).call(
            abi.encodeCall(
                User.remit,
                (pool, address(usdc), address(eurc), UNIT, 0, block.timestamp, address(0))
            )
        );
        require(!success, "zero recipient accepted");
    }
}
