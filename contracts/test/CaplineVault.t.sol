// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {CaplineVault} from "../src/CaplineVault.sol";
import {PartnerSink} from "../src/demo/PartnerSink.sol";

contract MockUSDT is ERC20 {
    constructor() ERC20("Mock USDT", "USDT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Takes 1% on every transfer, to check the vault credits what actually arrived.
contract FeeToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) return super._update(from, to, value);
        uint256 fee = value / 100;
        super._update(from, address(0xFEE), fee);
        super._update(from, to, value - fee);
    }
}

contract CaplineVaultTest is Test {
    uint256 constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    uint256 constant OWNER_PK = 0xA11CE;
    uint256 constant OTHER_PK = 0xB0B;

    CaplineVault vault;
    MockUSDT usdt;
    address funder = makeAddr("funder");
    address agent = makeAddr("agent");
    address relayer = makeAddr("relayer");
    bytes32 qx;
    bytes32 qy;

    function setUp() public {
        vault = new CaplineVault();
        usdt = new MockUSDT();
        (uint256 x, uint256 y) = vm.publicKeyP256(OWNER_PK);
        (qx, qy) = (bytes32(x), bytes32(y));
        usdt.mint(funder, 1_000e6);
        vm.prank(funder);
        usdt.approve(address(vault), type(uint256).max);
        vm.warp(1_700_000_000);
        vm.roll(100);
    }

    // ------------------------------------------------------------ WebAuthn helpers

    /// Builds an assertion exactly as a browser would for `navigator.credentials.get`.
    function _sign(uint256 pk, bytes32 digest, bytes1 flags) internal pure returns (WebAuthn.WebAuthnAuth memory auth) {
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"https://example.com","crossOrigin":false}'
        );
        bytes memory authenticatorData = abi.encodePacked(sha256("example.com"), flags, uint32(0));
        bytes32 h = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, h);
        // OZ P256 rejects high-s, browsers emit either
        if (uint256(s) > N / 2) s = bytes32(N - uint256(s));
        auth = WebAuthn.WebAuthnAuth({
            r: r,
            s: s,
            challengeIndex: 23, // after {"type":"webauthn.get",
            typeIndex: 1,
            authenticatorData: authenticatorData,
            clientDataJSON: clientDataJSON
        });
    }

    function _sign(bytes32 digest) internal pure returns (WebAuthn.WebAuthnAuth memory) {
        return _sign(OWNER_PK, digest, 0x05); // UP | UV
    }

    function _register(uint256 amount) internal {
        vm.prank(funder);
        vault.register(agent, qx, qy, address(usdt), amount);
    }

    function _release(uint256 amount, uint64 expiry, bytes32 rh) internal {
        CaplineVault.Agent memory a = vault.getAgent(agent);
        WebAuthn.WebAuthnAuth memory auth = _sign(vault.releaseDigest(agent, amount, a.nonce, expiry, rh));
        vm.prank(relayer);
        vault.release(agent, amount, expiry, rh, auth);
    }

    function _drop() internal {
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory auth = _sign(vault.dropDigest(agent, vault.getAgent(agent).nonce, expiry));
        vault.drop(agent, expiry, auth);
    }

    // ------------------------------------------------------------ register / deposit

    function test_register() public {
        vm.expectEmit(true, true, false, true);
        emit CaplineVault.Registered(agent, address(usdt), qx, qy, 100e6);
        _register(100e6);

        CaplineVault.Agent memory a = vault.getAgent(agent);
        assertEq(a.qx, qx);
        assertEq(a.qy, qy);
        assertEq(a.token, address(usdt));
        assertEq(a.balance, 100e6);
        assertEq(a.nonce, 0);
        assertFalse(a.dropped);
        assertEq(a.lastReleaseBlock, block.number);
        assertEq(usdt.balanceOf(address(vault)), 100e6);
        assertEq(abi.encode(vault.agents(agent)), abi.encode(a));
    }

    function test_register_AlreadyRegistered() public {
        _register(10e6);
        vm.prank(funder);
        vm.expectRevert(CaplineVault.AlreadyRegistered.selector);
        vault.register(agent, qx, qy, address(usdt), 10e6);
    }

    function test_deposit() public {
        _register(10e6);
        vm.prank(funder);
        vault.deposit(agent, 5e6);
        assertEq(vault.getAgent(agent).balance, 15e6);
    }

    function test_deposit_UnknownAgent() public {
        vm.prank(funder);
        vm.expectRevert(CaplineVault.UnknownAgent.selector);
        vault.deposit(agent, 5e6);
    }

    // ------------------------------------------------------------ release

    function test_release_happyPath() public {
        _register(100e6);
        vm.roll(200);
        uint64 expiry = uint64(block.timestamp + 900);
        bytes32 rh = keccak256("[]");

        WebAuthn.WebAuthnAuth memory auth = _sign(vault.releaseDigest(agent, 5e6, 0, expiry, rh));
        vm.expectEmit(true, false, false, true);
        emit CaplineVault.Released(agent, 5e6, 0, rh);
        vm.prank(relayer);
        uint256 g = gasleft();
        vault.release(agent, 5e6, expiry, rh, auth);
        emit log_named_uint("release gas", g - gasleft());

        CaplineVault.Agent memory a = vault.getAgent(agent);
        assertEq(usdt.balanceOf(agent), 5e6);
        assertEq(a.balance, 95e6);
        assertEq(a.nonce, 1);
        assertEq(a.lastReleaseBlock, 200);
        assertEq(a.lastReceiptsHash, rh);
    }

    function test_release_replayReverts() public {
        _register(100e6);
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory auth = _sign(vault.releaseDigest(agent, 5e6, 0, expiry, 0));
        vault.release(agent, 5e6, expiry, 0, auth);
        vm.expectRevert(CaplineVault.BadSignature.selector);
        vault.release(agent, 5e6, expiry, 0, auth);
    }

    function test_release_expired() public {
        _register(100e6);
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory auth = _sign(vault.releaseDigest(agent, 5e6, 0, expiry, 0));
        vm.warp(expiry + 1);
        vm.expectRevert(CaplineVault.Expired.selector);
        vault.release(agent, 5e6, expiry, 0, auth);
    }

    function test_release_wrongKey() public {
        _register(100e6);
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory auth = _sign(OTHER_PK, vault.releaseDigest(agent, 5e6, 0, expiry, 0), 0x05);
        vm.expectRevert(CaplineVault.BadSignature.selector);
        vault.release(agent, 5e6, expiry, 0, auth);
    }

    function test_release_withoutUserVerification() public {
        _register(100e6);
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory auth = _sign(OWNER_PK, vault.releaseDigest(agent, 5e6, 0, expiry, 0), 0x01);
        vm.expectRevert(CaplineVault.BadSignature.selector);
        vault.release(agent, 5e6, expiry, 0, auth);
    }

    function test_release_tamperedAmount() public {
        _register(100e6);
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory auth = _sign(vault.releaseDigest(agent, 5e6, 0, expiry, 0));
        vm.expectRevert(CaplineVault.BadSignature.selector);
        vault.release(agent, 50e6, expiry, 0, auth);
    }

    function test_release_agentWithGarbageAuth() public {
        _register(100e6);
        WebAuthn.WebAuthnAuth memory auth = WebAuthn.WebAuthnAuth({
            r: bytes32(uint256(1)),
            s: bytes32(uint256(1)),
            challengeIndex: 0,
            typeIndex: 0,
            authenticatorData: hex"00",
            clientDataJSON: "garbage"
        });
        vm.prank(agent);
        vm.expectRevert(CaplineVault.BadSignature.selector);
        vault.release(agent, 5e6, uint64(block.timestamp + 900), 0, auth);
    }

    function test_release_insufficientBalance() public {
        _register(10e6);
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory auth = _sign(vault.releaseDigest(agent, 11e6, 0, expiry, 0));
        vm.expectRevert(CaplineVault.InsufficientBalance.selector);
        vault.release(agent, 11e6, expiry, 0, auth);
    }

    function test_release_UnknownAgent() public {
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory auth = _sign(vault.releaseDigest(agent, 1, 0, expiry, 0));
        vm.expectRevert(CaplineVault.UnknownAgent.selector);
        vault.release(agent, 1, expiry, 0, auth);
    }

    // ------------------------------------------------------------ drop / undrop

    function test_drop_thenReleaseReverts() public {
        _register(100e6);
        vm.expectEmit(true, false, false, true);
        emit CaplineVault.Dropped(agent, 0);
        _drop();
        assertTrue(vault.getAgent(agent).dropped);
        assertEq(vault.getAgent(agent).nonce, 1);

        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory auth = _sign(vault.releaseDigest(agent, 5e6, 1, expiry, 0));
        vm.expectRevert(CaplineVault.IsDropped.selector);
        vault.release(agent, 5e6, expiry, 0, auth);
    }

    function test_undrop_restores() public {
        _register(100e6);
        _drop();
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory auth = _sign(vault.undropDigest(agent, 1, expiry));
        vm.expectEmit(true, false, false, true);
        emit CaplineVault.Undropped(agent, 1);
        vault.undrop(agent, expiry, auth);
        assertFalse(vault.getAgent(agent).dropped);

        _release(5e6, expiry, bytes32(uint256(7)));
        assertEq(usdt.balanceOf(agent), 5e6);
        assertEq(vault.getAgent(agent).nonce, 3);
    }

    function test_drop_badSignature() public {
        _register(100e6);
        uint64 expiry = uint64(block.timestamp + 900);
        // a release signature must not double as a drop
        WebAuthn.WebAuthnAuth memory auth = _sign(vault.releaseDigest(agent, 0, 0, expiry, 0));
        vm.expectRevert(CaplineVault.BadSignature.selector);
        vault.drop(agent, expiry, auth);
    }

    // ------------------------------------------------------------ withdraw

    function test_withdraw() public {
        _register(100e6);
        _drop(); // withdraw still works while dropped
        address to = makeAddr("cold");
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory auth = _sign(vault.withdrawDigest(agent, to, 60e6, 1, expiry));
        vm.expectEmit(true, true, false, true);
        emit CaplineVault.Withdrawn(agent, to, 60e6, 1);
        vault.withdraw(agent, to, 60e6, expiry, auth);
        assertEq(usdt.balanceOf(to), 60e6);
        assertEq(vault.getAgent(agent).balance, 40e6);
        assertEq(vault.getAgent(agent).nonce, 2);
    }

    function test_withdraw_redirectedRecipientReverts() public {
        _register(100e6);
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory auth = _sign(vault.withdrawDigest(agent, makeAddr("cold"), 60e6, 0, expiry));
        vm.expectRevert(CaplineVault.BadSignature.selector);
        vault.withdraw(agent, makeAddr("thief"), 60e6, expiry, auth);
    }

    function test_withdraw_insufficientBalance() public {
        _register(10e6);
        address to = makeAddr("cold");
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory auth = _sign(vault.withdrawDigest(agent, to, 11e6, 0, expiry));
        vm.expectRevert(CaplineVault.InsufficientBalance.selector);
        vault.withdraw(agent, to, 11e6, expiry, auth);
    }

    // ------------------------------------------------------------ security properties

    function test_feeOnTransfer_creditsWhatArrived() public {
        FeeToken fee = new FeeToken();
        fee.mint(funder, 110e6);
        vm.startPrank(funder);
        fee.approve(address(vault), type(uint256).max);
        vault.register(agent, qx, qy, address(fee), 100e6);
        vault.deposit(agent, 10e6);
        vm.stopPrank();
        // 1% lost on each pull: the vault can never owe more than it holds
        assertEq(vault.getAgent(agent).balance, 99e6 + 9.9e6);
        assertEq(fee.balanceOf(address(vault)), vault.getAgent(agent).balance);
    }

    function test_release_highSRejected() public {
        _register(100e6);
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory auth = _sign(vault.releaseDigest(agent, 5e6, 0, expiry, 0));
        auth.s = bytes32(N - uint256(auth.s)); // same signature, malleated
        vm.expectRevert(CaplineVault.BadSignature.selector);
        vault.release(agent, 5e6, expiry, 0, auth);
    }

    function test_dropSignatureIsNotAnUndrop() public {
        _register(100e6);
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory auth = _sign(vault.dropDigest(agent, 0, expiry));
        vm.expectRevert(CaplineVault.BadSignature.selector);
        vault.undrop(agent, expiry, auth);
    }

    function test_release_otherVaultSignatureRejected() public {
        CaplineVault other = new CaplineVault();
        _register(100e6);
        vm.startPrank(funder);
        usdt.approve(address(other), 100e6);
        other.register(agent, qx, qy, address(usdt), 100e6);
        vm.stopPrank();
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory auth = _sign(other.releaseDigest(agent, 5e6, 0, expiry, 0));
        vm.expectRevert(CaplineVault.BadSignature.selector);
        vault.release(agent, 5e6, expiry, 0, auth);
    }

    function test_drop_invalidatesOutstandingRelease() public {
        _register(100e6);
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory rel = _sign(vault.releaseDigest(agent, 5e6, 0, expiry, 0));
        _drop();
        uint64 e2 = uint64(block.timestamp + 900);
        vault.undrop(agent, e2, _sign(vault.undropDigest(agent, 1, e2)));
        // the release signed before the drop is dead even after undrop
        vm.expectRevert(CaplineVault.BadSignature.selector);
        vault.release(agent, 5e6, expiry, 0, rel);
    }

    /// Documents why the phone must check the request nonce against the chain:
    /// the vault accepts a signature for any future nonce once the counter gets
    /// there, including after a drop and undrop.
    function test_futureNonceSignature_landsLater() public {
        _register(100e6);
        uint64 expiry = uint64(block.timestamp + 900);
        WebAuthn.WebAuthnAuth memory rel = _sign(vault.releaseDigest(agent, 5e6, 2, expiry, 0));
        vm.expectRevert(CaplineVault.BadSignature.selector);
        vault.release(agent, 5e6, expiry, 0, rel);
        _drop();
        vault.undrop(agent, expiry, _sign(vault.undropDigest(agent, 1, expiry)));
        vault.release(agent, 5e6, expiry, 0, rel);
        assertEq(usdt.balanceOf(agent), 5e6);
    }

    /// Documents the squatting property: registration is first come, first
    /// served, and binds whatever passkey the caller names. The squatter gains
    /// nothing the owner put in unless someone later deposits to that slot.
    function test_register_squatBlocksOwner() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(OTHER_PK);
        vm.prank(makeAddr("squatter"));
        vault.register(agent, bytes32(x), bytes32(y), address(usdt), 0);
        vm.prank(funder);
        vm.expectRevert(CaplineVault.AlreadyRegistered.selector);
        vault.register(agent, qx, qy, address(usdt), 10e6);
        assertEq(usdt.balanceOf(address(vault)), 0);
    }

    // ------------------------------------------------------------ digests and demo sink

    function test_digestMatchesEip712() public view {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("CaplineVault"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Release(address agent,uint256 amount,uint64 nonce,uint64 expiry,bytes32 receiptsHash)"),
                agent,
                uint256(5e6),
                uint64(3),
                uint64(1234),
                bytes32(uint256(9))
            )
        );
        assertEq(
            vault.releaseDigest(agent, 5e6, 3, 1234, bytes32(uint256(9))),
            keccak256(abi.encodePacked(hex"1901", domain, structHash))
        );
    }

    function test_partnerSink() public {
        address deployer = makeAddr("deployer");
        vm.prank(deployer);
        PartnerSink sink = new PartnerSink();
        usdt.mint(address(sink), 7e6);
        vm.expectRevert(PartnerSink.NotDeployer.selector);
        sink.sweep(usdt, agent);
        vm.prank(deployer);
        sink.sweep(usdt, deployer);
        assertEq(usdt.balanceOf(deployer), 7e6);
    }
}
