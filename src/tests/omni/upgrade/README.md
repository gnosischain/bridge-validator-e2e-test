# Omnibridge implementation upgrade — verification

Goal: prove that after both Omnibridge mediators are upgraded to the new implementations, all
normal bridging still works, and that the WETH grief fixed by this release is actually closed.

## What is being upgraded

| Side               | Proxy (EternalStorageProxy)                  | New implementation                                                                                                                        |
| ------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Foreign (Ethereum) | `0x88ad09518695c6c3712AC10a214bE5109a655671` | [`0x00e7097e9c1ce7121fc466ff31a7c742d5a26ea2`](https://eth.blockscout.com/address/0x00e7097e9c1ce7121fc466ff31a7c742d5a26ea2) — version 7 |
| Home (Gnosis)      | `0xf6A78083ca3e2a662D6dd1703c939c8aCE2e268d` | [`0x992685a4117a5c217f3a0e33f735565ad132b12a`](https://gnosisscan.io/address/0x992685a4117a5c217f3a0e33f735565ad132b12a) — version 9      |

Both implementations are already deployed on the real chains, so the Tenderly forks inherit them —
nothing is compiled or deployed here, the scripts only flip the proxies.

## The bug this release fixes

A claim routed through `WETHOmnibridgeRouter` hands the WETH to the router and relies on the
router's `onTokenBridged` callback to unwrap it and forward native ETH to the real recipient.
Pre-fix, `BasicOmnibridge` made that callback with a bare `.call` and ignored the result, so a
relayer who forwarded just enough gas for the mediator but not for the callback left the WETH
stranded in the router with the message burnt as relayed — unrecoverable, because
`requestFailedMessageFix` needs `!messageCallStatus`.

## Running it

Both scripts talk to the forks directly and need **no validator container** — `setup.js` registers
`VALIDATOR_PRIVATE_KEY` on the Foreign AMB with `requiredSignatures = 1`, so the WETH test signs
the AMB messages itself.

```bash
npm run setup                        # fresh forks (or setup:profile:* + npm run mock)
npm run upgrade:omnibridge           # 1. flip both proxies
npm run test:omni:upgrade:weth-eth   # 2. WETH (GC) -> ETH, every ForeignAMB relay path
npm test                             # 3. Layer A — needs a validator stack up
```

Run the WETH test with **autoclaim off**. An autoclaiming validator races it for the same messages.

### 1. `upgradeOmnibridge.js`

Reads `upgradeabilityOwner()` off each proxy and sends `upgradeTo(version + 1, newImpl)` as that
owner through the Tenderly Admin RPC (both owners are multisigs; impersonation is the same trick
`setup.js` uses to register validators). It then asserts:

- the upgrade tx succeeded and the `Upgraded` event fired;
- `implementation()` is the new address and `version()` bumped by one;
- storage survived — `bridgeContract`, `mediatorContractOnOtherSide`, `owner`, and the four
  daily/per-tx limit getters read identically before and after.

Idempotent: a proxy already on the new implementation is skipped, so it is safe to re-run.

Override the targets with `NEW_FOREIGN_OMNIBRIDGE_IMPL` / `NEW_HOME_OMNIBRIDGE_IMPL`.

### 2. `wethToEthGasLimit.js`

Each case bridges WETH from Gnosis with `relayTokensAndCall(GC_WETH, WETHOmnibridgeRouter, amount,
recipient)`, which on Ethereum becomes `handleNativeTokensAndCall(WETH, router, amount, recipient)`
— the griefable message — and then claims it a different way into a **fresh** recipient, so the
delivered ETH is exactly the bridged amount.

| #   | Path                                               | Expected post-fix                                                                                           |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | `safeExecuteSignaturesWithGasLimit`, `_gas` = 110k | **reverts**, message stays replayable, nothing stranded                                                     |
| 1   | same message, `_gas` = 400k                        | delivers native ETH, router left empty                                                                      |
| 2   | `safeExecuteSignaturesWithAutoGasLimit`            | delivers native ETH                                                                                         |
| 3   | `executeSignatures`, bridge's own header gasLimit  | delivers native ETH                                                                                         |
| 4   | `executeSignatures`, starved header gasLimit       | recorded as a **failed** message — nothing released — and `requestFailedMessageFix` reopens the refund path |

Case 4 needs a header gasLimit no real relay produces, so it re-encodes a real message with a
nonce far above the live one and a starved `gasLimit` field, and signs that. The honest message
from the same relay is claimed afterwards, so nothing is left hanging.

#### The gas band

Measured on the fork for a **0.05 WETH** claim into a router whose WETH balance slot is zero
(pre-fix vs post-fix, same messages):

| `_gas` forwarded | Pre-fix                          | Post-fix   |
| ---------------- | -------------------------------- | ---------- |
| < 90,000         | revert (mediator itself OOGs)    | revert     |
| 90,000 – 130,000 | **GRIEF** — WETH stuck in router | **revert** |
| ≥ 140,000        | delivers                         | delivers   |

That band is state-dependent: if the router's WETH balance is already non-zero the claim saves
~15k gas and the whole band shifts down, which is why the preflight asserts the router starts
empty. `WETH_LOW_GAS` (110,000) sits in the middle of the band and `WETH_HIGH_GAS` (400,000)
comfortably above it; both are overridable, as are `WETH_TEST_AMOUNT` and
`WETH_GRIEF_HEADER_GAS`.

#### Fork quirk it works around

The Gnosis fork keeps issuing AMB nonces the real bridge has already used, and the Ethereum fork
inherits mainnet state — so a freshly minted `messageId` is usually already marked relayed on the
Ethereum side. Before each claim the script clears the AMB's `relayedMessages` and
`messageCallStatus` bool slots with `tenderly_setStorageAt` (`boolStorage` is slot 4, key
`keccak256(name || messageId)`), the same workaround `overrideRelayedMessagesIfNeeded` in
`src/utils/validator.js` uses for the xDAI bridge.
