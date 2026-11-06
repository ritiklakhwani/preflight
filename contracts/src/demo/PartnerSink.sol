// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Demo only. Plays a fresh, unverified "partner" that a hijacked agent is tricked
/// into paying. Plain ERC-20 transfers land here; the deployer can sweep them back.
contract PartnerSink {
    using SafeERC20 for IERC20;

    address public immutable deployer = msg.sender;

    error NotDeployer();

    function sweep(IERC20 token, address to) external {
        if (msg.sender != deployer) revert NotDeployer();
        token.safeTransfer(to, token.balanceOf(address(this)));
    }
}
