"""Orchestrator — coordinates the three sub-agents and merges findings."""

import json
from pathlib import Path

import anthropic

from botsec.config import AuditConfig, MODEL, MAX_TOKENS
from botsec.agents.explorer import run_explorer_agent
from botsec.agents.onchain import run_onchain_agent
from botsec.agents.verifier import run_verifier_agent


def run_audit(config: AuditConfig, on_event: callable = None) -> dict:
    """Run a full smart contract audit pipeline.

    Pipeline:
    1. Explorer agent: deep static analysis of source code
    2. On-chain agent: transaction analysis (if addresses provided)
    3. Verifier agent: formal verification with Halmos

    Args:
        config: Audit configuration.
        on_event: Callback for (agent_name, event_type, data) events.

    Returns:
        Combined audit report.
    """
    client = anthropic.Anthropic()

    def _emit(agent: str, event_type: str, data: str = ""):
        if on_event:
            on_event(agent, event_type, data)

    # Ensure output directory exists
    config.output_dir.mkdir(parents=True, exist_ok=True)

    # ── Phase 1: Static Analysis ──────────────────────────────────
    _emit("orchestrator", "phase", "Phase 1: Static Code Analysis")

    explorer_report = run_explorer_agent(
        target_path=str(config.target_path),
        client=client,
        on_event=lambda et, d: _emit("explorer", et, d),
    )

    # Save intermediate report
    _save_report(config.output_dir / "explorer_report.json", explorer_report)
    _emit("orchestrator", "phase_done", "Explorer analysis complete")

    # ── Phase 2: On-Chain Analysis (optional) ─────────────────────
    onchain_report = None
    if not config.skip_onchain and config.contract_addresses and config.etherscan_api_key:
        _emit("orchestrator", "phase", "Phase 2: On-Chain Transaction Analysis")

        onchain_report = run_onchain_agent(
            config=config,
            explorer_report=explorer_report,
            client=client,
            on_event=lambda et, d: _emit("onchain", et, d),
        )

        _save_report(config.output_dir / "onchain_report.json", onchain_report)
        _emit("orchestrator", "phase_done", "On-chain analysis complete")
    else:
        _emit("orchestrator", "phase_skip", "Skipping on-chain analysis (no addresses/key)")

    # ── Phase 3: Formal Verification ─────────────────────────────
    if not config.skip_verification:
        _emit("orchestrator", "phase", "Phase 3: Formal Verification with Halmos")

        verifier_report = run_verifier_agent(
            config=config,
            explorer_report=explorer_report,
            onchain_report=onchain_report,
            client=client,
            on_event=lambda et, d: _emit("verifier", et, d),
        )

        _save_report(config.output_dir / "verifier_report.json", verifier_report)
        _emit("orchestrator", "phase_done", "Formal verification complete")
    else:
        verifier_report = None
        _emit("orchestrator", "phase_skip", "Skipping formal verification")

    # ── Phase 4: Merge reports ────────────────────────────────────
    _emit("orchestrator", "phase", "Phase 4: Generating Final Report")

    final_report = _merge_reports(
        explorer_report, onchain_report, verifier_report, client
    )

    _save_report(config.output_dir / "final_report.json", final_report)
    _emit("orchestrator", "done", "Audit complete")

    return final_report


def _merge_reports(
    explorer_report: dict,
    onchain_report: dict | None,
    verifier_report: dict | None,
    client: anthropic.Anthropic,
) -> dict:
    """Use Claude to merge and deduplicate findings from all agents."""
    reports_text = f"## Explorer Report\n```json\n{json.dumps(explorer_report, indent=2)}\n```\n\n"
    if onchain_report:
        reports_text += (
            f"## On-Chain Report\n```json\n{json.dumps(onchain_report, indent=2)}\n```\n\n"
        )
    if verifier_report:
        reports_text += (
            f"## Verification Report\n```json\n{json.dumps(verifier_report, indent=2)}\n```\n\n"
        )

    response = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=(
            "You are a senior smart contract auditor merging findings from multiple analysis "
            "agents. Deduplicate findings, upgrade severity where formal verification confirmed "
            "a vulnerability, downgrade where verification proved a property holds. Produce a "
            "single consolidated report."
        ),
        messages=[
            {
                "role": "user",
                "content": (
                    f"Merge these audit reports into a single consolidated report:\n\n"
                    f"{reports_text}\n"
                    "Produce the final merged report as JSON inside <report> tags. Include:\n"
                    "- All unique findings with updated severity based on verification results\n"
                    "- A summary section\n"
                    "- Findings sorted by severity (Critical > High > Medium > Low > Info)\n"
                    "- For each finding, note if it was formally verified/disproved"
                ),
            }
        ],
    )

    # Extract report
    import re

    text = ""
    for block in response.content:
        if hasattr(block, "text"):
            text += block.text

    match = re.search(r"<report>(.*?)</report>", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Fall back to a simple merge
    return {
        "summary": "Merged audit report (auto-merge failed, showing raw results)",
        "explorer_findings": explorer_report.get("findings", []),
        "onchain_findings": onchain_report.get("suspicious_activity", []) if onchain_report else [],
        "verification_results": verifier_report if verifier_report else {},
    }


def _save_report(path: Path, report: dict):
    """Save a JSON report to disk."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
