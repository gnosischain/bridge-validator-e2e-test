// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only stand-in for the real bridges. Emits the exact four source
///         events the monitor indexes, so the indexer, the matching logic and
///         the latency thresholds can be exercised on a local chain.
///         Never deployed to mainnet.
contract BridgeEventEmitter {
    // Ethereum AMB
    event UserRequestForAffirmation(bytes32 indexed messageId, bytes encodedData);
    // Ethereum xDAI
    event UserRequestForAffirmation(address recipient, uint256 value, bytes32 nonce);
    // Gnosis Chain AMB
    event UserRequestForSignature(bytes32 indexed messageId, bytes encodedData);
    // Gnosis Chain xDAI
    event UserRequestForSignature(address recipient, uint256 value, bytes32 nonce, address token);

    function ambAffirmation(bytes32 messageId, bytes calldata encodedData) external {
        emit UserRequestForAffirmation(messageId, encodedData);
    }

    function xdaiAffirmation(address recipient, uint256 value, bytes32 nonce) external {
        emit UserRequestForAffirmation(recipient, value, nonce);
    }

    function ambSignature(bytes32 messageId, bytes calldata encodedData) external {
        emit UserRequestForSignature(messageId, encodedData);
    }

    function xdaiSignature(address recipient, uint256 value, bytes32 nonce, address token)
        external
    {
        emit UserRequestForSignature(recipient, value, nonce, token);
    }
}
