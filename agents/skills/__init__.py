"""Skill system for token-efficient agent orchestration.

Skills are lightweight intent profiles that:
- provide a minimal tool spec subset for LLM decision
- optionally provide additional decision hints
- optionally provide prompt-time compaction utilities

This package is intentionally small and dependency-free.
"""

from .router import select_skill  # noqa: F401
