"""CLI entry point for botsec."""

import json
import os
import sys
from pathlib import Path

import click
from rich.console import Console
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from botsec import __version__
from botsec.config import AuditConfig
from botsec.agents.orchestrator import run_audit

console = Console()


BANNER = r"""
 ____        _   ____
| __ )  ___ | |_/ ___|  ___  ___
|  _ \ / _ \| __\___ \ / _ \/ __|
| |_) | (_) | |_ ___) |  __/ (__
|____/ \___/ \__|____/ \___|\___|
"""


def _severity_color(severity: str) -> str:
    return {
        "Critical": "bold red",
        "High": "red",
        "Medium": "yellow",
        "Low": "blue",
        "Informational": "dim",
    }.get(severity, "white")


def _print_findings(findings: list):
    """Pretty-print vulnerability findings."""
    if not findings:
        console.print("[green]No findings reported.[/green]")
        return

    table = Table(title="Findings", show_lines=True)
    table.add_column("ID", style="bold", width=10)
    table.add_column("Severity", width=14)
    table.add_column("Title", min_width=30)
    table.add_column("Category", width=20)
    table.add_column("Verified", width=10)

    for f in findings:
        severity = f.get("severity", "Unknown")
        table.add_row(
            f.get("id", "?"),
            Text(severity, style=_severity_color(severity)),
            f.get("title", "?"),
            f.get("category", "?"),
            f.get("formally_verified", "—"),
        )

    console.print(table)


def _on_event(agent: str, event_type: str, data: str):
    """Handle agent events for live output."""
    agent_colors = {
        "orchestrator": "bold white",
        "explorer": "cyan",
        "onchain": "magenta",
        "verifier": "green",
    }
    color = agent_colors.get(agent, "white")

    if event_type == "phase":
        console.print(f"\n[{color}]{'─' * 60}[/{color}]")
        console.print(f"[{color}]{data}[/{color}]")
        console.print(f"[{color}]{'─' * 60}[/{color}]")
    elif event_type == "phase_done":
        console.print(f"[{color}]  ✓ {data}[/{color}]")
    elif event_type == "phase_skip":
        console.print(f"[dim]  ⊘ {data}[/dim]")
    elif event_type == "agent_start":
        console.print(f"[{color}]  → {data}[/{color}]")
    elif event_type == "agent_done":
        console.print(f"[{color}]  ✓ {data}[/{color}]")
    elif event_type == "tool_call":
        console.print(f"[dim]    ⚙ {data}[/dim]")
    elif event_type == "turn":
        console.print(f"[dim]    {data}[/dim]")
    elif event_type == "done":
        console.print(f"\n[bold green]{'═' * 60}[/bold green]")
        console.print(f"[bold green]{data}[/bold green]")
        console.print(f"[bold green]{'═' * 60}[/bold green]")


@click.group()
@click.version_option(version=__version__)
def main():
    """BotSec — AI-powered smart contract vulnerability detection.

    Uses Claude Opus for deep analysis and Halmos for formal verification.
    """
    pass


@main.command()
@click.argument("target", type=click.Path(exists=True))
@click.option("--address", "-a", multiple=True, help="Contract address(es) for on-chain analysis")
@click.option("--chain", "-c", default="ethereum", help="Chain: ethereum, base, arbitrum")
@click.option(
    "--etherscan-key",
    envvar="ETHERSCAN_API_KEY",
    default="",
    help="Block explorer API key (or set ETHERSCAN_API_KEY)",
)
@click.option("--rpc-url", envvar="RPC_URL", default="", help="RPC URL (or set RPC_URL)")
@click.option("--skip-onchain", is_flag=True, help="Skip on-chain transaction analysis")
@click.option("--skip-verification", is_flag=True, help="Skip Halmos formal verification")
@click.option(
    "--output", "-o", default="botsec-output", type=click.Path(), help="Output directory"
)
@click.option("--max-attempts", default=5, help="Max verification retry attempts per property")
@click.option("--json-output", is_flag=True, help="Output raw JSON instead of formatted tables")
def audit(
    target,
    address,
    chain,
    etherscan_key,
    rpc_url,
    skip_onchain,
    skip_verification,
    output,
    max_attempts,
    json_output,
):
    """Run a full security audit on a smart contract project.

    TARGET is the path to a Foundry/Hardhat/Solidity project directory.

    \b
    Examples:
      botsec audit ./my-defi-project
      botsec audit ./contracts -a 0x1234...abcd --chain ethereum
      botsec audit ./src --skip-onchain --skip-verification
    """
    if not json_output:
        console.print(f"[bold cyan]{BANNER}[/bold cyan]")
        console.print(f"[bold]v{__version__}[/bold] — Smart Contract Security Audit\n")

    # Validate ANTHROPIC_API_KEY
    if not os.environ.get("ANTHROPIC_API_KEY"):
        console.print("[bold red]Error:[/bold red] ANTHROPIC_API_KEY environment variable not set.")
        console.print("Set it with: export ANTHROPIC_API_KEY=sk-ant-...")
        sys.exit(1)

    config = AuditConfig(
        target_path=Path(target).resolve(),
        contract_addresses=list(address),
        chain=chain,
        etherscan_api_key=etherscan_key,
        rpc_url=rpc_url,
        skip_onchain=skip_onchain,
        skip_verification=skip_verification,
        output_dir=Path(output),
        max_verification_attempts=max_attempts,
    )

    if not json_output:
        console.print(f"[bold]Target:[/bold]  {config.target_path}")
        if config.contract_addresses:
            console.print(f"[bold]Addresses:[/bold] {', '.join(config.contract_addresses)}")
        console.print(f"[bold]Chain:[/bold]   {config.chain}")
        console.print(f"[bold]Output:[/bold]  {config.output_dir.resolve()}\n")

    try:
        report = run_audit(
            config=config,
            on_event=_on_event if not json_output else None,
        )
    except Exception as e:
        console.print(f"\n[bold red]Audit failed:[/bold red] {e}")
        sys.exit(1)

    if json_output:
        click.echo(json.dumps(report, indent=2))
    else:
        # Print summary
        findings = report.get("findings", report.get("explorer_findings", []))
        _print_findings(findings)

        console.print(f"\n[bold]Full reports saved to:[/bold] {config.output_dir.resolve()}/")
        console.print("  - explorer_report.json")
        if not skip_onchain and config.contract_addresses:
            console.print("  - onchain_report.json")
        if not skip_verification:
            console.print("  - verifier_report.json")
        console.print("  - final_report.json")


@main.command()
@click.argument("target", type=click.Path(exists=True))
def scan(target):
    """Quick scan — runs only the explorer agent (no on-chain, no Halmos).

    Faster but less thorough than a full audit.
    """
    console.print(f"[bold cyan]{BANNER}[/bold cyan]")
    console.print(f"[bold]v{__version__}[/bold] — Quick Scan\n")

    if not os.environ.get("ANTHROPIC_API_KEY"):
        console.print("[bold red]Error:[/bold red] ANTHROPIC_API_KEY environment variable not set.")
        sys.exit(1)

    from botsec.agents.explorer import run_explorer_agent

    console.print(f"[bold]Target:[/bold] {Path(target).resolve()}\n")

    report = run_explorer_agent(
        target_path=str(Path(target).resolve()),
        on_event=lambda et, d: _on_event("explorer", et, d),
    )

    findings = report.get("findings", [])
    _print_findings(findings)

    # Save report
    out = Path("botsec-output")
    out.mkdir(exist_ok=True)
    (out / "scan_report.json").write_text(json.dumps(report, indent=2))
    console.print(f"\n[bold]Report saved to:[/bold] {out.resolve()}/scan_report.json")


if __name__ == "__main__":
    main()
