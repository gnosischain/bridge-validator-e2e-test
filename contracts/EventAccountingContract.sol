// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EventAccountingContract ("contract K")
/// @notice A shadow target for a bridge validator. It exposes the same
///         entrypoints the real Home bridges expose, but does nothing except
///         emit a receipt so an off-chain indexer can measure how long the
///         validator took to act on a source-chain event.
///
///         Deploy one instance per validator implementation (nodejs / rust) on
///         Gnosis Chain — all three validator calls happen on the Home side, so
///         a single contract per validator covers both bridges and both
///         directions:
///
///           ETH -> GC   UserRequestForAffirmation  =>  executeAffirmation(...)
///           GC  -> ETH  UserRequestForSignature    =>  submitSignature(...)
///
///         The contract is deliberately stateless: every metric is derived
///         off-chain by reconciling these events against the real bridges.
contract EventAccountingContract {
    uint8 internal constant BRIDGE_AMB = 0;
    uint8 internal constant BRIDGE_XDAI = 1;

    /// @dev xDAI bridge messages are a fixed-length packed struct. The USDS
    ///      upgrade appended the token address, so both lengths are accepted:
    ///        legacy  (104): recipient (20) | value (32) | nonce (32) | foreignBridge (20)
    ///        current (124): ... | foreignBridge (20) | token (20)
    ///      The nonce sits at offset 52 in both.
    uint256 internal constant XDAI_MESSAGE_LENGTH_LEGACY = 104;
    uint256 internal constant XDAI_MESSAGE_LENGTH = 124;
    uint256 internal constant XDAI_NONCE_OFFSET = 52;

    /// @dev AMB messages are variable length and begin with a 32-byte messageId
    ///      whose first two bytes are the AMB message version (currently 0x0005),
    ///      e.g. 0x000500004AC82B41BD819DD871590B510316F2385CB196FB000000000002F8DA
    bytes2 internal constant AMB_MESSAGE_VERSION = 0x0005;

    /// @notice The single validator allowed to call this instance.
    address public immutable bridgeValidator;

    /// @param bridge 0 = AMB, 1 = xDAI
    /// @param id     AMB messageId, or xDAI nonce
    event SignedForAffirmation(uint8 indexed bridge, bytes32 indexed id);
    event SignedForSignature(uint8 indexed bridge, bytes32 indexed id);

    error NotBridgeValidator();
    error MessageTooShort();

    constructor(address _bridgeValidator) {
        bridgeValidator = _bridgeValidator;
    }

    modifier onlyBridgeValidator() {
        if (msg.sender != bridgeValidator) revert NotBridgeValidator();
        _;
    }

    /// @notice AMB home side of an ETH -> GC transfer.
    function executeAffirmation(bytes calldata message) external onlyBridgeValidator {
        emit SignedForAffirmation(BRIDGE_AMB, _ambMessageId(message));
    }

    /// @notice xDAI home side of an ETH -> GC transfer.
    /// @dev Signature matches HomeBridgeErcToNative. `recipient` and `value` are
    ///      unused — the nonce alone identifies the source event.
    function executeAffirmation(address, uint256, bytes32 nonce) external onlyBridgeValidator {
        emit SignedForAffirmation(BRIDGE_XDAI, nonce);
    }

    /// @notice Both bridges, GC -> ETH direction. AMB and xDAI share this
    ///         selector, so the bridge is inferred from the message shape.
    function submitSignature(bytes calldata, bytes calldata message) external onlyBridgeValidator {
        if (_isXdaiMessage(message)) {
            emit SignedForSignature(
                BRIDGE_XDAI, bytes32(message[XDAI_NONCE_OFFSET:XDAI_NONCE_OFFSET + 32])
            );
        } else {
            emit SignedForSignature(BRIDGE_AMB, _ambMessageId(message));
        }
    }

    /// @dev The messageId is simply the first 32 bytes of the packed AMB
    ///      message — it is not ABI-encoded, so no decoding is involved.
    function _ambMessageId(bytes calldata message) internal pure returns (bytes32) {
        if (message.length < 32) revert MessageTooShort();
        return bytes32(message[0:32]);
    }

    /// @dev Length alone is near-conclusive; the version check rules out the
    ///      degenerate case of an AMB message of exactly the same length.
    function _isXdaiMessage(bytes calldata message) internal pure returns (bool) {
        uint256 len = message.length;
        if (len != XDAI_MESSAGE_LENGTH && len != XDAI_MESSAGE_LENGTH_LEGACY) return false;
        return bytes2(message[0:2]) != AMB_MESSAGE_VERSION;
    }
}
