// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {PartnerSink} from "../src/demo/PartnerSink.sol";

/// Deploy right before the demo and do NOT verify it: it must look fresh and unverified.
/// forge script script/DeployPartnerSink.s.sol --rpc-url whitechain_sepolia --broadcast
contract DeployPartnerSink is Script {
    function run() external returns (PartnerSink sink) {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        sink = new PartnerSink();
        vm.stopBroadcast();
        console2.log("PartnerSink", address(sink));
    }
}
