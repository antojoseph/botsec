"""On-chain analysis agent — analyzes deployed contract transactions."""

import json

import anthropic

from botsec.config import MAX_AGENT_TURNS, MAX_TOKENS, MODEL, AuditConfig
from botsec.prompts.onchain import ONCHAIN_SYSTEM_PROMPT
from botsec.tools.filesystem import READ_FILE_TOOL, read_file
from botsec.tools.onchain import (
    DECODE_CALLDATA_TOOL,
    FETCH_CONTRACT_SOURCE_TOOL,
    FETCH_EVENT_LOGS_TOOL,
    FETCH_INTERNAL_TXS_TOOL,
    FETCH_TRANSACTIONS_TOOL,
    decode_calldata,
    fetch_contract_source,
    fetch_event_logs,
    fetch_internal_transactions,
    fetch_transactions,
)


TOOLS = [
    FETCH_CONTRACT_SOURCE_TOOL,
    FETCH_TRANSACTIONS_TOOL,
    FETCH_INTERNAL_TXS_TOOL,
    DECODE_CALLDATA_TOOL,
    FETCH_EVENT_LOGS_TOOL,
    READ_FILE_TOOL,
]


def _make_dispatch(config: AuditConfig) -> dict:
    """Create tool dispatch table with config bound in."""
    return {
        "fetch_contract_source": lambda inp: fetch_contract_source(
            inp["address"], config.etherscan_api_key, inp.get("chain", config.chain)
        ),
        "fetch_transactions": lambda inp: fetch_transactions(
            inp["address"],
            config.etherscan_api_key,
            inp.get("chain", config.chain),
            count=inp.get("count", 50),
        ),
        "fetch_internal_transactions": lambda inp: fetch_internal_transactions(
            inp["address"],
            config.etherscan_api_key,
            inp.get("chain", config.chain),
            count=inp.get("count", 50),
        ),
        "decode_calldata": lambda inp: decode_calldata("", inp["calldata"]),
        "fetch_event_logs": lambda inp: fetch_event_logs(
            inp["address"],
            config.etherscan_api_key,
            inp.get("chain", config.chain),
            topic0=inp.get("topic0", ""),
            count=inp.get("count", 100),
        ),
        "read_file": lambda inp: read_file(inp["path"]),
    }


def run_onchain_agent(
    config: AuditConfig,
    explorer_report: dict,
    client: anthropic.Anthropic | None = None,
    on_event: callable = None,
) -> dict:
    """Run the on-chain analysis agent.

    Args:
        config: Audit configuration with chain, API keys, and addresses.
        explorer_report: Report from the explorer agent for cross-referencing.
        client: Anthropic client instance.
        on_event: Optional callback for streaming events.

    Returns:
        Parsed JSON report from the agent.
    """
    if client is None:
        client = anthropic.Anthropic()

    addresses_str = ", ".join(config.contract_addresses)
    explorer_summary = json.dumps(explorer_report, indent=2)[:10000]

    messages = [
        {
            "role": "user",
            "content": (
                f"Analyze on-chain transactions for these contract addresses on {config.chain}:\n"
                f"{addresses_str}\n\n"
                f"Here is the static analysis report from the explorer agent for context:\n"
                f"```json\n{explorer_summary}\n```\n\n"
                "Fetch transactions, internal transactions, and event logs. Decode calldata. "
                "Build a complete picture of how these contracts are used on-chain. "
                "Identify any suspicious patterns.\n\n"
                "Output your final JSON report inside <report> tags."
            ),
        }
    ]

    dispatch = _make_dispatch(config)

    def _emit(event_type: str, data: str = ""):
        if on_event:
            on_event(event_type, data)

    _emit("agent_start", "On-chain agent starting transaction analysis...")

    for turn in range(MAX_AGENT_TURNS):
        _emit("turn", f"Turn {turn + 1}")

        response = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=ONCHAIN_SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        )

        assistant_content = response.content
        messages.append({"role": "assistant", "content": assistant_content})

        if response.stop_reason == "end_turn":
            _emit("agent_done", "On-chain agent completed analysis.")
            break

        tool_results = []
        for block in assistant_content:
            if block.type == "tool_use":
                _emit("tool_call", f"{block.name}({json.dumps(block.input)[:200]}...)")
                handler = dispatch.get(block.name)
                if handler:
                    result = handler(block.input)
                else:
                    result = f"Unknown tool: {block.name}"
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result[:50000],
                })

        if tool_results:
            messages.append({"role": "user", "content": tool_results})
        else:
            break

    return _extract_report(messages)


def _extract_report(messages: list) -> dict:
    """Extract the JSON report from agent messages."""
    import re

    for msg in reversed(messages):
        if msg["role"] != "assistant":
            continue
        content = msg["content"]
        if isinstance(content, list):
            for block in content:
                text = getattr(block, "text", None) or (
                    block.get("text") if isinstance(block, dict) else None
                )
                if text:
                    match = re.search(r"<report>(.*?)</report>", text, re.DOTALL)
                    if match:
                        try:
                            return json.loads(match.group(1).strip())
                        except json.JSONDecodeError:
                            pass
    return {"error": "Could not extract on-chain report"}
