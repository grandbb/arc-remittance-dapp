// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

/// @title ArcFXRemittance
/// @notice Owner-operated USDC/EURC inventory pool for atomic swaps and remittance on Arc.
/// @dev The owner is responsible for publishing a current exchange rate and maintaining liquidity.
contract ArcFXRemittance {
    uint256 public constant BP_DENOMINATOR = 10_000;
    uint256 public constant MAX_FEE_BASIS_POINTS = 100;
    uint256 public constant MIN_RATE_AGE = 5 minutes;
    uint256 public constant MAX_RATE_AGE = 24 hours;

    address public owner;
    address public pendingOwner;
    address public immutable usdcToken;
    address public immutable eurcToken;

    // 1 EURC expressed in USDC, with 18-decimal precision.
    uint256 public eurcToUsdcRate;
    uint256 public rateUpdatedAt;
    uint256 public maxRateAge = 1 hours;
    uint256 public feeBasisPoints = 10;
    bool public paused = true;

    uint256 private _reentrancyStatus = 1;

    event RemittanceExecuted(
        address indexed sender,
        address indexed recipient,
        address indexed fromToken,
        address toToken,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );
    event RateUpdated(uint256 newRate, uint256 updatedAt);
    event MaxRateAgeUpdated(uint256 newMaxRateAge);
    event FeeUpdated(uint256 newFeeBasisPoints);
    event PauseUpdated(bool paused);
    event LiquidityAdded(address indexed token, uint256 amount);
    event LiquidityWithdrawn(address indexed token, address indexed recipient, uint256 amount);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "ArcFX: Only owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "ArcFX: Paused");
        _;
    }

    modifier nonReentrant() {
        require(_reentrancyStatus == 1, "ArcFX: Reentrant call");
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }

    constructor(address _usdcToken, address _eurcToken, uint256 _initialEurcToUsdcRate) {
        require(_usdcToken != address(0) && _eurcToken != address(0), "ArcFX: Invalid token address");
        require(_usdcToken != _eurcToken, "ArcFX: Tokens must differ");
        require(_usdcToken.code.length > 0 && _eurcToken.code.length > 0, "ArcFX: Token is not a contract");
        require(_initialEurcToUsdcRate > 0, "ArcFX: Rate must be > 0");

        owner = msg.sender;
        usdcToken = _usdcToken;
        eurcToken = _eurcToken;
        eurcToUsdcRate = _initialEurcToUsdcRate;
        rateUpdatedAt = block.timestamp;
        emit OwnershipTransferred(address(0), msg.sender);
        emit RateUpdated(_initialEurcToUsdcRate, block.timestamp);
        emit PauseUpdated(true);
    }

    function setEurcToUsdcRate(uint256 newRate) external onlyOwner {
        require(newRate > 0, "ArcFX: Rate must be > 0");
        eurcToUsdcRate = newRate;
        rateUpdatedAt = block.timestamp;
        emit RateUpdated(newRate, block.timestamp);
    }

    function setMaxRateAge(uint256 newMaxRateAge) external onlyOwner {
        require(newMaxRateAge >= MIN_RATE_AGE && newMaxRateAge <= MAX_RATE_AGE, "ArcFX: Invalid rate age");
        maxRateAge = newMaxRateAge;
        emit MaxRateAgeUpdated(newMaxRateAge);
    }

    function setFeeBasisPoints(uint256 newFeeBasisPoints) external onlyOwner {
        require(newFeeBasisPoints <= MAX_FEE_BASIS_POINTS, "ArcFX: Fee too high");
        feeBasisPoints = newFeeBasisPoints;
        emit FeeUpdated(newFeeBasisPoints);
    }

    function setPaused(bool newPaused) external onlyOwner {
        paused = newPaused;
        emit PauseUpdated(newPaused);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ArcFX: Invalid owner");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "ArcFX: Not pending owner");
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }

    function isRateFresh() public view returns (bool) {
        return block.timestamp <= rateUpdatedAt + maxRateAge;
    }

    function getEstimatedOutput(address fromToken, address toToken, uint256 amountIn)
        public
        view
        returns (uint256 amountOut, uint256 fee)
    {
        _requireSupportedPair(fromToken, toToken);
        require(!paused, "ArcFX: Paused");
        require(isRateFresh(), "ArcFX: Rate is stale");
        require(amountIn > 0, "ArcFX: Amount must be > 0");

        fee = (amountIn * feeBasisPoints) / BP_DENOMINATOR;
        uint256 netAmountIn = amountIn - fee;
        if (fromToken == eurcToken) {
            amountOut = (netAmountIn * eurcToUsdcRate) / 1e18;
        } else {
            amountOut = (netAmountIn * 1e18) / eurcToUsdcRate;
        }
        require(amountOut > 0, "ArcFX: Output rounds to zero");
    }

    function swapAndRemit(
        address fromToken,
        address toToken,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline,
        address recipient
    ) external whenNotPaused nonReentrant returns (uint256 amountOut) {
        require(recipient != address(0), "ArcFX: Invalid recipient");
        require(block.timestamp <= deadline, "ArcFX: Quote expired");
        require(minAmountOut > 0, "ArcFX: Invalid minimum output");

        uint256 fee;
        (amountOut, fee) = getEstimatedOutput(fromToken, toToken, amountIn);
        require(amountOut >= minAmountOut, "ArcFX: Slippage exceeded");
        require(IERC20(toToken).balanceOf(address(this)) >= amountOut, "ArcFX: Insufficient liquidity");

        uint256 inputBalanceBefore = IERC20(fromToken).balanceOf(address(this));
        _safeTransferFrom(fromToken, msg.sender, address(this), amountIn);
        require(
            IERC20(fromToken).balanceOf(address(this)) == inputBalanceBefore + amountIn,
            "ArcFX: Unsupported fee-on-transfer token"
        );
        _safeTransfer(toToken, recipient, amountOut);

        emit RemittanceExecuted(msg.sender, recipient, fromToken, toToken, amountIn, amountOut, fee);
    }

    function addLiquidity(address token, uint256 amount) external onlyOwner nonReentrant {
        _requireSupportedToken(token);
        require(amount > 0, "ArcFX: Amount must be > 0");
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        _safeTransferFrom(token, msg.sender, address(this), amount);
        require(IERC20(token).balanceOf(address(this)) == balanceBefore + amount, "ArcFX: Invalid token transfer");
        emit LiquidityAdded(token, amount);
    }

    function withdrawLiquidity(address token, address recipient, uint256 amount) external onlyOwner nonReentrant {
        _requireSupportedToken(token);
        require(paused, "ArcFX: Pause before withdrawal");
        require(recipient != address(0), "ArcFX: Invalid recipient");
        require(amount > 0, "ArcFX: Amount must be > 0");
        _safeTransfer(token, recipient, amount);
        emit LiquidityWithdrawn(token, recipient, amount);
    }

    function _requireSupportedPair(address fromToken, address toToken) private view {
        require(
            (fromToken == usdcToken && toToken == eurcToken) ||
                (fromToken == eurcToken && toToken == usdcToken),
            "ArcFX: Unsupported token pair"
        );
    }

    function _requireSupportedToken(address token) private view {
        require(token == usdcToken || token == eurcToken, "ArcFX: Invalid token");
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(bytes4(0xa9059cbb), to, amount));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "ArcFX: Transfer failed");
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(bytes4(0x23b872dd), from, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "ArcFX: Transfer from failed");
    }
}
