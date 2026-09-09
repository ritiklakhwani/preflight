import { describe, expect, it } from 'vitest';
import { structural } from '../src/structural.js';
import type { SourceCodeResult } from '../src/etherscan.js';

const src = (SourceCode: string, ABI = '[]'): SourceCodeResult => ({
  SourceCode,
  ABI,
  ContractName: 'T',
  CompilerVersion: 'v0.8.0',
  Proxy: '0',
  Implementation: '',
});

describe('hasTransferRestrictions', () => {
  it('detects a pause modifier on the transfer path', () => {
    // WBTC. Its transfer is guarded by whenNotPaused and an owner can call
    // pause, freezing every holder at once. The blacklist-only pattern this
    // replaced stayed silent on it.
    const wbtc = `
      contract WBTC is Pausable {
        function transfer(address _to, uint256 _value) public whenNotPaused returns (bool) {
          return super.transfer(_to, _value);
        }
      }`;
    expect(structural(src(wbtc)).hasTransferRestrictions).toBe(true);
  });

  it('detects the OpenZeppelin ERC20Pausable hook', () => {
    const oz = `
      contract Token is ERC20Pausable {
        function _update(address from, address to, uint256 v) internal override whenNotPaused {
          super._update(from, to, v);
        }
      }`;
    expect(structural(src(oz)).hasTransferRestrictions).toBe(true);
  });

  it('detects an inline pause check rather than a modifier', () => {
    const inline = `
      function transfer(address to, uint v) public returns (bool) {
        require(!paused, "paused");
        return _transfer(msg.sender, to, v);
      }`;
    expect(structural(src(inline)).hasTransferRestrictions).toBe(true);
  });

  it('still detects per-address gating', () => {
    const usdt = `require(!isBlackListed[msg.sender], "blacklisted");`;
    expect(structural(src(usdt)).hasTransferRestrictions).toBe(true);
  });

  it('does not fire on a token that only pauses an admin function', () => {
    // Pausing minting does not stop a holder moving their balance, so this is
    // not a transfer restriction. Matching whenNotPaused anywhere in the file
    // would report it as one.
    const adminOnly = `
      function mint(address to, uint v) external onlyOwner whenNotPaused { _mint(to, v); }
      function transfer(address to, uint v) public returns (bool) { return _transfer(msg.sender, to, v); }`;
    expect(structural(src(adminOnly)).hasTransferRestrictions).toBe(false);
  });

  it('does not fire on an immutable token', () => {
    const weth = `function transfer(address dst, uint wad) public returns (bool) {
      return transferFrom(msg.sender, dst, wad); }`;
    expect(structural(src(weth)).hasTransferRestrictions).toBe(false);
  });
});

describe('ownerOnlyFunctions', () => {
  it('recognises any msg.sender equality gate, not just owner and admin', () => {
    // UNI gates mint on require(msg.sender == minter). Enumerating role names
    // missed it.
    const uni = `require(msg.sender == minter, "Uni::mint: only the minter can mint");`;
    const abi = JSON.stringify([{ type: 'function', name: 'mint', stateMutability: 'nonpayable' }]);
    expect(structural(src(uni, abi)).ownerOnlyFunctions).toContain('mint');
  });
});
