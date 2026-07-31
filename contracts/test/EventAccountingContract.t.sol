// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EventAccountingContract} from "../EventAccountingContract.sol";

/// @dev Minimal cheatcode surface so the test needs no forge-std dependency.
interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function prank(address) external;
    function expectRevert(bytes4) external;
}

/// Payloads below are verbatim mainnet/Gnosis calldata, captured from real
/// validator submitSignature transactions. If a bridge upgrade changes the
/// message layout, these tests are what will catch it.
contract EventAccountingContractTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address constant VALIDATOR = address(0xBEEF);
    address constant STRANGER = address(0xDEAD);

    bytes32 constant TOPIC_AFFIRMATION =
        0x0e96bea7c81f6ab9fdaadfef6cce8af0895e8afb435212ef17cabd1bc040b200;
    bytes32 constant TOPIC_SIGNATURE =
        0x7816cf218f07978e8469448a01a13c834fe09266b57c6c890b8a1decf9cc62ca;

    // gnosisscan tx 0x202b117ba3ad9e6e96217ee00de59e26a80d7acb46ef67f48ba7478ad108e12f
    // recipient(20) | value(32) | nonce(32) | foreignBridge(20) | token(20)
    bytes constant XDAI_MSG =
        hex"a130772609c7fa01b59bfd75ab56660c1a6ae14a0000000000000000000000000000000000000000000011b3f74a114c5b01624e00000000000000000000000000000000000000000000000000000000000013364aa42145aa6ebf72e164c9bbc74fbd37880450166b175474e89094c44da98b954eedeac495271d0f";
    bytes32 constant XDAI_NONCE =
        0x0000000000000000000000000000000000000000000000000000000000001336;

    // gnosisscan tx 0x9a3c244595d66823ce6fdeb07c33c644df787946069ee4aaef88729f56083da0
    bytes constant AMB_MSG =
        hex"00050000a7823d6f1e31569f51861e345b30c6bebf70ebe7000000000001e35df6a78083ca3e2a662d6dd1703c939c8ace2e268d88ad09518695c6c3712ac10a214be5109a655671000927c00101806401272255bb000000000000000000000000aa7a9ca87d3694b5755f213b5d04094b8d0f0a6f000000000000000000000000d3178cfa9bb26b46716dc50dd05d4a3c93062c8200000000000000000000000000000000000000000000005c283d410394100000";
    bytes32 constant AMB_MESSAGE_ID =
        0x00050000a7823d6f1e31569f51861e345b30c6bebf70ebe7000000000001e35d;

    bytes constant SIGNATURE =
        hex"b94bb95c83205b39bb40a810170116df1b3ba572303e3982f6bbc83bf4be26366ed0904b81db082914ad6f38195fd2e15c0c683430b8ce3b5c2ba89eaf6072b81c";

    EventAccountingContract k;

    function setUp() public {
        k = new EventAccountingContract(VALIDATOR);
    }

    function _lastEvent() internal returns (bytes32 topic0, uint8 bridge, bytes32 id) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1, "expected exactly one event");
        return (logs[0].topics[0], uint8(uint256(logs[0].topics[1])), logs[0].topics[2]);
    }

    function test_ambAffirmation_emitsMessageId() public {
        vm.recordLogs();
        vm.prank(VALIDATOR);
        k.executeAffirmation(AMB_MSG);

        (bytes32 topic0, uint8 bridge, bytes32 id) = _lastEvent();
        require(topic0 == TOPIC_AFFIRMATION, "wrong event");
        require(bridge == 0, "expected AMB");
        require(id == AMB_MESSAGE_ID, "wrong messageId");
    }

    function test_xdaiAffirmation_emitsNonce() public {
        vm.recordLogs();
        vm.prank(VALIDATOR);
        k.executeAffirmation(address(0xA11CE), 1 ether, XDAI_NONCE);

        (bytes32 topic0, uint8 bridge, bytes32 id) = _lastEvent();
        require(topic0 == TOPIC_AFFIRMATION, "wrong event");
        require(bridge == 1, "expected xDAI");
        require(id == XDAI_NONCE, "wrong nonce");
    }

    /// The 124-byte xDAI message and the variable-length AMB message share the
    /// submitSignature selector; only the shape tells them apart.
    function test_submitSignature_classifiesXdaiMessage() public {
        vm.recordLogs();
        vm.prank(VALIDATOR);
        k.submitSignature(SIGNATURE, XDAI_MSG);

        (bytes32 topic0, uint8 bridge, bytes32 id) = _lastEvent();
        require(topic0 == TOPIC_SIGNATURE, "wrong event");
        require(bridge == 1, "expected xDAI");
        require(id == XDAI_NONCE, "wrong nonce");
    }

    function test_submitSignature_classifiesAmbMessage() public {
        vm.recordLogs();
        vm.prank(VALIDATOR);
        k.submitSignature(SIGNATURE, AMB_MSG);

        (bytes32 topic0, uint8 bridge, bytes32 id) = _lastEvent();
        require(topic0 == TOPIC_SIGNATURE, "wrong event");
        require(bridge == 0, "expected AMB");
        require(id == AMB_MESSAGE_ID, "wrong messageId");
    }

    /// Pre-USDS xDAI messages had no token field. The nonce offset is unchanged.
    function test_submitSignature_classifiesLegacyXdaiMessage() public {
        bytes memory legacy = new bytes(104);
        bytes memory full = XDAI_MSG;
        for (uint256 i = 0; i < 104; i++) legacy[i] = full[i];

        vm.recordLogs();
        vm.prank(VALIDATOR);
        k.submitSignature(SIGNATURE, legacy);

        (, uint8 bridge, bytes32 id) = _lastEvent();
        require(bridge == 1, "expected xDAI");
        require(id == XDAI_NONCE, "wrong nonce");
    }

    /// An AMB message of exactly 124 bytes must not be mistaken for xDAI — the
    /// 0x0005 version prefix is the tiebreaker.
    function test_submitSignature_ambMessageOfXdaiLengthStaysAmb() public {
        bytes memory msg124 = new bytes(124);
        bytes memory full = AMB_MSG;
        for (uint256 i = 0; i < 124; i++) msg124[i] = full[i];

        vm.recordLogs();
        vm.prank(VALIDATOR);
        k.submitSignature(SIGNATURE, msg124);

        (, uint8 bridge, bytes32 id) = _lastEvent();
        require(bridge == 0, "expected AMB");
        require(id == AMB_MESSAGE_ID, "wrong messageId");
    }

    function test_rejectsNonValidator() public {
        vm.expectRevert(EventAccountingContract.NotBridgeValidator.selector);
        vm.prank(STRANGER);
        k.executeAffirmation(AMB_MSG);
    }

    function test_rejectsShortMessage() public {
        vm.expectRevert(EventAccountingContract.MessageTooShort.selector);
        vm.prank(VALIDATOR);
        k.executeAffirmation(hex"0005");
    }
}
