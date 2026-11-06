// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CaplineVault} from "../src/CaplineVault.sol";

/// forge script script/Deploy.s.sol --rpc-url whitechain_sepolia --broadcast
contract Deploy is Script {
    function run() external returns (CaplineVault vault) {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        vault = new CaplineVault();
        vm.stopBroadcast();
        console2.log("CaplineVault", address(vault));
        console2.log("chainId", block.chainid);
    }
}
