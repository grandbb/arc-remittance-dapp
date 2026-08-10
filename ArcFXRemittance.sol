// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ArcFXRemittance
 * @notice Cross-Border FX & Instant Remittance Protocol on Arc Testnet
 * @dev Optimized for sub-second, low-cost cross-border stablecoin remittance (USDC <-> EURC).
 */

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract ArcFXRemittance {
    address public owner;
    
    // Stablecoin Addresses on Arc Testnet
    address public usdcToken;
    address public eurcToken;
    
    // FX Rate: 1 EURC in USDC (Precision: 1e18)
    // Default: 1 EURC = 1.08 USDC (1.08 * 1e18)
    uint256 public eurcToUsdcRate; 
    
    // Protocol Fee in Basis Points (10 BP = 0.1%)
    uint256 public feeBasisPoints = 10;
    uint256 public constant BP_DENOMINATOR = 10000;

    event RemittanceExecuted(
        address indexed sender,
        address indexed recipient,
        address indexed fromToken,
        address toToken,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );

    event RateUpdated(uint256 newRate);
    event LiquidityAdded(address indexed token, address indexed provider, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "ArcFX: Only owner");
        _;
    }

    constructor(address _usdcToken, address _eurcToken, uint256 _initialEurcToUsdcRate) {
        require(_usdcToken != address(0) && _eurcToken != address(0), "ArcFX: Invalid token address");
        owner = msg.sender;
        usdcToken = _usdcToken;
        eurcToken = _eurcToken;
        eurcToUsdcRate = _initialEurcToUsdcRate;
    }

    /**
     * @notice Set exchange rate (1 EURC = rate USDC / 1e18)
     */
    function setEurcToUsdcRate(uint256 _rate) external onlyOwner {
        require(_rate > 0, "ArcFX: Rate must be > 0");
        eurcToUsdcRate = _rate;
        emit RateUpdated(_rate);
    }

    /**
     * @notice Calculate estimated output amount and protocol fee
     */
    function getEstimatedOutput(address fromToken, address toToken, uint256 amountIn) 
        public 
        view 
        returns (uint256 amountOut, uint256 fee) 
    {
        require(
            (fromToken == usdcToken && toToken == eurcToken) || 
            (fromToken == eurcToken && toToken == usdcToken),
            "ArcFX: Unsupported token pair"
        );

        fee = (amountIn * feeBasisPoints) / BP_DENOMINATOR;
        uint256 netAmountIn = amountIn - fee;

        if (fromToken == eurcToken && toToken == usdcToken) {
            // EURC -> USDC
            amountOut = (netAmountIn * eurcToUsdcRate) / 1e18;
        } else {
            // USDC -> EURC
            amountOut = (netAmountIn * 1e18) / eurcToUsdcRate;
        }
    }

    /**
     * @notice Swap tokens and remit directly to recipient on Arc Network
     */
    function swapAndRemit(
        address fromToken,
        address toToken,
        uint256 amountIn,
        address recipient
    ) external returns (uint256 amountOut) {
        require(recipient != address(0), "ArcFX: Invalid recipient");
        require(amountIn > 0, "ArcFX: Amount must be > 0");

        uint256 fee;
        (amountOut, fee) = getEstimatedOutput(fromToken, toToken, amountIn);

        require(
            IERC20(toToken).balanceOf(address(this)) >= amountOut,
            "ArcFX: Insufficient liquidity in pool"
        );

        // 1. Pull funds from sender
        require(
            IERC20(fromToken).transferFrom(msg.sender, address(this), amountIn),
            "ArcFX: Transfer from sender failed"
        );

        // 2. Deliver converted funds instantly to recipient wallet
        require(
            IERC20(toToken).transfer(recipient, amountOut),
            "ArcFX: Delivery to recipient failed"
        );

        emit RemittanceExecuted(
            msg.sender,
            recipient,
            fromToken,
            toToken,
            amountIn,
            amountOut,
            fee
        );
    }

    /**
     * @notice Add liquidity to the remittance pool
     */
    function addLiquidity(address token, uint256 amount) external {
        require(token == usdcToken || token == eurcToken, "ArcFX: Invalid token");
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "ArcFX: Transfer failed");
        emit LiquidityAdded(token, msg.sender, amount);
    }
}
