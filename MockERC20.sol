// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockStablecoin
 * @notice Mock USDC and EURC tokens for local and Arc Testnet testing.
 */
contract MockStablecoin {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /**
     * @param _name Token name, for example "Mock USD Coin".
     * @param _symbol Token symbol, for example "mUSDC".
     * @param _decimals Token precision, usually 6 or 18 decimals.
     */
    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        
        // Mint 1,000,000 tokens to the deployer for testing.
        _mint(msg.sender, 1000000 * (10 ** uint256(_decimals)));
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ERC20: Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "ERC20: Insufficient balance");
        require(allowance[from][msg.sender] >= amount, "ERC20: Insufficient allowance");
        
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        
        emit Transfer(from, to, amount);
        return true;
    }

    /**
     * @notice Mint additional tokens to an address for testing.
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
}
