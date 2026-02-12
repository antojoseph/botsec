"""On-chain data fetching tools for transaction and contract analysis."""

import json
import subprocess

import httpx

from botsec.config import EXPLORER_APIS


def _get_explorer_url(chain: str) -> str:
    return EXPLORER_APIS.get(chain, EXPLORER_APIS["ethereum"])


def fetch_contract_source(
    address: str, api_key: str, chain: str = "ethereum"
) -> str:
    """Fetch verified source code from a block explorer."""
    base_url = _get_explorer_url(chain)
    params = {
        "module": "contract",
        "action": "getsourcecode",
        "address": address,
        "apikey": api_key,
    }
    try:
        resp = httpx.get(base_url, params=params, timeout=30)
        data = resp.json()
        if data.get("status") != "1":
            return f"Error: {data.get('message', 'Unknown error')} - {data.get('result', '')}"
        result = data["result"][0]
        source = result.get("SourceCode", "")
        name = result.get("ContractName", "Unknown")
        abi = result.get("ABI", "[]")
        # Handle nested JSON source format
        if source.startswith("{{"):
            source = source[1:-1]  # strip outer braces
        return json.dumps(
            {"contract_name": name, "source_code": source, "abi": abi},
            indent=2,
        )
    except Exception as e:
        return f"Error fetching source: {e}"


def fetch_transactions(
    address: str,
    api_key: str,
    chain: str = "ethereum",
    page: int = 1,
    count: int = 50,
) -> str:
    """Fetch recent transactions for a contract address."""
    base_url = _get_explorer_url(chain)
    params = {
        "module": "account",
        "action": "txlist",
        "address": address,
        "startblock": 0,
        "endblock": 99999999,
        "page": page,
        "offset": count,
        "sort": "desc",
        "apikey": api_key,
    }
    try:
        resp = httpx.get(base_url, params=params, timeout=30)
        data = resp.json()
        if data.get("status") != "1":
            return f"Error: {data.get('message', 'Unknown error')}"
        txs = data["result"]
        # Summarize transactions
        summaries = []
        for tx in txs:
            summaries.append({
                "hash": tx.get("hash"),
                "from": tx.get("from"),
                "to": tx.get("to"),
                "value_wei": tx.get("value"),
                "method_id": tx.get("input", "")[:10] if tx.get("input") else "",
                "is_error": tx.get("isError"),
                "gas_used": tx.get("gasUsed"),
                "block": tx.get("blockNumber"),
            })
        return json.dumps(summaries, indent=2)
    except Exception as e:
        return f"Error fetching transactions: {e}"


def fetch_internal_transactions(
    address: str,
    api_key: str,
    chain: str = "ethereum",
    count: int = 50,
) -> str:
    """Fetch internal (trace) transactions for deeper call analysis."""
    base_url = _get_explorer_url(chain)
    params = {
        "module": "account",
        "action": "txlistinternal",
        "address": address,
        "startblock": 0,
        "endblock": 99999999,
        "page": 1,
        "offset": count,
        "sort": "desc",
        "apikey": api_key,
    }
    try:
        resp = httpx.get(base_url, params=params, timeout=30)
        data = resp.json()
        if data.get("status") != "1":
            return f"Error: {data.get('message', 'Unknown error')}"
        return json.dumps(data["result"][:count], indent=2)
    except Exception as e:
        return f"Error fetching internal txs: {e}"


def decode_calldata(abi_json: str, calldata: str) -> str:
    """Decode transaction calldata using cast (from foundry)."""
    try:
        # Use cast to decode — requires foundry installed
        result = subprocess.run(
            ["cast", "4byte-decode", calldata],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode == 0:
            return result.stdout.strip()
        return f"Could not decode calldata: {result.stderr.strip()}"
    except FileNotFoundError:
        return "Error: `cast` (foundry) not installed. Install via `curl -L https://foundry.paradigm.xyz | bash`"
    except Exception as e:
        return f"Error decoding: {e}"


def fetch_event_logs(
    address: str,
    api_key: str,
    chain: str = "ethereum",
    topic0: str = "",
    count: int = 100,
) -> str:
    """Fetch event logs for a contract, optionally filtered by topic."""
    base_url = _get_explorer_url(chain)
    params: dict = {
        "module": "logs",
        "action": "getLogs",
        "address": address,
        "fromBlock": 0,
        "toBlock": "latest",
        "page": 1,
        "offset": count,
        "apikey": api_key,
    }
    if topic0:
        params["topic0"] = topic0
    try:
        resp = httpx.get(base_url, params=params, timeout=30)
        data = resp.json()
        if data.get("status") != "1":
            return f"Error: {data.get('message', 'Unknown error')}"
        return json.dumps(data["result"][:count], indent=2)
    except Exception as e:
        return f"Error fetching logs: {e}"


# Tool definitions for Claude API
FETCH_CONTRACT_SOURCE_TOOL = {
    "name": "fetch_contract_source",
    "description": (
        "Fetch the verified source code and ABI of a deployed contract from a block explorer "
        "(Etherscan, Basescan, Arbiscan). Returns contract name, source code, and ABI."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "address": {"type": "string", "description": "Contract address (0x...)"},
            "chain": {
                "type": "string",
                "description": "Chain name: ethereum, base, or arbitrum",
                "default": "ethereum",
            },
        },
        "required": ["address"],
    },
}

FETCH_TRANSACTIONS_TOOL = {
    "name": "fetch_transactions",
    "description": (
        "Fetch recent external transactions for a contract address. Returns tx hashes, "
        "method IDs, values, sender/receiver, and error status. Useful for understanding "
        "how a contract is being used in production."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "address": {"type": "string", "description": "Contract address (0x...)"},
            "chain": {
                "type": "string",
                "description": "Chain name: ethereum, base, or arbitrum",
                "default": "ethereum",
            },
            "count": {
                "type": "integer",
                "description": "Number of transactions to fetch (default 50)",
                "default": 50,
            },
        },
        "required": ["address"],
    },
}

FETCH_INTERNAL_TXS_TOOL = {
    "name": "fetch_internal_transactions",
    "description": (
        "Fetch internal (trace-level) transactions. Shows contract-to-contract calls, "
        "delegate calls, and value transfers that happen within a transaction. "
        "Critical for understanding cross-contract interactions."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "address": {"type": "string", "description": "Contract address (0x...)"},
            "chain": {
                "type": "string",
                "description": "Chain name: ethereum, base, or arbitrum",
                "default": "ethereum",
            },
            "count": {
                "type": "integer",
                "description": "Number of internal txs to fetch",
                "default": 50,
            },
        },
        "required": ["address"],
    },
}

DECODE_CALLDATA_TOOL = {
    "name": "decode_calldata",
    "description": (
        "Decode raw transaction calldata into human-readable function calls using "
        "foundry's `cast`. Helps understand what functions are being called."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "calldata": {
                "type": "string",
                "description": "Raw calldata hex string (0x...)",
            },
        },
        "required": ["calldata"],
    },
}

FETCH_EVENT_LOGS_TOOL = {
    "name": "fetch_event_logs",
    "description": (
        "Fetch emitted event logs for a contract. Optionally filter by topic0 (event signature hash). "
        "Useful for understanding state transitions and key actions."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "address": {"type": "string", "description": "Contract address (0x...)"},
            "chain": {
                "type": "string",
                "description": "Chain name: ethereum, base, or arbitrum",
                "default": "ethereum",
            },
            "topic0": {
                "type": "string",
                "description": "Event signature keccak hash to filter by (optional)",
                "default": "",
            },
            "count": {
                "type": "integer",
                "description": "Max number of logs to return",
                "default": 100,
            },
        },
        "required": ["address"],
    },
}
