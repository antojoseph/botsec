"""Foundry and Halmos tools for compilation, testing, and formal verification."""

import subprocess
from pathlib import Path


def run_forge_build(project_path: str) -> str:
    """Compile a Foundry project."""
    try:
        result = subprocess.run(
            ["forge", "build"],
            cwd=project_path,
            capture_output=True,
            text=True,
            timeout=120,
        )
        output = result.stdout + result.stderr
        return output.strip() if output.strip() else "Build completed (no output)"
    except FileNotFoundError:
        return "Error: `forge` not found. Install Foundry: `curl -L https://foundry.paradigm.xyz | bash`"
    except subprocess.TimeoutExpired:
        return "Error: Build timed out after 120s"
    except Exception as e:
        return f"Error: {e}"


def run_forge_test(project_path: str, match_test: str = "", verbosity: int = 2) -> str:
    """Run Foundry tests."""
    cmd = ["forge", "test", f"-{'v' * verbosity}"]
    if match_test:
        cmd.extend(["--match-test", match_test])
    try:
        result = subprocess.run(
            cmd,
            cwd=project_path,
            capture_output=True,
            text=True,
            timeout=300,
        )
        return (result.stdout + result.stderr).strip()
    except FileNotFoundError:
        return "Error: `forge` not found."
    except subprocess.TimeoutExpired:
        return "Error: Tests timed out after 300s"
    except Exception as e:
        return f"Error: {e}"


def run_halmos(
    project_path: str,
    match_contract: str = "",
    match_test: str = "",
    loop_bound: int = 3,
    solver_timeout: int = 60000,
) -> str:
    """Run Halmos symbolic execution for formal verification."""
    cmd = [
        "halmos",
        "--loop", str(loop_bound),
        "--solver-timeout-assertion", str(solver_timeout),
    ]
    if match_contract:
        cmd.extend(["--contract", match_contract])
    if match_test:
        cmd.extend(["--function", match_test])
    try:
        result = subprocess.run(
            cmd,
            cwd=project_path,
            capture_output=True,
            text=True,
            timeout=600,
        )
        return (result.stdout + result.stderr).strip()
    except FileNotFoundError:
        return "Error: `halmos` not found. Install: `pip install halmos`"
    except subprocess.TimeoutExpired:
        return "Error: Halmos timed out after 600s"
    except Exception as e:
        return f"Error: {e}"


def run_shell_command(command: str, cwd: str) -> str:
    """Run an arbitrary shell command in the project directory.

    Useful for installing dependencies, running slither, etc.
    """
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=120,
        )
        output = (result.stdout + result.stderr).strip()
        return output if output else "(no output)"
    except subprocess.TimeoutExpired:
        return "Error: Command timed out"
    except Exception as e:
        return f"Error: {e}"


# Tool definitions for Claude API
FORGE_BUILD_TOOL = {
    "name": "forge_build",
    "description": "Compile a Foundry/Solidity project using `forge build`. Returns compiler output and any errors.",
    "input_schema": {
        "type": "object",
        "properties": {
            "project_path": {
                "type": "string",
                "description": "Path to the Foundry project root (containing foundry.toml)",
            }
        },
        "required": ["project_path"],
    },
}

FORGE_TEST_TOOL = {
    "name": "forge_test",
    "description": (
        "Run Foundry tests using `forge test`. Can match specific test functions. "
        "Returns test results with pass/fail and gas usage."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "project_path": {
                "type": "string",
                "description": "Path to the Foundry project root",
            },
            "match_test": {
                "type": "string",
                "description": "Regex pattern to match test function names (optional)",
                "default": "",
            },
            "verbosity": {
                "type": "integer",
                "description": "Verbosity level 1-5 (default 2)",
                "default": 2,
            },
        },
        "required": ["project_path"],
    },
}

HALMOS_TOOL = {
    "name": "run_halmos",
    "description": (
        "Run Halmos symbolic execution engine for formal verification of Solidity contracts. "
        "Halmos checks that test functions prefixed with `check_` hold for ALL possible inputs. "
        "If a counterexample is found, the property is violated. Use loop_bound to control "
        "loop unrolling depth. Returns verification results or counterexamples."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "project_path": {
                "type": "string",
                "description": "Path to the Foundry project root",
            },
            "match_contract": {
                "type": "string",
                "description": "Contract name to verify (optional)",
                "default": "",
            },
            "match_test": {
                "type": "string",
                "description": "Function name pattern to verify (optional)",
                "default": "",
            },
            "loop_bound": {
                "type": "integer",
                "description": "Loop unrolling bound (default 3)",
                "default": 3,
            },
            "solver_timeout": {
                "type": "integer",
                "description": "SMT solver timeout in ms (default 60000)",
                "default": 60000,
            },
        },
        "required": ["project_path"],
    },
}

SHELL_COMMAND_TOOL = {
    "name": "run_shell_command",
    "description": (
        "Run a shell command in the project directory. Use for installing dependencies "
        "(forge install, npm install), running other analysis tools, etc."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "Shell command to run",
            },
            "cwd": {
                "type": "string",
                "description": "Working directory for the command",
            },
        },
        "required": ["command", "cwd"],
    },
}
