// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

/// @title CaplineVault
/// @notice Holds an owner's funds per agent and releases tranches to the agent wallet only
/// when the owner's passkey signs an EIP-712 approval. See docs/CAPLINE_SPEC.md.
contract CaplineVault is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Agent {
        bytes32 qx;
        bytes32 qy;
        address token;
        uint256 balance;
        uint64 nonce;
        bool dropped;
        uint64 lastReleaseBlock;
        bytes32 lastReceiptsHash;
    }

    bytes32 public constant RELEASE_TYPEHASH =
        keccak256("Release(address agent,uint256 amount,uint64 nonce,uint64 expiry,bytes32 receiptsHash)");
    bytes32 public constant DROP_TYPEHASH = keccak256("Drop(address agent,uint64 nonce,uint64 expiry)");
    bytes32 public constant UNDROP_TYPEHASH = keccak256("Undrop(address agent,uint64 nonce,uint64 expiry)");
    bytes32 public constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address agent,address to,uint256 amount,uint64 nonce,uint64 expiry)");

    mapping(address => Agent) private _agents;

    event Registered(address indexed agent, address indexed token, bytes32 qx, bytes32 qy, uint256 amount);
    event Deposited(address indexed agent, address indexed from, uint256 amount);
    event Released(address indexed agent, uint256 amount, uint64 nonce, bytes32 receiptsHash);
    event Dropped(address indexed agent, uint64 nonce);
    event Undropped(address indexed agent, uint64 nonce);
    event Withdrawn(address indexed agent, address indexed to, uint256 amount, uint64 nonce);

    error AlreadyRegistered();
    error UnknownAgent();
    error Expired();
    error BadSignature();
    error IsDropped();
    error InsufficientBalance();

    constructor() EIP712("CaplineVault", "1") {}

    // ---------------------------------------------------------------- setup

    function register(address agent, bytes32 qx, bytes32 qy, address token, uint256 amount) external nonReentrant {
        Agent storage a = _agents[agent];
        // token doubles as the "exists" flag; a zero token would fail the transfer below anyway
        if (a.token != address(0)) revert AlreadyRegistered();
        a.qx = qx;
        a.qy = qy;
        a.token = token;
        // forge-lint: disable-next-line(unsafe-typecast)
        a.lastReleaseBlock = uint64(block.number);
        // balance is credited by what actually arrived, so fee-on-transfer tokens cannot overdraw
        a.balance = _pull(token, amount);
        emit Registered(agent, token, qx, qy, amount);
    }

    function deposit(address agent, uint256 amount) external nonReentrant {
        Agent storage a = _known(agent);
        a.balance += _pull(a.token, amount);
        emit Deposited(agent, msg.sender, amount);
    }

    // ---------------------------------------------------------------- owner-signed actions

    function release(
        address agent,
        uint256 amount,
        uint64 expiry,
        bytes32 receiptsHash,
        WebAuthn.WebAuthnAuth calldata auth
    ) external nonReentrant {
        Agent storage a = _known(agent);
        _notExpired(expiry);
        if (a.dropped) revert IsDropped();
        uint64 nonce = a.nonce;
        _verify(a, releaseDigest(agent, amount, nonce, expiry, receiptsHash), auth);
        if (amount > a.balance) revert InsufficientBalance();

        a.nonce = nonce + 1;
        a.balance -= amount;
        // forge-lint: disable-next-line(unsafe-typecast)
        a.lastReleaseBlock = uint64(block.number);
        a.lastReceiptsHash = receiptsHash;
        emit Released(agent, amount, nonce, receiptsHash);
        IERC20(a.token).safeTransfer(agent, amount);
    }

    function drop(address agent, uint64 expiry, WebAuthn.WebAuthnAuth calldata auth) external nonReentrant {
        Agent storage a = _known(agent);
        _notExpired(expiry);
        uint64 nonce = a.nonce;
        _verify(a, dropDigest(agent, nonce, expiry), auth);
        a.nonce = nonce + 1;
        a.dropped = true;
        emit Dropped(agent, nonce);
    }

    function undrop(address agent, uint64 expiry, WebAuthn.WebAuthnAuth calldata auth) external nonReentrant {
        Agent storage a = _known(agent);
        _notExpired(expiry);
        uint64 nonce = a.nonce;
        _verify(a, undropDigest(agent, nonce, expiry), auth);
        a.nonce = nonce + 1;
        a.dropped = false;
        emit Undropped(agent, nonce);
    }

    /// @dev Allowed while dropped: pulling funds out is the point of a kill switch.
    function withdraw(
        address agent,
        address to,
        uint256 amount,
        uint64 expiry,
        WebAuthn.WebAuthnAuth calldata auth
    ) external nonReentrant {
        Agent storage a = _known(agent);
        _notExpired(expiry);
        uint64 nonce = a.nonce;
        _verify(a, withdrawDigest(agent, to, amount, nonce, expiry), auth);
        if (amount > a.balance) revert InsufficientBalance();
        a.nonce = nonce + 1;
        a.balance -= amount;
        emit Withdrawn(agent, to, amount, nonce);
        IERC20(a.token).safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------- views

    function agents(address agent) external view returns (Agent memory) {
        return _agents[agent];
    }

    /// @notice Same as `agents`, named for clients that expect an explicit getter.
    function getAgent(address agent) external view returns (Agent memory) {
        return _agents[agent];
    }

    function releaseDigest(address agent, uint256 amount, uint64 nonce, uint64 expiry, bytes32 receiptsHash)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(RELEASE_TYPEHASH, agent, amount, nonce, expiry, receiptsHash)));
    }

    function dropDigest(address agent, uint64 nonce, uint64 expiry) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(DROP_TYPEHASH, agent, nonce, expiry)));
    }

    function undropDigest(address agent, uint64 nonce, uint64 expiry) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(UNDROP_TYPEHASH, agent, nonce, expiry)));
    }

    function withdrawDigest(address agent, address to, uint256 amount, uint64 nonce, uint64 expiry)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(WITHDRAW_TYPEHASH, agent, to, amount, nonce, expiry)));
    }

    // ---------------------------------------------------------------- internal

    function _known(address agent) private view returns (Agent storage a) {
        a = _agents[agent];
        if (a.token == address(0)) revert UnknownAgent();
    }

    function _notExpired(uint64 expiry) private view {
        if (block.timestamp > expiry) revert Expired();
    }

    function _verify(Agent storage a, bytes32 digest, WebAuthn.WebAuthnAuth calldata auth) private view {
        // the 4-arg overload requires UV, so a bare tap without Face ID or PIN is rejected
        if (!WebAuthn.verify(abi.encodePacked(digest), auth, a.qx, a.qy)) revert BadSignature();
    }

    function _pull(address token, uint256 amount) private returns (uint256 received) {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - before;
    }
}
