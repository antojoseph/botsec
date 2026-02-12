"""Verifier agent — writes and runs Halmos formal verification tests."""

import json

import anthropic

from botsec.config import MAX_AGENT_TURNS, MAX_TOKENS, MODEL, AuditConfig
from botsec.prompts.verifier import VERIFIER_SYSTEM_PROMPT
from botsec.tools.filesystem import (
    LIST_DIR_TOOL,
    READ_FILE_TOOL,
    SEARCH_FILES_TOOL,
    WRITE_FILE_TOOL,
    list_directory,
    read_file,
    search_in_files,
    write_file,
)
from botsec.tools.foundry import (
    FORGE_BUILD_TOOL,
    FORGE_TEST_TOOL,
    HALMOS_TOOL,
    SHELL_COMMAND_TOOL,
    run_forge_build,
    run_forge_test,
    run_halmos,
    run_shell_command,
)


TOOLS = [
    READ_FILE_TOOL,
    LIST_DIR_TOOL,
    SEARCH_FILES_TOOL,
    WRITE_FILE_TOOL,
    FORGE_BUILD_TOOL,
    FORGE_TEST_TOOL,
    HALMOS_TOOL,
    SHELL_COMMAND_TOOL,
]

TOOL_DISPATCH = {
    "read_file": lambda inp: read_file(inp["path"]),
    "list_directory": lambda inp: list_directory(inp["path"], inp.get("recursive", False)),
    "search_in_files": lambda inp: search_in_files(
        inp["path"], inp["pattern"], inp.get("glob_pattern", "*.sol")
    ),
    "write_file": lambda inp: write_file(inp["path"], inp["content"]),
    "forge_build": lambda inp: run_forge_build(inp["project_path"]),
    "forge_test": lambda inp: run_forge_test(
        inp["project_path"], inp.get("match_test", ""), inp.get("verbosity", 2)
    ),
    "run_halmos": lambda inp: run_halmos(
        inp["project_path"],
        inp.get("match_contract", ""),
        inp.get("match_test", ""),
        inp.get("loop_bound", 3),
        inp.get("solver_timeout", 60000),
    ),
    "run_shell_command": lambda inp: run_shell_command(inp["command"], inp["cwd"]),
}


def run_verifier_agent(
    config: AuditConfig,
    explorer_report: dict,
    onchain_report: dict | None,
    client: anthropic.Anthropic | None = None,
    on_event: callable = None,
) -> dict:
    """Run the formal verification agent.

    Args:
        config: Audit configuration.
        explorer_report: Findings from the explorer agent.
        onchain_report: Findings from the on-chain agent (may be None if skipped).
        client: Anthropic client instance.
        on_event: Optional callback for streaming events.

    Returns:
        Parsed JSON verification report.
    """
    if client is None:
        client = anthropic.Anthropic()

    explorer_summary = json.dumps(explorer_report, indent=2)[:15000]
    onchain_summary = json.dumps(onchain_report, indent=2)[:10000] if onchain_report else "N/A"

    messages = [
        {
            "role": "user",
            "content": (
                f"You need to formally verify properties of the smart contract project at: "
                f"{config.target_path}\n\n"
                f"## Static Analysis Findings\n```json\n{explorer_summary}\n```\n\n"
                f"## On-Chain Analysis\n```json\n{onchain_summary}\n```\n\n"
                "## Your Task\n"
                "1. Read the source code to understand the contracts\n"
                "2. Based on the findings and invariants identified above, write Halmos "
                "verification test contracts\n"
                "3. Place test files in the `test/` directory of the project\n"
                "4. Run `forge build` to ensure compilation\n"
                "5. Run `halmos` to verify the properties\n"
                "6. If tests fail to compile or halmos finds issues with your test logic, "
                "fix and re-run (up to "
                f"{config.max_verification_attempts} attempts per property)\n"
                "7. Analyze counterexamples for real vulnerabilities\n\n"
                "Output your final JSON report inside <report> tags when done."
            ),
        }
    ]

    def _emit(event_type: str, data: str = ""):
        if on_event:
            on_event(event_type, data)

    _emit("agent_start", "Verifier agent starting formal verification...")

    for turn in range(MAX_AGENT_TURNS):
        _emit("turn", f"Turn {turn + 1}")

        response = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=VERIFIER_SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        )

        assistant_content = response.content
        messages.append({"role": "assistant", "content": assistant_content})

        if response.stop_reason == "end_turn":
            _emit("agent_done", "Verifier agent completed.")
            break

        tool_results = []
        for block in assistant_content:
            if block.type == "tool_use":
                _emit("tool_call", f"{block.name}({json.dumps(block.input)[:200]}...)")
                handler = TOOL_DISPATCH.get(block.name)
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
    return {"error": "Could not extract verification report"}
