"""Configuration and constants for botsec."""

from dataclasses import dataclass, field
from pathlib import Path

MODEL = "claude-opus-4-6"
MAX_TOKENS = 16384
MAX_AGENT_TURNS = 200

# Block explorer APIs
ETHERSCAN_API = "https://api.etherscan.io/api"
BASESCAN_API = "https://api.basescan.org/api"
ARBISCAN_API = "https://api.arbiscan.io/api"

EXPLORER_APIS = {
    "ethereum": ETHERSCAN_API,
    "base": BASESCAN_API,
    "arbitrum": ARBISCAN_API,
}


@dataclass
class AuditConfig:
    """Configuration for an audit run."""

    target_path: Path
    contract_addresses: list[str] = field(default_factory=list)
    chain: str = "ethereum"
    etherscan_api_key: str = ""
    rpc_url: str = ""
    skip_onchain: bool = False
    skip_verification: bool = False
    output_dir: Path = field(default_factory=lambda: Path("botsec-output"))
    max_verification_attempts: int = 5
