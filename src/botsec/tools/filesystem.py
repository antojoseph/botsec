"""Filesystem tools for reading and searching smart contract source code."""

import os
import subprocess
from pathlib import Path


def read_file(path: str) -> str:
    """Read a file and return its contents."""
    p = Path(path)
    if not p.exists():
        return f"Error: File not found: {path}"
    if not p.is_file():
        return f"Error: Not a file: {path}"
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return f"Error reading file: {e}"


def list_directory(path: str, recursive: bool = False) -> str:
    """List files in a directory, optionally recursive."""
    p = Path(path)
    if not p.exists():
        return f"Error: Directory not found: {path}"
    if not p.is_dir():
        return f"Error: Not a directory: {path}"

    entries = []
    if recursive:
        for root, dirs, files in os.walk(p):
            # Skip common non-source dirs
            dirs[:] = [d for d in dirs if d not in {"node_modules", ".git", "cache", "out", "lib"}]
            rel = os.path.relpath(root, p)
            for f in sorted(files):
                entries.append(os.path.join(rel, f) if rel != "." else f)
    else:
        for entry in sorted(p.iterdir()):
            suffix = "/" if entry.is_dir() else ""
            entries.append(entry.name + suffix)

    return "\n".join(entries) if entries else "(empty directory)"


def search_in_files(path: str, pattern: str, glob_pattern: str = "*.sol") -> str:
    """Search for a pattern across files using grep."""
    try:
        result = subprocess.run(
            ["grep", "-rn", "--include", glob_pattern, pattern, path],
            capture_output=True,
            text=True,
            timeout=30,
        )
        output = result.stdout.strip()
        return output if output else f"No matches found for '{pattern}'"
    except subprocess.TimeoutExpired:
        return "Error: Search timed out"
    except FileNotFoundError:
        return "Error: grep not available"


def write_file(path: str, content: str) -> str:
    """Write content to a file, creating directories as needed."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        p.write_text(content, encoding="utf-8")
        return f"Successfully wrote {len(content)} bytes to {path}"
    except Exception as e:
        return f"Error writing file: {e}"


# Tool definitions for the Claude API
READ_FILE_TOOL = {
    "name": "read_file",
    "description": (
        "Read the contents of a file. Use this to examine smart contract source code, "
        "configuration files, test files, etc."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute or relative path to the file to read",
            }
        },
        "required": ["path"],
    },
}

LIST_DIR_TOOL = {
    "name": "list_directory",
    "description": (
        "List files and subdirectories. Use recursive=true to get a full tree. "
        "Skips node_modules, .git, cache, out, and lib directories."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Path to the directory to list",
            },
            "recursive": {
                "type": "boolean",
                "description": "If true, list all files recursively",
                "default": False,
            },
        },
        "required": ["path"],
    },
}

SEARCH_FILES_TOOL = {
    "name": "search_in_files",
    "description": (
        "Search for a text pattern across files. Returns matching lines with file paths "
        "and line numbers. Useful for finding function definitions, state variables, "
        "access control patterns, etc."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Directory to search in",
            },
            "pattern": {
                "type": "string",
                "description": "Text or regex pattern to search for",
            },
            "glob_pattern": {
                "type": "string",
                "description": "File glob pattern to filter (default: *.sol)",
                "default": "*.sol",
            },
        },
        "required": ["path", "pattern"],
    },
}

WRITE_FILE_TOOL = {
    "name": "write_file",
    "description": (
        "Write content to a file. Creates parent directories if needed. "
        "Use for writing test files, invariant specifications, etc."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Path to the file to write",
            },
            "content": {
                "type": "string",
                "description": "Content to write to the file",
            },
        },
        "required": ["path", "content"],
    },
}
