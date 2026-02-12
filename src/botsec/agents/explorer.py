"""Explorer agent — deep static analysis of smart contract source code."""

import json

import anthropic

from botsec.config import MAX_AGENT_TURNS, MAX_TOKENS, MODEL
from botsec.prompts.explorer import EXPLORER_SYSTEM_PROMPT
from botsec.tools.filesystem import (
    LIST_DIR_TOOL,
    READ_FILE_TOOL,
    SEARCH_FILES_TOOL,
    list_directory,
    read_file,
    search_in_files,
)


TOOLS = [READ_FILE_TOOL, LIST_DIR_TOOL, SEARCH_FILES_TOOL]

TOOL_DISPATCH = {
    "read_file": lambda inp: read_file(inp["path"]),
    "list_directory": lambda inp: list_directory(inp["path"], inp.get("recursive", False)),
    "search_in_files": lambda inp: search_in_files(
        inp["path"], inp["pattern"], inp.get("glob_pattern", "*.sol")
    ),
}


def run_explorer_agent(
    target_path: str,
    client: anthropic.Anthropic | None = None,
    on_event: callable = None,
) -> dict:
    """Run the explorer agent to analyze a codebase.

    Args:
        target_path: Path to the smart contract project to analyze.
        client: Anthropic client instance (created if not provided).
        on_event: Optional callback for streaming agent events.

    Returns:
        Parsed JSON report from the agent.
    """
    if client is None:
        client = anthropic.Anthropic()

    messages = [
        {
            "role": "user",
            "content": (
                f"Analyze the smart contract project at: {target_path}\n\n"
                "Start by listing the directory structure recursively, then read and analyze "
                "every Solidity source file. Produce a complete security analysis report in the "
                "JSON format specified in your instructions.\n\n"
                "When you are done with your analysis, output your final JSON report inside "
                "<report> tags like: <report>{...json...}</report>"
            ),
        }
    ]

    def _emit(event_type: str, data: str = ""):
        if on_event:
            on_event(event_type, data)

    _emit("agent_start", "Explorer agent starting codebase analysis...")

    for turn in range(MAX_AGENT_TURNS):
        _emit("turn", f"Turn {turn + 1}")

        response = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=EXPLORER_SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        )

        # Process response
        assistant_content = response.content
        messages.append({"role": "assistant", "content": assistant_content})

        # Check if we're done (no tool use)
        if response.stop_reason == "end_turn":
            _emit("agent_done", "Explorer agent completed analysis.")
            break

        # Process tool calls
        tool_results = []
        for block in assistant_content:
            if block.type == "tool_use":
                tool_name = block.name
                tool_input = block.input
                _emit("tool_call", f"{tool_name}({json.dumps(tool_input)[:200]}...)")

                handler = TOOL_DISPATCH.get(tool_name)
                if handler:
                    result = handler(tool_input)
                else:
                    result = f"Unknown tool: {tool_name}"

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result[:50000],  # Truncate very large outputs
                })

        if tool_results:
            messages.append({"role": "user", "content": tool_results})
        else:
            break

    # Extract the JSON report from the final message
    return _extract_report(messages)


def _extract_report(messages: list) -> dict:
    """Extract the JSON report from agent messages."""
    # Look backwards through messages for the report
    for msg in reversed(messages):
        if msg["role"] != "assistant":
            continue
        content = msg["content"]
        if isinstance(content, list):
            for block in content:
                if hasattr(block, "text"):
                    text = block.text
                elif isinstance(block, dict) and "text" in block:
                    text = block["text"]
                else:
                    continue
                report = _parse_report_from_text(text)
                if report:
                    return report
        elif isinstance(content, str):
            report = _parse_report_from_text(content)
            if report:
                return report
    return {"error": "Could not extract report from agent output"}


def _parse_report_from_text(text: str) -> dict | None:
    """Try to parse a JSON report from text, looking for <report> tags or raw JSON."""
    import re

    # Try <report> tags first
    match = re.search(r"<report>(.*?)</report>", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Try finding a JSON object
    # Look for the outermost { ... }
    brace_start = text.find("{")
    if brace_start == -1:
        return None

    depth = 0
    for i in range(brace_start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[brace_start : i + 1])
                except json.JSONDecodeError:
                    return None
    return None
