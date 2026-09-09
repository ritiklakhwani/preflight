# Uniswap developer feedback

Written during ETHOnline 2026 while building Preflight, a pre-signing risk check for AI
agents. Every behavioural signal in it reads Uniswap V3 pool state, so the V3 subgraph is
the primary data source for the whole project.

Everything below is measured, not recalled. Where a number appears it came from a query run
against the live gateway between 2026-09-08 and 2026-09-10.

| | |
|---|---|
| What we used | Uniswap V3 subgraphs on Ethereum, Arbitrum and Base, via The Graph gateway |
| What we did not use | The Uniswap SDK, the API, v4 hooks. Preflight is read-only |
| Chains | 1, 42161, 8453 |
| Where it lives | `packages/signals/src/graph.ts` and `packages/signals/src/behavioural.ts` |

---

## 1. What worked, and why it mattered

**The same subgraph code on every chain is the reason this project supports three of them.**
One query string runs unchanged against Ethereum, Arbitrum and Base with only the deployment
id changing. Verified against USDC on each:

```
ETHEREUM  USDC  tvl $602,484,243   pools 20
ARBITRUM  USDC  tvl  $78,905,975   pools 20
BASE      USDC  tvl  $95,928,552   pools 20
```

Supporting a second and third chain cost a lookup table. If the schemas had drifted per
deployment it would have cost a second query layer, and we would have shipped one chain.

**V3 exposes enough per-pool state to reason about behaviour rather than code.**
`createdAtTimestamp`, `totalValueLockedUSD`, `volumeUSD`, `txCount` and `feeTier` together
support every signal we built. The single most useful pair turned out to be value locked
against transaction count, which separates real markets from fabricated ones better than
volume does.

---

## 2. Rough edges we hit

### 2.1 Several live subgraphs are labelled "Uniswap V3" and have incompatible schemas

Searching the Graph Explorer for Uniswap V3 on Base returns more than one indexed, healthy,
correctly-named subgraph. They do not share a schema.

| Subgraph id | Chain | Root field |
|---|---|---|
| `HMuAwufqZ1YCRmzL2SfHTVkzZovC9VL2UAKhjvRqKiR1` | Base | `pools`, the Uniswap schema |
| `FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS` | Base | `liquidityPools`, the Messari schema |
| `EgnS9YE1avupkvCNj9fHnJxppfEmNNywYJtghqiu2pd9` | Optimism | `liquidityPools`, the Messari schema |

Both are legitimate and useful. But a developer following a search result has no signal
about which family they have landed on until a query fails, and the failure is a GraphQL
field error rather than anything that says "wrong schema."

**Suggested fix:** the canonical per-chain deployment ids, in one table, in the Uniswap
docs. We ended up writing a script that introspects a subgraph and reports its schema
family before we would wire one in, which is a strange thing to need.

### 2.2 `token.poolCount` and `pool.liquidityProviderCount` return zero

Measured against USDC on Ethereum, which is in twenty pools that the same query returns in
the same response:

```
token.poolCount              "0"
pool.liquidityProviderCount  "0"   on every pool
```

Both look like exactly the field you want when assessing whether a token has a real market
or whether its liquidity is concentrated. Both would silently produce a wrong answer. We
lost time to the second one in particular, because holder and provider concentration is
genuinely what we needed and the field appeared to offer it.

**Suggested fix:** if these are not maintained, removing them from the schema would be
kinder than returning a plausible zero. Failing that, a note in the docs.

### 2.3 `whitelistPools` is the obvious fast path and is a trap

It reads like the intended way to get a token's pools. It is not usable for our case, for
two independent reasons.

It is only populated for tokens paired against a whitelisted asset, so it is empty for
exactly the newly-deployed tokens a risk tool cares about most.

And it is very slow on the busier chains. Timed against USDC on Base:

```
token { whitelistPools(first: 10, orderBy: totalValueLockedUSD) }   35.4s
pools(where: { token0: $addr }, first: 10, same ordering)            4.4s
pools(where: { token1: $addr }, first: 10, same ordering)            2.5s
```

The two directional lookups return a superset of `whitelistPools` and complete in an eighth
of the time.

**Suggested fix:** a note on the field saying it covers whitelisted pairs only. The
performance difference may be an indexer concern rather than a schema one, but a developer
reaching for the obvious field has no way to know they have chosen the expensive path.

### 2.4 `volumeUSD` is zero for pairs outside the whitelist

This one cost us a signal design. WBTC/USDC on Arbitrum:

```
totalValueLockedUSD  $18,670,643
volumeUSD                     $0
txCount                8,684,384
```

A pool with eight million transactions and no tracked volume. Our first version of the
liquidity signal used volume, and it would have flagged a real market as dead. Transaction
count is what separates a genuine pool from a fabricated one; volume cannot.

**Suggested fix:** the docs describe `volumeUSD` as lifetime volume without noting that
tracking is conditional on the pair. `untrackedVolumeUSD` exists and hints at this, but the
relationship is not spelled out anywhere we found.

### 2.5 Aliased selections in one document are billed serially

Combining the two directional pool lookups into one query with aliases produced a request
whose latency was the sum of both, not the maximum. On Base that pushed a 4.4s and a 2.5s
query into a single 13s request that exceeded our timeout. Splitting them into parallel HTTP
requests brought the same work back to 5.8s.

This is likely a gateway or indexer property rather than anything Uniswap controls, but it
is worth knowing when the docs show multi-entity queries as the idiomatic shape.

### 2.6 The legacy hosted endpoint returns a bare 301

```
POST https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3   ->  301, Cloudflare
```

No body, no pointer to the decentralised network deployment. Every third-party tutorial
still shows this URL. A developer following one gets a redirect to nothing and no
indication that the answer is a Graph API key and a subgraph id.

`https://docs.uniswap.org/api/subgraph/overview` also 301s to `developers.uniswap.org`,
which is fine but means older links land one hop away from the content.

**Suggested fix:** a stub response or a docs page at the old path saying where the data
moved.

---

## 3. What we would build next

**A canonical deployment manifest.** A single machine-readable file mapping chain id to the
official V3 subgraph deployment id, published by Uniswap rather than assembled from search
results. Our `packages/signals/src/graph.ts` contains a hand-built version of this, verified
by hand, which is the kind of thing that quietly rots.

**Holder or provider concentration that works.** Preflight ended up computing distribution
from Etherscan transfer history, because the subgraph fields that would have answered it
return zero. Unique addresses across a recent window separated real tokens from fabricated
ones cleanly in our tests, and it is the sort of thing a pool-level field could answer far
more cheaply.

---

## 4. Where to look in the repository

| What | Where |
|---|---|
| Chain-to-deployment mapping and the queries | `packages/signals/src/graph.ts` |
| The signals that read V3 pool state | `packages/signals/src/behavioural.ts` |
| How thresholds were calibrated against real pools | `docs/verifying-weights.md` |
| Labelled addresses and their verdicts | `test/benchmark/addresses.json` |
