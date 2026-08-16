// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/**
 * @title ArcFXRemittance
 * @notice Fixed-rate USDC/EURC remittance pool for Arc Testnet.
 * @dev Both configured stablecoins are expected to use the same decimals.
 */
contract ArcFXRemittance {
    address public immutable owner;
    address public immutable usdcToken;
    address public immutable eurcToken;

    uint256 public eurcToUsdcRate;
    uint256 public constant FEE_BASIS_POINTS = 10;
    uint256 public constant BP_DENOMINATOR = 10_000;

    uint256 private _locked = 1;

    event RemittanceExecuted(
        address indexed sender,
        address indexed recipient,
        address indexed fromToken,
        address toToken,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );
    event RateUpdated(uint256 oldRate, uint256 newRate);
    event LiquidityAdded(address indexed token, address indexed provider, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "ArcFX: only owner");
        _;
    }

    modifier nonReentrant() {
        require(_locked == 1, "ArcFX: reentrant call");
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address _usdcToken, address _eurcToken, uint256 _initialRate) {
        require(_usdcToken != address(0) && _eurcToken != address(0), "ArcFX: zero token");
        require(_usdcToken != _eurcToken, "ArcFX: identical tokens");
        require(_usdcToken.code.length > 0 && _eurcToken.code.length > 0, "ArcFX: token not contract");
        require(_initialRate > 0, "ArcFX: zero rate");

        owner = msg.sender;
        usdcToken = _usdcToken;
        eurcToken = _eurcToken;
        eurcToUsdcRate = _initialRate;
    }

    function setEurcToUsdcRate(uint256 newRate) external onlyOwner {
        require(newRate > 0, "ArcFX: zero rate");
        uint256 oldRate = eurcToUsdcRate;
        eurcToUsdcRate = newRate;
        emit RateUpdated(oldRate, newRate);
    }

    function getEstimatedOutput(address fromToken, address toToken, uint256 amountIn)
        public
        view
        returns (uint256 amountOut, uint256 fee)
    {
        _requireSupportedPair(fromToken, toToken);
        require(amountIn > 0, "ArcFX: zero amount");

        fee = (amountIn * FEE_BASIS_POINTS) / BP_DENOMINATOR;
        uint256 netAmountIn = amountIn - fee;
        if (fromToken == eurcToken) {
            amountOut = (netAmountIn * eurcToUsdcRate) / 1e18;
        } else {
            amountOut = (netAmountIn * 1e18) / eurcToUsdcRate;
        }
        require(amountOut > 0, "ArcFX: output rounds to zero");
    }

    /**
     * @param minAmountOut Revert if the owner-updated rate or rounding returns less.
     * @param deadline Unix timestamp after which the signed transaction is invalid.
     */
    function swapAndRemit(
        address fromToken,
        address toToken,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline,
        address recipient
    ) external nonReentrant returns (uint256 amountOut) {
        require(block.timestamp <= deadline, "ArcFX: expired");
        require(recipient != address(0), "ArcFX: zero recipient");

        uint256 fee;
        (amountOut, fee) = getEstimatedOutput(fromToken, toToken, amountIn);
        require(amountOut >= minAmountOut, "ArcFX: slippage");
        require(IERC20(toToken).balanceOf(address(this)) >= amountOut, "ArcFX: insufficient liquidity");

        uint256 balanceBefore = IERC20(fromToken).balanceOf(address(this));
        _safeTransferFrom(fromToken, msg.sender, address(this), amountIn);
        require(
            IERC20(fromToken).balanceOf(address(this)) - balanceBefore == amountIn,
            "ArcFX: fee-on-transfer unsupported"
        );
        _safeTransfer(toToken, recipient, amountOut);

        emit RemittanceExecuted(msg.sender, recipient, fromToken, toToken, amountIn, amountOut, fee);
    }

    function addLiquidity(address token, uint256 amount) external nonReentrant {
        require(token == usdcToken || token == eurcToken, "ArcFX: invalid token");
        require(amount > 0, "ArcFX: zero amount");
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        _safeTransferFrom(token, msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        require(received > 0, "ArcFX: no tokens received");
        emit LiquidityAdded(token, msg.sender, received);
    }

    function _requireSupportedPair(address fromToken, address toToken) private view {
        require(
            (fromToken == usdcToken && toToken == eurcToken)
                || (fromToken == eurcToken && toToken == usdcToken),
            "ArcFX: unsupported pair"
        );
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool success, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "ArcFX: transfer failed");
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool success, bytes memory data) =
            token.call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "ArcFX: transferFrom failed");
    }
}
