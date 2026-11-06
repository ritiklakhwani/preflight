// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CaplineVault} from "../src/CaplineVault.sol";

/// Env: DEPLOYER_PRIVATE_KEY (the funder), VAULT, AGENT, QX, QY, TOKEN, AMOUNT (base units).
/// VAULT falls back to CAPLINE_VAULT_WHITECHAIN.
/// forge script script/Register.s.sol --rpc-url whitechain_sepolia --broadcast
contract Register is Script {
    using SafeERC20 for IERC20;

    function run() external {
        CaplineVault vault = CaplineVault(vm.envOr("VAULT", vm.envOr("CAPLINE_VAULT_WHITECHAIN", address(0))));
        require(address(vault) != address(0), "set VAULT or CAPLINE_VAULT_WHITECHAIN");
        address agent = vm.envAddress("AGENT");
        bytes32 qx = vm.envBytes32("QX");
        bytes32 qy = vm.envBytes32("QY");
        IERC20 token = IERC20(vm.envAddress("TOKEN"));
        uint256 amount = vm.envUint("AMOUNT");

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        // forceApprove handles USDT-style tokens that reject non-zero to non-zero approvals
        token.forceApprove(address(vault), amount);
        vault.register(agent, qx, qy, address(token), amount);
        vm.stopBroadcast();

        console2.log("registered agent", agent);
        console2.log("amount", amount);
    }
}
